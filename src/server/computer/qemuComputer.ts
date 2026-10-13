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
import { freemem, totalmem } from 'node:os';
import {
  DEFAULT_VM_RESOURCES,
  vmResourcesSchema,
  type VmResources,
  type ComputerStatus,
  type QemuSetup,
} from '../../shared/computer';
import type { RuntimeOwner } from '../../shared/runtime';
import {
  Frames,
  encodeFrame,
  PROTOCOL_VERSION,
  GUEST_REVISION,
  type Computer,
  type ComputerMethod,
  type ComputerHelper,
  helperRequest,
} from './protocol';
import { answerHelper } from './helpers';
import { upgradeGuest } from './upgradeGuest';
import { qemuControl } from './qemuControl';
import { guestHealthSchema, type GuestHealth } from './guestHealth';
import { ComputerLog } from './computerLog';
import { captureGuestCrash } from './crashCapture';
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
  resources?: VmResources;
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
    String(config.resources?.memoryMiB ?? DEFAULT_VM_RESOURCES.memoryMiB),
    '-smp',
    String(config.resources?.vcpus ?? DEFAULT_VM_RESOURCES.vcpus),
    '-display',
    'none',
    '-serial',
    'mon:stdio',
    '-monitor',
    'none',
    '-drive',
    `file=${optionPath(join(directory, 'disk.qcow2'))},format=qcow2,if=virtio`,
    '-netdev',
    'user,id=net0' + (desktopPort ? `,hostfwd=tcp:127.0.0.1:${desktopPort}-:5901` : ''),
    '-device',
    'virtio-net-pci,netdev=net0',
    // Linux publishes kernel layout information for usable crash dumps under KASLR.
    ...(config.architecture === 'arm64' ? [] : ['-device', 'vmcoreinfo']),
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

// A long heartbeat gap warrants immediate recovery. It can mean either host sleep
// or a stalled guest; the gap alone does not identify which happened.
const SUSPEND_GAP_MS = 120000;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
  helper?: ComputerHelper;
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
  private activeResources?: VmResources;
  private healthPending = new Map<string, Pending>();
  private lastHealth?: { sample: GuestHealth; receivedAt: number };
  private healthTimer?: NodeJS.Timeout;
  private checkingHealth = false;
  private missedHealth = 0;
  private lastRecoveryAt = 0;
  private lastHealthNoticeAt = 0;
  private reconnecting?: Promise<void>;
  private reconnectWaiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  private guestPanicked = false;
  private panicTail = '';
  private automaticRestarts: number[] = [];
  private recoveryExhausted = false;
  private crashCapture?: Promise<void>;
  private recoveryGeneration = 0;
  private healthLog: ComputerLog;
  private consoleLog: ComputerLog;
  constructor(
    private directory: string,
    private config = qemuConfig(),
    private launch: Launcher = spawn,
    private guestBundleDir?: string,
    private diagnostics?: DiagnosticService,
  ) {
    const failedLog = () => this.report('computer.log_failed', 'Could not persist VM diagnostics.');
    this.healthLog = new ComputerLog(join(directory, 'health.log'), undefined, failedLog);
    this.consoleLog = new ComputerLog(join(directory, 'console.log'), undefined, failedLog);
  }
  private report(event: string, message: string, error?: unknown) {
    const context = { workspaceId: basename(this.directory), phase: 'computer' as const };
    if (error) this.diagnostics?.record(event, error, context, 'error', message);
    else this.diagnostics?.info(event, message, context);
  }
  status(): ComputerStatus {
    const resources = this.config.resources || DEFAULT_VM_RESOURCES;
    return {
      ...this.state,
      resources: { ...resources },
      ...(this.activeResources ? { activeResources: { ...this.activeResources } } : {}),
      restartRequired: Boolean(
        this.activeResources &&
        (this.activeResources.memoryMiB !== resources.memoryMiB ||
          this.activeResources.vcpus !== resources.vcpus),
      ),
      ...(this.maintenance ? { state: 'starting', ...this.maintenance } : {}),
    };
  }
  configureResources(resources: VmResources) {
    this.config = { ...this.config, resources: vmResourcesSchema.parse(resources) };
  }
  desktopConnection() {
    if (
      !this.child ||
      this.guestPanicked ||
      !['running', 'failed'].includes(this.state.state) ||
      this.starting ||
      this.stopping ||
      !this.desktopPort ||
      !this.desktopPassword
    )
      throw new Error('The workspace desktop is unavailable.');
    return { port: this.desktopPort, password: this.desktopPassword };
  }
  /** Root bridge probe; does not execute a command or depend on the tools worker. */
  inspectHealth(signal: AbortSignal): Promise<GuestHealth> {
    signal.throwIfAborted();
    const socket = this.socket;
    if (!socket || this.state.state !== 'running' || this.guestRevision < 7)
      return Promise.reject(new Error('Guest health checks are unavailable.'));
    if (this.healthPending.size >= 4)
      return Promise.reject(new Error('Too many outstanding guest health checks.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error: Error) => {
        this.healthPending.delete(id);
        cleanup();
        reject(error);
      };
      const abort = () =>
        finish(
          signal.reason instanceof Error ? signal.reason : new Error('Health check cancelled.'),
        );
      const timer = setTimeout(() => finish(new Error('Guest health check timed out.')), 5000);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      this.healthPending.set(id, {
        resolve: (value) => resolve(value as GuestHealth),
        reject,
        cleanup,
      });
      signal.addEventListener('abort', abort, { once: true });
      socket.write(encodeFrame({ health: id }), (error) => {
        if (error && this.healthPending.has(id)) finish(error);
      });
    });
  }
  /** Reconnect only the transport. Never reboot, restart a worker, or replay a tool call. */
  recoverBridge(reason = 'manual health check', signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.reconnecting) return this.reconnecting;
    if (!this.child || this.starting || this.stopping)
      return Promise.reject(
        new Error('VM bridge recovery is unavailable during a lifecycle change.'),
      );
    if (this.pending.size)
      return Promise.reject(
        new Error('Wait for active VM operations before reconnecting the bridge.'),
      );
    if (this.guestRevision < 7)
      return Promise.reject(new Error('Update the guest before reconnecting its bridge.'));
    this.lastRecoveryAt = Date.now();
    this.report(
      'computer.bridge_recovery',
      'Reconnecting the guest bridge while keeping the VM running.',
    );
    const socket = this.socket;
    this.socket = undefined;
    this.state = { kind: 'qemu', state: 'failed', error: 'Reconnecting the guest bridge…' };
    this.failPending(new Error('Guest bridge reconnecting; operation completion is unknown.'));
    this.reconnecting = new Promise<void>((resolve, reject) => {
      const verification = new AbortController();
      let finished = false;
      let verifying = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        verification.abort();
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.reconnectWaiters.delete(waiter);
        if (error) reject(error);
        else resolve();
      };
      // A buffered hello can arrive while the guest's serial port is reopening.
      // Verify host-to-guest delivery before releasing tool callers. Only health
      // probes may be retried; uncertain tool actions are never replayed.
      const verify = async () => {
        if (verifying || finished) return;
        verifying = true;
        while (!finished) {
          try {
            await this.inspectHealth(verification.signal);
            finish();
            return;
          } catch (error) {
            if (finished) return;
            if (!this.child || this.stopping) {
              finish(error instanceof Error ? error : new Error('VM stopped during recovery.'));
              return;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
        }
      };
      const waiter = {
        resolve: () => {
          void verify();
        },
        reject: (error: Error) => finish(error),
      };
      const abort = () =>
        finish(
          signal?.reason instanceof Error ? signal.reason : new Error('Bridge recovery cancelled.'),
        );
      const timer = setTimeout(() => {
        const error = new Error('Guest bridge did not reconnect. The VM was left running.');
        this.report(
          'computer.bridge_recovery_failed',
          `Bridge reconnect failed; reason=${reason}.`,
          error,
        );
        finish(error);
      }, 10000);
      this.reconnectWaiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      socket?.destroy();
    }).finally(() => {
      this.reconnecting = undefined;
    });
    return this.reconnecting;
  }
  /**
   * Heal the guest bridge after the host computer resumed from sleep. A bridge that
   * survived the suspend answers a probe and is left untouched; otherwise the
   * transport is reconnected, and a VM that never answers is restarted.
   */
  async recoverAfterHostResume(reason = 'host resume') {
    if (!this.child || this.starting || this.stopping) return 'skipped' as const;
    try {
      // The guest may still be waking; a reply rules out any recovery.
      await this.inspectHealth(AbortSignal.timeout(6000));
      return 'skipped' as const;
    } catch {
      /* Unreachable: reconnect the transport below, then restart if it stays silent. */
    }
    return this.healStalledBridge(reason);
  }
  /**
   * Reconnect the transport first, then rebuild the VM process when the guest never
   * re-announces itself. `disk.qcow2` keeps the workspace files, but running guest
   * state is lost, so this is only reached once transport recovery has failed or
   * the serial console confirms that Linux panicked.
   */
  private async healStalledBridge(reason: string) {
    if (this.recoveryExhausted) return 'failed' as const;
    if (!this.child || this.starting || this.stopping || this.pending.size)
      return 'skipped' as const;
    if (!this.guestPanicked) {
      try {
        await this.recoverBridge(reason);
        return 'reconnected' as const;
      } catch {
        /* The guest stayed silent; fall through and rebuild the transport from scratch. */
      }
    }
    if (!this.child || this.starting || this.stopping || this.pending.size)
      return 'skipped' as const;
    this.automaticRestarts = this.automaticRestarts.filter((at) => Date.now() - at < 600000);
    if (this.automaticRestarts.length >= 3) {
      this.recoveryExhausted = true;
      const error =
        'Automatic VM recovery stopped after three restarts in ten minutes. Stop/start the workspace VM to retry.';
      this.state = { kind: 'qemu', state: 'failed', error };
      this.report('computer.recovery_exhausted', error);
      return 'failed' as const;
    }
    this.automaticRestarts.push(Date.now());
    const generation = this.recoveryGeneration;
    this.report(
      'computer.bridge_restart',
      `Restarting the workspace VM; ${this.guestPanicked ? 'Linux reported a kernel panic' : 'the guest bridge stayed unreachable after a reconnect'}; reason=${reason}.`,
    );
    try {
      await this.stop('bridge recovery restart');
      if (generation !== this.recoveryGeneration) return 'skipped' as const;
      await this.start();
      return 'restarted' as const;
    } catch (error) {
      this.report(
        'computer.bridge_restart_failed',
        'Could not restart the workspace VM after a failed bridge recovery.',
        error,
      );
      return 'failed' as const;
    }
  }
  private recordHealth(sample: GuestHealth) {
    const previous = this.lastHealth?.sample;
    // A buffered reply is evidence of its sample time, not a fresh heartbeat.
    if (previous && previous.bridgePid === sample.bridgePid) {
      if (previous.uptimeSeconds !== null && sample.uptimeSeconds !== null) {
        if (sample.uptimeSeconds <= previous.uptimeSeconds) return;
      } else if (Date.parse(sample.sampledAt) <= Date.parse(previous.sampledAt)) return;
    }
    const now = Date.now();
    this.lastHealth = { sample, receivedAt: now };
    this.missedHealth = 0;
    this.healthLog.append(
      JSON.stringify({
        receivedAt: new Date(now).toISOString(),
        workspaceId: basename(this.directory),
        qemuPid: this.child?.pid,
        resources: this.activeResources,
        hostMemory: {
          totalKiB: Math.round(totalmem() / 1024),
          freeKiB: Math.round(freemem() / 1024),
        },
        ...sample,
      }) + '\n',
    );
    const available = sample.memory.availableKiB;
    const total = sample.memory.totalKiB;
    const pressure =
      available !== null && total !== null && available < Math.max(65536, total * 0.05);
    const previousAvailable = previous?.memory.availableKiB;
    const previousTotal = previous?.memory.totalKiB;
    const enteredPressure =
      pressure &&
      !(
        previousAvailable != null &&
        previousTotal != null &&
        previousAvailable < Math.max(65536, previousTotal * 0.05)
      );
    const oom =
      previous?.oomKillCount !== null &&
      previous?.oomKillCount !== undefined &&
      sample.oomKillCount !== null &&
      sample.oomKillCount > previous.oomKillCount;
    if (oom || enteredPressure || now - this.lastHealthNoticeAt >= 60000) {
      this.lastHealthNoticeAt = now;
      const message = `Guest health; availableKiB=${available ?? 'unknown'}, swapFreeKiB=${sample.memory.swapFreeKiB ?? 'unknown'}, oomKills=${sample.oomKillCount ?? 'unknown'}, load=${sample.loadAverage?.join(',') ?? 'unknown'}, workerPid=${sample.workerPid ?? 'none'}, memoryPressure=${pressure}.`;
      if (pressure || oom)
        this.diagnostics?.record(
          oom ? 'computer.guest_oom' : 'computer.memory_pressure',
          new Error(message),
          { workspaceId: basename(this.directory), phase: 'computer' },
          'warn',
        );
      else this.report('computer.health', message);
    }
  }
  private startHealthMonitor() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.guestRevision < 7) return;
    this.healthTimer = setInterval(() => {
      if (
        this.checkingHealth ||
        !this.child ||
        this.stopping ||
        this.starting ||
        this.reconnecting ||
        this.recoveryExhausted ||
        !['running', 'failed'].includes(this.state.state) ||
        (this.state.state === 'running' &&
          !this.guestPanicked &&
          this.lastHealth &&
          Date.now() - this.lastHealth.receivedAt < 20000)
      )
        return;
      this.checkingHealth = true;
      const checkedChild = this.child;
      void this.inspectHealth(AbortSignal.timeout(6000))
        .catch(async () => {
          if (
            !this.child ||
            this.child !== checkedChild ||
            this.stopping ||
            !['running', 'failed'].includes(this.state.state)
          )
            return;
          this.missedHealth++;
          const age = this.lastHealth ? Date.now() - this.lastHealth.receivedAt : undefined;
          // A long gap can also be a dead guest, not only a suspended host.
          const suspended = Boolean(age !== undefined && age >= SUSPEND_GAP_MS);
          if (this.missedHealth < 3 && !suspended && !this.guestPanicked) return;
          this.report(
            'computer.health_unresponsive',
            `Guest heartbeat missing; lastSampleAgeMs=${age ?? 'unavailable'}, activeRequests=${this.pending.size}, suspended=${suspended}.`,
          );
          // A confirmed kernel panic cannot recover on its own. The restart cap still
          // prevents repeated crashes from creating an unbounded reboot loop.
          if (
            this.pending.size ||
            (!this.guestPanicked && Date.now() - this.lastRecoveryAt < 60000)
          )
            return;
          await this.healStalledBridge(
            this.guestPanicked
              ? 'guest kernel panic'
              : suspended
                ? 'long guest heartbeat gap'
                : 'missing guest heartbeat',
          );
        })
        .finally(() => {
          this.checkingHealth = false;
        });
    }, 10000);
    this.healthTimer.unref();
  }
  private async diagnoseTimeout() {
    const checkedChild = this.child;
    const pid = this.child?.pid;
    const status = await this.control?.status();
    this.report(
      'computer.timeout_status',
      `VM status after request timeout; pid=${pid ?? 'unavailable'}, qmp=${status ?? 'unresponsive or disconnected'}.`,
    );
    if (this.guestRevision < 7 || this.stopping || !this.child || this.child !== checkedChild)
      return;
    try {
      await this.inspectHealth(AbortSignal.timeout(6000));
      this.report(
        'computer.worker_unresponsive',
        'Root guest bridge responds; a tool or tools worker did not finish. The operation was not replayed.',
      );
    } catch {
      this.report(
        'computer.health_unresponsive',
        'Root guest bridge did not respond after a tool timeout.',
      );
      if (!this.pending.size && !this.reconnecting && Date.now() - this.lastRecoveryAt >= 60000)
        await this.recoverBridge('guest request timeout').catch(() => {});
    }
  }
  private disposed = false;
  async start() {
    if (this.disposed) throw new Error('Workspace VM was disposed.');
    if (this.stopping) await this.stopping;
    if (this.disposed) throw new Error('Workspace VM was disposed.');
    if (this.starting) return this.starting;
    if (this.state.state === 'running') return;
    // Failed transport is not failed startup. Never let startup cleanup kill an existing VM.
    if (this.child)
      throw new Error(
        this.state.state === 'failed' &&
          (this.guestPanicked || this.state.error?.startsWith('Automatic VM recovery stopped'))
          ? this.state.error
          : 'The VM is still running, but its guest bridge is disconnected. Automatic VM recovery is in progress; try again shortly, or stop/start the workspace VM.',
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
    this.guestPanicked = false;
    this.panicTail = '';
    this.crashCapture = undefined;
    this.lastHealth = undefined;
    this.missedHealth = 0;
    this.lastRecoveryAt = 0;
    this.lastHealthNoticeAt = 0;
    const setup = await qemuSetup(this.config);
    signal.throwIfAborted();
    if (!setup.available) throw new Error(setup.reason);
    const bootConfig = {
      ...this.config,
      resources: { ...(this.config.resources || DEFAULT_VM_RESOURCES) },
    };
    const bootTimeoutMs = bootConfig.accelerator === 'tcg' ? 10 * 60 * 1000 : 120000;
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
      const timer = setTimeout(() => socket.destroy(), bootTimeoutMs + 5000);
      socket.on('data', (chunk) => {
        if (this.guestPanicked) return;
        if (authenticated && this.socket !== socket) return;
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
              this.startHealthMonitor();
              for (const waiter of this.reconnectWaiters) waiter.resolve();
              ready();
              continue;
            }
            // A hello may already be queued before the guest receives ready.
            if (raw && typeof raw === 'object' && 'hello' in raw) {
              socket.write(encodeFrame({ ready: PROTOCOL_VERSION }));
              continue;
            }
            if (raw && typeof raw === 'object' && 'telemetry' in raw) {
              this.recordHealth(guestHealthSchema.parse(raw.telemetry));
              continue;
            }
            if (raw && typeof raw === 'object' && 'health' in raw) {
              const message = z
                .object({ health: z.string().uuid(), diagnostics: guestHealthSchema })
                .parse(raw);
              const pending = this.healthPending.get(message.health);
              if (pending) {
                this.recordHealth(message.diagnostics);
                this.healthPending.delete(message.health);
                pending.cleanup();
                pending.resolve(message.diagnostics);
              }
              continue;
            }
            const helper = helperRequest.safeParse(raw);
            if (helper.success) {
              const pending = this.pending.get(helper.data.requestId);
              answerHelper(
                raw,
                pending,
                () =>
                  this.pending.get(helper.data.requestId) === pending &&
                  Boolean(pending) &&
                  this.socket === socket,
                (frame) => socket.write(encodeFrame(frame)),
              );
              continue;
            }
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
    this.activeResources = bootConfig.resources;
    this.report(
      'computer.started',
      `QEMU launched; pid=${child.pid ?? 'unavailable'}, accelerator=${bootConfig.accelerator}, memoryMiB=${bootConfig.resources.memoryMiB}, vcpus=${bootConfig.resources.vcpus}.`,
    );
    const append = (chunk: Buffer) => {
      this.log = (this.log + chunk.toString()).slice(-4000);
      this.consoleLog.append(chunk);
      const consoleText = this.panicTail + chunk.toString();
      this.panicTail = consoleText.slice(-512);
      if (!this.guestPanicked && /Kernel panic - not syncing:/.test(consoleText)) {
        this.guestPanicked = true;
        const error = new Error('Linux guest crashed (kernel panic). Recovering the workspace VM.');
        this.report('computer.guest_panicked', error.message, error);
        this.state = { kind: 'qemu', state: 'failed', error: error.message };
        this.failPending(error);
        this.crashCapture = captureGuestCrash(
          this.directory,
          this.control,
          {
            qemuPid: child.pid,
            resources: this.activeResources,
            lastHealth: this.lastHealth,
            consoleTail: this.log,
            consoleDroppedBytes: this.consoleLog.droppedBytes,
            accelerator: bootConfig.accelerator,
            architecture: bootConfig.architecture,
          },
          bootConfig.resources.memoryMiB,
          bootConfig.resources.vcpus,
        )
          .then(async (capture) => {
            await Promise.all([this.consoleLog.flush(), this.healthLog.flush()]);
            await Promise.all([
              copyFile(this.consoleLog.path, join(this.directory, 'crash', 'console.log')),
              copyFile(this.healthLog.path, join(this.directory, 'crash', 'health.log')).catch(
                (failure: NodeJS.ErrnoException) => {
                  if (failure.code !== 'ENOENT') throw failure;
                },
              ),
            ]);
            this.report(
              'computer.crash_captured',
              capture.memoryDumpFile
                ? 'Saved local guest crash diagnostics and memory dump.'
                : 'Saved local guest crash diagnostics; memory dump was disabled or unsuccessful.',
            );
            if (capture.captureError)
              this.report(
                'computer.crash_capture_failed',
                'Guest memory capture failed; recovery will continue.',
                new Error(String(capture.captureError)),
              );
          })
          .catch((failure: unknown) =>
            this.report(
              'computer.crash_capture_failed',
              'Could not save guest crash diagnostics.',
              failure,
            ),
          );
        failed(error);
      }
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
        if (this.child === child) {
          this.child = undefined;
          this.activeResources = undefined;
        }
        this.closeConnection?.();
        this.failPending(new Error('Workspace VM stopped.'));
        if (this.healthTimer) clearInterval(this.healthTimer);
        this.healthTimer = undefined;
        for (const waiter of this.reconnectWaiters)
          waiter.reject(new Error('Workspace VM stopped.'));
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
                  `Guest did not become ready within ${bootTimeoutMs / 1000} seconds. Check the prepared image and guest service. ` +
                    this.log,
                ),
              ),
            bootTimeoutMs,
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
  async request(
    method: ComputerMethod,
    input: unknown,
    owner: RuntimeOwner,
    signal: AbortSignal,
    helper?: ComputerHelper,
  ) {
    signal.throwIfAborted();
    // Boot is shared across callers; cancelling a caller must not tear down peers.
    let abortStart!: () => void;
    try {
      await Promise.race([
        (this.reconnecting ?? this.start()).then(() => this.reconnecting),
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
    return this.exchange(method, input, owner, signal, helper);
  }
  private async exchange(
    method: ComputerMethod,
    input: unknown,
    owner: RuntimeOwner,
    signal: AbortSignal,
    helper?: ComputerHelper,
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
        void this.diagnoseTimeout().catch(() => {});
        reject(error);
      }, 45000);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      this.pending.set(id, {
        resolve,
        reject,
        cleanup,
        helper: method === 'capability' ? helper : undefined,
      });
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
    for (const pending of this.healthPending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.healthPending.clear();
  }
  stop(reason = 'workspace stop') {
    if (reason !== 'bridge recovery restart' && reason !== 'startup failure') {
      this.automaticRestarts = [];
      this.recoveryExhausted = false;
      this.recoveryGeneration++;
    }
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
      if (this.healthTimer) clearInterval(this.healthTimer);
      this.healthTimer = undefined;
      for (const waiter of this.reconnectWaiters) waiter.reject(new Error('Workspace VM stopped.'));
      this.failPending(new Error('Workspace VM stopped.'));
      // The capture has its own deadline; a failed dump must not prevent recovery.
      await this.crashCapture;
      const child = this.child;
      if (child) {
        // mon:stdio starts on the serial console; Ctrl-A C selects its HMP monitor.
        if (!this.control?.powerdown()) child.stdin.write('\x01csystem_powerdown\n');
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
      await Promise.all([this.healthLog.flush(), this.consoleLog.flush()]);
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
  async shutdown() {
    this.disposed = true;
    await this.stop('app shutdown');
    await this.starting?.catch(() => {});
    await this.stop('app shutdown');
  }
}
