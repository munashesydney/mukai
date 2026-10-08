import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, copyFile, rename, stat, writeFile, readFile, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { ComputerStatus, QemuSetup } from '../../shared/computer';
import type { RuntimeOwner } from '../../shared/runtime';
import {
  Frames,
  encodeFrame,
  PROTOCOL_VERSION,
  GUEST_REVISION,
  type Computer,
  type ComputerMethod,
} from './protocol';
import { upgradeGuest } from './upgradeGuest';
import { qemuControl } from './qemuControl';
import type { DiagnosticService } from '../services/diagnosticService';
import {
  findQemuFirmware,
  qemuMachineArguments,
  qemuPlatform,
  type QemuBootConfig,
} from './qemuPlatform';

export interface QemuConfig extends QemuBootConfig {
  binary: string;
  image: string;
}
export function qemuConfig(): QemuConfig {
  let host: ReturnType<typeof qemuPlatform> | undefined;
  try {
    host = qemuPlatform();
  } catch {
    /* Local mode is still available on other hosts. */
  }
  return {
    binary: process.env.MUKAI_QEMU_BINARY || '',
    image: process.env.MUKAI_QEMU_IMAGE || '',
    accelerator: process.env.MUKAI_QEMU_ACCEL || host?.accelerator || 'tcg',
    architecture: host?.architecture,
    firmware: process.env.MUKAI_QEMU_FIRMWARE || undefined,
  };
}
export async function qemuSetup(config = qemuConfig()): Promise<QemuSetup> {
  try {
    const host = qemuPlatform();
    if (config.architecture && config.architecture !== host.architecture)
      return {
        available: false,
        reason:
          'The Linux VM image architecture does not match this computer. Run VM setup on this computer.',
      };
  } catch (error) {
    return { available: false, reason: (error as Error).message };
  }
  for (const [key, path] of [
    ['MUKAI_QEMU_BINARY', config.binary],
    ['MUKAI_QEMU_IMAGE', config.image],
  ]) {
    if (!isAbsolute(path))
      return {
        available: false,
        reason: `Set ${key} to an absolute file path. See docs/qemu-workspaces.md.`,
      };
    try {
      if (!(await stat(path)).isFile()) throw new Error();
    } catch {
      return { available: false, reason: `${key} is not an accessible file.` };
    }
  }
  if (!['whpx', 'hvf', 'kvm', 'tcg'].includes(config.accelerator))
    return { available: false, reason: 'Unsupported QEMU accelerator.' };
  if ((config.architecture || qemuPlatform().architecture) === 'arm64') {
    try {
      await findQemuFirmware(config.binary, config.firmware);
    } catch (error) {
      return { available: false, reason: (error as Error).message };
    }
  }
  return { available: true };
}
const optionPath = (value: string) => value.replace(/,/g, ',,');
export function qemuArguments(
  directory: string,
  port: number,
  config: QemuConfig,
  controlPort?: number,
  desktopPort?: number,
) {
  return [
    '-name',
    'Mukai workspace',
    ...qemuMachineArguments(config),
    '-m',
    '2048',
    '-smp',
    '2',
    '-display',
    'none',
    '-serial',
    'none',
    '-monitor',
    'stdio',
    '-drive',
    `file=${optionPath(join(directory, 'disk.qcow2'))},format=qcow2,if=virtio`,
    '-netdev',
    'user,id=net0' + (desktopPort ? `,hostfwd=tcp:127.0.0.1:${desktopPort}-:5901` : ''),
    '-device',
    'virtio-net-pci,netdev=net0',
    '-device',
    'virtio-serial-pci',
    '-chardev',
    `socket,id=mukai,host=127.0.0.1,port=${port},reconnect-ms=1000`,
    '-device',
    'virtserialport,chardev=mukai,name=com.mukai.agent',
    '-fw_cfg',
    `name=opt/com.mukai/token,file=${optionPath(join(directory, 'boot-token'))}`,
    ...(controlPort ? ['-qmp', `tcp:127.0.0.1:${controlPort}`] : []),
  ];
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}
type Launcher = (
  binary: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;
export class QemuComputer implements Computer {
  private state: ComputerStatus = { kind: 'qemu', state: 'stopped' };
  private child?: ChildProcessWithoutNullStreams;
  private socket?: Socket;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private pending = new Map<string, Pending>();
  private closeConnection?: () => void;
  private exited?: Promise<void>;
  private log = '';
  private bootController?: AbortController;
  private guestRevision = 1;
  private control?: Awaited<ReturnType<typeof qemuControl>>;
  private desktopPort?: number;
  private desktopPassword?: string;
  private maintenance?: { message: string; detail?: string };
  constructor(
    private directory: string,
    private config = qemuConfig(),
    private launch: Launcher = spawn,
    private guestBundleDir?: string,
    private diagnostics?: DiagnosticService,
  ) {}
  private report(event: string, message: string, error?: unknown) {
    const context = { workspaceId: basename(this.directory), phase: 'computer' as const };
    if (error) this.diagnostics?.record(event, error, context, 'error', message);
    else this.diagnostics?.info(event, message, context);
  }
  status(): ComputerStatus {
    return {
      ...this.state,
      ...(this.maintenance ? { state: 'starting', ...this.maintenance } : {}),
    };
  }
  desktopConnection() {
    if (
      this.state.state !== 'running' ||
      this.starting ||
      !this.desktopPort ||
      !this.desktopPassword
    )
      throw new Error('The workspace desktop is unavailable.');
    return { port: this.desktopPort, password: this.desktopPassword };
  }
  async start() {
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    if (this.state.state === 'running') return;
    // Failed transport is not failed startup. Never let startup cleanup kill an existing VM.
    if (this.child)
      throw new Error(
        'The VM is still running, but its guest bridge is disconnected. Wait for it to reconnect, or stop/start the workspace VM.',
      );
    this.bootController = new AbortController();
    this.starting = this.startGuest()
      .catch(async (error: unknown) => {
        const cancelled = this.bootController?.signal.aborted;
        if (!cancelled) this.report('computer.start_failed', 'VM startup failed.', error);
        await this.stop('startup failure');
        if (!cancelled)
          this.state = {
            kind: 'qemu',
            state: 'failed',
            error: error instanceof Error ? error.message : 'VM failed to start.',
          };
        throw error;
      })
      .finally(() => {
        this.starting = undefined;
        this.maintenance = undefined;
      });
    return this.starting;
  }
  private async startGuest() {
    const signal = this.bootController!.signal;
    await this.boot();
    if (this.guestBundleDir && this.guestRevision < GUEST_REVISION) {
      this.maintenance = {
        message: 'Preparing your Linux desktop. The first update may take several minutes.',
      };
      await upgradeGuest(this.guestBundleDir, this.exchange.bind(this), signal, (detail) => {
        this.maintenance = { message: 'Preparing your Linux desktop…', detail };
      });
      signal.throwIfAborted();
      await this.stopGuest(false);
      signal.throwIfAborted();
      await this.boot();
      if (this.guestRevision < GUEST_REVISION)
        throw new Error('Guest update did not activate. Restart the workspace VM to retry.');
    }
  }
  private async boot() {
    const signal = this.bootController!.signal;
    if (this.child) {
      // A broken bridge must not cause a second writer to open the VM disk.
      throw new Error('The VM process is still running. Stop it before starting again.');
    }
    this.state = { kind: 'qemu', state: 'starting' };
    const setup = await qemuSetup(this.config);
    signal.throwIfAborted();
    if (!setup.available) throw new Error(setup.reason);
    const bootConfig = { ...this.config };
    if ((bootConfig.architecture || qemuPlatform().architecture) === 'arm64')
      bootConfig.firmware = await findQemuFirmware(bootConfig.binary, bootConfig.firmware);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Do not launch a second writer against a disk owned by an orphaned QEMU.
    const pidFile = join(this.directory, 'runtime.pid');
    let previous: number | undefined;
    try {
      previous = Number(await readFile(pidFile, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (previous && Number.isInteger(previous) && previous > 0) {
      try {
        process.kill(previous, 0);
        throw new Error(
          'A previous VM process is still running. Close it before restarting this workspace.',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    const disk = join(this.directory, 'disk.qcow2');
    try {
      await stat(disk);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const temporary = disk + '.creating';
      await copyFile(this.config.image, temporary);
      await rename(temporary, disk);
    }
    const token = randomBytes(32).toString('hex');
    this.desktopPassword = Buffer.from(token, 'hex').toString('base64').slice(0, 8);
    this.diagnostics?.registerSecret(token);
    this.diagnostics?.registerSecret(this.desktopPassword);
    await writeFile(join(this.directory, 'boot-token'), token, { mode: 0o600 });
    signal.throwIfAborted();
    const server = createServer();
    const sockets = new Set<Socket>();
    this.closeConnection = () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      this.control?.close();
    };
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (signal.aborted) {
      this.closeConnection();
      signal.throwIfAborted();
    }
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Could not allocate the VM bridge.');
    this.control = await qemuControl((event, reason) => {
      this.report(
        'computer.qmp.' + event.toLowerCase(),
        `QEMU ${event}${reason ? ': ' + reason : ''}.`,
      );
    });
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const desktopAddress = reservation.address();
    if (!desktopAddress || typeof desktopAddress === 'string')
      throw new Error('Could not allocate desktop transport.');
    this.desktopPort = desktopAddress.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    signal.throwIfAborted();
    let ready!: () => void;
    let failed!: (error: Error) => void;
    const handshake = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    // Install rejection handling before spawn can fail.
    void handshake.catch(() => {});
    const abortBoot = () => failed(new Error('VM startup cancelled.'));
    signal.addEventListener('abort', abortBoot, { once: true });
    server.on('error', failed);
    server.on('connection', (socket) => {
      if (this.socket || sockets.size >= 4) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      const frames = new Frames();
      let authenticated = false;
      const timer = setTimeout(() => socket.destroy(), 125000);
      socket.on('data', (chunk) => {
        try {
          for (const raw of frames.push(chunk)) {
            if (!authenticated) {
              const hello = z
                .object({
                  hello: z.literal(PROTOCOL_VERSION),
                  token: z.string().length(64),
                  revision: z.number().int().positive().optional(),
                })
                .parse(raw);
              const given = Buffer.from(hello.token);
              if (!timingSafeEqual(given, Buffer.from(token)))
                throw new Error('VM identity mismatch.');
              authenticated = true;
              this.guestRevision = hello.revision ?? 1;
              clearTimeout(timer);
              this.socket = socket;
              socket.write(encodeFrame({ ready: PROTOCOL_VERSION }));
              if (this.state.state === 'failed' && this.child && !this.stopping)
                this.state = { kind: 'qemu', state: 'running' };
              this.report('computer.bridge_connected', 'Guest bridge authenticated.');
              ready();
              continue;
            }
            // A hello may already be queued before the guest receives ready.
            if (raw && typeof raw === 'object' && 'hello' in raw) continue;
            const message = z
              .object({
                id: z.string().uuid(),
                result: z.unknown().optional(),
                error: z.string().optional(),
              })
              .parse(raw);
            const pending = this.pending.get(message.id);
            if (!pending) continue;
            this.pending.delete(message.id);
            pending.cleanup();
            if (message.error) pending.reject(new Error(message.error));
            else pending.resolve(message.result);
          }
        } catch (error) {
          this.report(
            'computer.bridge_protocol_failed',
            'Guest bridge sent an invalid frame.',
            error,
          );
          socket.destroy();
        }
      });
      socket.on('error', (error) => {
        this.report('computer.bridge_error', 'Guest bridge socket failed.', error);
        socket.destroy();
      });
      socket.on('close', () => {
        clearTimeout(timer);
        sockets.delete(socket);
        if (this.socket !== socket) return;
        this.socket = undefined;
        const error = new Error(
          'VM connection closed. Wait for the guest bridge to reconnect, or use workspace Stop/Start if it does not recover.',
        );
        this.failPending(error);
        if (this.state.state !== 'stopped') {
          this.report(
            'computer.bridge_disconnected',
            'Guest bridge disconnected; VM process may still be running.',
            error,
          );
          this.state = { kind: 'qemu', state: 'failed', error: error.message };
        }
      });
    });
    this.log = '';
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|LANG|LC_ALL)$/i.test(key),
      ),
    );
    const child = this.launch(
      this.config.binary,
      qemuArguments(this.directory, address.port, bootConfig, this.control.port, this.desktopPort),
      { windowsHide: true, env },
    );
    this.child = child;
    this.report(
      'computer.started',
      `QEMU launched; pid=${child.pid ?? 'unavailable'}, accelerator=${this.config.accelerator}.`,
    );
    const append = (chunk: Buffer) => {
      this.log = (this.log + chunk.toString()).slice(-4000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.stdin.on('error', () => {});
    this.exited = new Promise<void>((resolve) => {
      child.once('error', (error) => {
        this.report('computer.process_error', 'QEMU process failed.', error);
        failed(error);
      });
      child.once('close', (code, exitSignal) => {
        const expected = this.state.state === 'stopped';
        const summary = `QEMU exited; pid=${child.pid ?? 'unavailable'}, code=${code}, signal=${exitSignal}, expected=${expected}.`;
        this.report(
          'computer.exited',
          summary,
          expected ? undefined : new Error(this.log || summary),
        );
        if (this.child === child) this.child = undefined;
        this.closeConnection?.();
        this.failPending(new Error('Workspace VM stopped.'));
        if (this.state.state !== 'stopped')
          this.state = { kind: 'qemu', state: 'failed', error: this.log || 'Workspace VM exited.' };
        failed(new Error(this.log || 'QEMU exited before the guest was ready.'));
        resolve();
      });
    });
    if (child.pid) await writeFile(pidFile, String(child.pid), { mode: 0o600 });
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        handshake,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  'Guest did not become ready within 120 seconds. Check the prepared image and guest service. ' +
                    this.log,
                ),
              ),
            120000,
          );
        }),
      ]);
      if (!this.child || !this.socket) throw new Error('VM stopped during startup.');
      this.state = { kind: 'qemu', state: 'running' };
      this.report('computer.ready', 'Workspace VM is ready.');
    } finally {
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener('abort', abortBoot);
    }
  }
  async request(method: ComputerMethod, input: unknown, owner: RuntimeOwner, signal: AbortSignal) {
    signal.throwIfAborted();
    // Boot is shared across callers; cancelling a caller must not tear down peers.
    let abortStart!: () => void;
    try {
      await Promise.race([
        this.start(),
        new Promise<never>((_, reject) => {
          abortStart = () => reject(signal.reason);
          if (signal.aborted) abortStart();
          else signal.addEventListener('abort', abortStart, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', abortStart);
    }
    signal.throwIfAborted();
    return this.exchange(method, input, owner, signal);
  }
  private async exchange(
    method: ComputerMethod,
    input: unknown,
    owner: RuntimeOwner,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (!this.socket || this.state.state !== 'running') throw new Error('VM is unavailable.');
    if (this.pending.size >= 32) throw new Error('Too many outstanding VM requests.');
    const id = randomUUID();
    const frame = encodeFrame({ id, method, input, owner });
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        cleanup();
        this.socket?.write(encodeFrame({ cancel: id }));
        reject(
          signal.reason instanceof Error ? signal.reason : new Error('Operation interrupted.'),
        );
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        this.socket?.write(encodeFrame({ cancel: id }));
        const error = new Error(
          'Guest request timed out. Inspect process status before retrying a command.',
        );
        this.diagnostics?.record('computer.request_timeout', error, {
          phase: 'computer',
          workspaceId: owner.workspaceId,
          botId: owner.botId,
          conversationId: owner.conversationId,
          tool: method,
        });
        const pid = this.child?.pid;
        void this.control?.status().then((status) => {
          this.report(
            'computer.timeout_status',
            `VM status after request timeout; pid=${pid ?? 'unavailable'}, qmp=${status ?? 'unresponsive or disconnected'}.`,
          );
        });
        reject(error);
      }, 45000);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal.addEventListener('abort', abort, { once: true });
      this.socket!.write(frame);
    });
  }
  private failPending(error: Error) {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
  stop(reason = 'workspace stop') {
    this.bootController?.abort();
    return this.stopGuest(true, reason);
  }
  private stopGuest(abortBoot = true, reason = 'guest update') {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (abortBoot) this.bootController?.abort();
      if (this.child)
        this.report(
          'computer.stop_requested',
          `Controller requested VM shutdown; reason=${reason}.`,
        );
      this.state = { kind: 'qemu', state: 'stopped' };
      this.failPending(new Error('Workspace VM stopped.'));
      const child = this.child;
      if (child) {
        if (!this.control?.powerdown()) child.stdin.write('\nsystem_powerdown\n');
        const timer = setTimeout(() => {
          this.report(
            'computer.force_stop',
            'VM did not exit within 15 seconds; terminating the process.',
          );
          child.kill();
        }, 15000);
        try {
          await this.exited;
        } finally {
          clearTimeout(timer);
        }
        await unlink(join(this.directory, 'runtime.pid')).catch(() => {});
      }
      this.closeConnection?.();
      this.closeConnection = undefined;
      this.socket = undefined;
      this.desktopPort = undefined;
      this.desktopPassword = undefined;
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
  async shutdown() {
    await this.stop('app shutdown');
    await this.starting?.catch(() => {});
    await this.stop('app shutdown');
  }
}
