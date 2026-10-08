import {
  access,
  appendFile,
  copyFile,
  mkdir,
  readFile,
  rename,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { arch, platform } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import type { QemuSetup } from '../../shared/computer';
import { qemuConfig, qemuSetup, QemuComputer, type QemuConfig } from './qemuComputer';
import { setupProcess } from './setupProcess';
import { downloadImage, imageChecksum } from './setupDownload';
import { setupSeed } from './setupSeed';
import { probeAccelerator } from './setupProbe';

const UBUNTU = 'https://cloud-images.ubuntu.com/noble/current/';
const IMAGE = 'noble-server-cloudimg-amd64.img';
const activePhases = ['checking', 'installing', 'downloading', 'preparing', 'verifying'];
const manifestSchema = z.object({ binary: z.string(), image: z.string(), accelerator: z.string() });

export class ComputerSetupService {
  private state: QemuSetup = {
    available: false,
    phase: 'idle',
    message: 'Linux VM setup has not run yet.',
  };
  private operation?: Promise<void>;
  private controller?: AbortController;
  private managed?: QemuConfig;
  private binary = '';
  private closed = false;
  private root: string;
  private logBytes = 0;
  private logWrite = Promise.resolve();
  constructor(
    private dataDir: string,
    private bundleDir = resolve('dist/guest'),
  ) {
    this.root = join(dataDir, 'computer-setup');
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      this.managed = manifestSchema.parse(
        JSON.parse(await readFile(join(this.root, 'ready.json'), 'utf8')),
      );
    } catch {
      /* No completed automatic setup yet. */
    }
    this.binary = await this.findBinary();
    let interrupted = false;
    try {
      const saved = z
        .object({ phase: z.string(), message: z.string().optional() })
        .parse(JSON.parse(await readFile(join(this.root, 'progress.json'), 'utf8')));
      interrupted = activePhases.includes(saved.phase) || saved.phase === 'reboot-required';
      if (saved.phase === 'failed')
        this.state = {
          available: false,
          phase: 'failed',
          message: saved.message,
          reason: saved.message,
          detail: await readFile(join(this.root, 'setup.log'), 'utf8')
            .then((text) => text.slice(-3000))
            .catch(() => undefined),
        };
    } catch {
      /* First run. */
    }
    const ready = await this.status();
    if (interrupted && !ready.available) await this.start();
  }
  configuration(): QemuConfig {
    const config = qemuConfig();
    return {
      binary: config.binary || this.binary || this.managed?.binary || '',
      image: config.image || this.managed?.image || '',
      accelerator: process.env.MUKAI_QEMU_ACCEL || this.managed?.accelerator || config.accelerator,
    };
  }
  async status(): Promise<QemuSetup> {
    if (this.operation) return { ...this.state };
    const ready = await qemuSetup(this.configuration());
    if (ready.available) return { available: true, phase: 'ready', message: 'Linux VM is ready.' };
    if (this.state.phase === 'failed' || this.state.phase === 'reboot-required')
      return { ...this.state };
    return {
      ...ready,
      phase: 'idle',
      message:
        'Choose Linux VM to install QEMU and prepare Linux automatically. Administrator approval may be needed.',
    };
  }
  async start(): Promise<QemuSetup> {
    if (this.closed) throw new Error('VM setup is shutting down.');
    if (this.operation && (this.state.phase === 'failed' || this.state.phase === 'reboot-required'))
      await this.operation;
    if (this.operation) return { ...this.state };
    const ready = await this.status();
    if (this.closed) throw new Error('VM setup is shutting down.');
    if (this.operation) return { ...this.state };
    if (ready.available) return ready;
    this.controller = new AbortController();
    this.state = { available: false, phase: 'checking', message: 'Checking this computer…' };
    this.operation = this.install(this.controller.signal)
      .catch(async (error: unknown) => {
        if (this.controller?.signal.aborted) return; // Keep the last active phase so startup resumes it.
        if (this.state.phase !== 'reboot-required') {
          const message =
            error instanceof Error ? error.message : 'Linux VM setup failed. Retry setup.';
          try {
            await this.phase('failed', message);
          } catch {
            this.state = { available: false, phase: 'failed', message, reason: message };
          }
        }
      })
      .finally(() => {
        this.operation = undefined;
      });
    return { ...this.state };
  }
  private async phase(phase: NonNullable<QemuSetup['phase']>, message: string) {
    this.state = {
      available: phase === 'ready',
      phase,
      message,
      detail: this.state.detail,
      ...(phase === 'failed' || phase === 'reboot-required' ? { reason: message } : {}),
    };
    const path = join(this.root, 'progress.json');
    await writeFile(path + '.tmp', JSON.stringify({ phase, message }), { mode: 0o600 });
    await rename(path + '.tmp', path);
    this.output(`\n[${phase}] ${message}\n`);
  }
  private output = (text: string) => {
    const clean = stripVTControlCharacters(text).replace(/[^\x20-\x7e\n\r\t]/g, '');
    this.state = { ...this.state, detail: ((this.state.detail || '') + clean).slice(-3000) };
    if (this.logBytes < 2 * 1024 ** 2) {
      this.logBytes += Buffer.byteLength(clean);
      this.logWrite = this.logWrite
        .then(() => appendFile(join(this.root, 'setup.log'), clean, { mode: 0o600 }))
        .catch(() => {});
    }
  };
  private async findBinary() {
    if (process.env.MUKAI_QEMU_BINARY) return process.env.MUKAI_QEMU_BINARY;
    const name = platform() === 'win32' ? 'qemu-system-x86_64.exe' : 'qemu-system-x86_64';
    const candidates = [
      this.managed?.binary || '',
      ...String(process.env.PATH || '')
        .split(delimiter)
        .filter(Boolean)
        .map((folder) => join(folder, name)),
      ...(platform() === 'win32'
        ? [join(process.env.ProgramFiles || 'C:\\Program Files', 'qemu', name)]
        : ['/usr/bin/' + name, '/usr/local/bin/' + name, '/opt/homebrew/bin/' + name]),
    ];
    for (const path of candidates.filter(Boolean)) {
      try {
        await access(path, platform() === 'win32' ? constants.F_OK : constants.X_OK);
        return path;
      } catch {
        /* Try next known location. */
      }
    }
    return '';
  }
  private async command(binary: string, args: string[], signal: AbortSignal, input?: string) {
    const result = await setupProcess(binary, args, signal, input, this.output);
    if (result.code !== 0)
      throw new Error(
        `${binary.split(/[\\/]/).at(-1)} could not complete VM setup (exit ${result.code}). ${result.output.slice(-1500)}`,
      );
    return result;
  }
  private async installQemu(signal: AbortSignal) {
    await this.phase(
      'installing',
      'Installing QEMU. Approve the operating system installer if prompted.',
    );
    if (platform() === 'win32') {
      await this.command(
        'winget.exe',
        [
          'install',
          '--exact',
          '--id',
          'SoftwareFreedomConservancy.QEMU',
          '--source',
          'winget',
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements',
          '--disable-interactivity',
        ],
        signal,
      );
    } else if (platform() === 'darwin') {
      let brew = '';
      for (const candidate of ['/usr/local/bin/brew', '/opt/homebrew/bin/brew']) {
        try {
          await access(candidate);
          brew = candidate;
          break;
        } catch {
          /* Next. */
        }
      }
      if (!brew)
        throw new Error(
          'Automatic QEMU installation on macOS requires Homebrew. Install Homebrew, then retry setup.',
        );
      await this.command(brew, ['install', 'qemu'], signal);
    } else {
      try {
        await access('/usr/bin/apt-get');
      } catch {
        throw new Error(
          'Install QEMU using your Linux package manager, then retry. Automatic installation currently supports Ubuntu/Debian.',
        );
      }
      const root = process.getuid?.() === 0;
      await this.command(
        root ? '/usr/bin/apt-get' : '/usr/bin/pkexec',
        root
          ? ['install', '-y', 'qemu-system-x86', 'qemu-utils']
          : ['/usr/bin/apt-get', 'install', '-y', 'qemu-system-x86', 'qemu-utils'],
        signal,
      );
    }
    this.binary = await this.findBinary();
    if (!this.binary)
      throw new Error(
        'QEMU installation finished, but its executable could not be located. Restart Mukai and retry setup.',
      );
  }
  private async accelerator(signal: AbortSignal) {
    const accelerator = this.configuration().accelerator;
    await this.phase('checking', 'Checking hardware virtualization…');
    const probe = () => probeAccelerator(this.binary, accelerator, signal, this.output);
    if ((await probe()).code === 0) return accelerator;
    if (platform() !== 'win32' || accelerator !== 'whpx')
      throw new Error(
        `QEMU cannot use ${accelerator}. Check virtualization support and permissions, then retry setup.`,
      );
    await this.phase(
      'installing',
      'Enabling Windows Hypervisor Platform. Windows may ask for administrator approval.',
    );
    const enabled = await setupProcess(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$p = Start-Process -FilePath dism.exe -ArgumentList '/Online','/Enable-Feature','/FeatureName:HypervisorPlatform','/All','/NoRestart','/Quiet' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode",
      ],
      signal,
      undefined,
      this.output,
    );
    if (enabled.code === 3010) {
      await this.phase(
        'reboot-required',
        'Restart Windows to finish enabling virtualization, then reopen Mukai. Setup will continue automatically.',
      );
      throw new Error('Restart required.');
    }
    if (enabled.code !== 0)
      throw new Error(
        'Windows could not enable virtualization. Administrator approval is required. Retry setup when ready.',
      );
    if ((await probe()).code !== 0) {
      await this.phase(
        'reboot-required',
        'Restart Windows and check that virtualization is enabled in BIOS/UEFI, then reopen Mukai to continue setup.',
      );
      throw new Error('Restart required.');
    }
    return accelerator;
  }
  private async install(signal: AbortSignal) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.logWrite;
    this.logBytes = 0;
    await writeFile(join(this.root, 'setup.log'), '', { mode: 0o600 });
    await this.phase('checking', 'Checking virtualization and free disk space…');
    if (arch() !== 'x64')
      throw new Error('Automatic Linux VM setup currently requires an x64 computer.');
    // Check the packaged bundle before triggering any downloads or OS installation.
    try {
      await access(join(this.bundleDir, 'guest.cjs'));
    } catch {
      throw new Error(
        'The Linux guest bundle is missing. Reinstall Mukai, or run npm run build:guest in a development checkout.',
      );
    }
    const space = await statfs(this.dataDir);
    if (space.bavail * space.bsize < 12 * 1024 ** 3)
      throw new Error('Free at least 12 GiB on Mukai’s data drive, then retry VM setup.');
    this.binary = await this.findBinary();
    if (!this.binary) await this.installQemu(signal);
    const accelerator = await this.accelerator(signal);
    const config = this.configuration();
    if (process.env.MUKAI_QEMU_IMAGE) {
      const external = await qemuSetup({ ...config, binary: this.binary, accelerator });
      if (!external.available) throw new Error(external.reason);
      this.managed = { ...config, binary: this.binary, accelerator };
      await this.phase('ready', 'Linux VM is ready.');
      return;
    }
    await this.phase('downloading', 'Downloading Ubuntu Linux…');
    const sumsResponse = await fetch(UBUNTU + 'SHA256SUMS', {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    if (!sumsResponse.ok) throw new Error('Could not fetch Ubuntu image checksums. Retry setup.');
    const sums = await sumsResponse.text();
    if (sums.length > 128000) throw new Error('Invalid Ubuntu checksum response.');
    const checksum = imageChecksum(sums, IMAGE);
    const download = join(this.root, 'ubuntu.qcow2');
    await downloadImage(
      UBUNTU + IMAGE,
      download,
      checksum,
      signal,
      (downloadedBytes, totalBytes) => {
        this.state = { ...this.state, downloadedBytes, totalBytes };
      },
    );
    signal.throwIfAborted();
    await this.phase(
      'preparing',
      'Preparing Linux, Node.js, Chrome and the Mukai guest tools. This can take several minutes…',
    );
    const buildDir = join(this.root, 'building');
    await mkdir(buildDir, { recursive: true, mode: 0o700 });
    // Preparation and verification must both stop before a retry replaces their disk.
    for (const name of ['preparation.pid', 'runtime.pid']) {
      const path = join(buildDir, name);
      try {
        const pid = Number(await readFile(path, 'utf8'));
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid Linux setup PID file.');
        try {
          process.kill(pid, 0);
          throw new Error(
            'A previous Linux setup VM is still running. Close its QEMU process, then retry setup.',
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const candidate = join(buildDir, 'disk.qcow2');
    await copyFile(download, candidate);
    const imageTool = join(
      dirname(this.binary),
      platform() === 'win32' ? 'qemu-img.exe' : 'qemu-img',
    );
    await this.command(imageTool, ['resize', candidate, '32G'], signal);
    const seed = await setupSeed(this.bundleDir);
    let completed = false;
    let failed = false;
    let failureDetail: string | undefined;
    let serial = '';
    try {
      const result = await setupProcess(
        this.binary,
        [
          '-machine',
          'q35',
          '-accel',
          accelerator,
          '-cpu',
          'Nehalem',
          '-m',
          '2048',
          '-smp',
          '2',
          '-display',
          'none',
          '-monitor',
          'none',
          '-serial',
          'stdio',
          '-no-reboot',
          '-pidfile',
          join(buildDir, 'preparation.pid'),
          '-drive',
          `file=${candidate.replace(/,/g, ',,')},format=qcow2,if=virtio`,
          '-netdev',
          'user,id=net0',
          '-device',
          'virtio-net-pci,netdev=net0',
          '-smbios',
          `type=1,serial=ds=nocloud;s=http://10.0.2.2:${seed.port}/${seed.token}/`,
        ],
        signal,
        undefined,
        (text) => {
          this.output(text);
          serial = (serial + text).slice(-12000);
          if (serial.includes('MUKAI_IMAGE_READY')) completed = true;
          if (!failed && serial.includes('MUKAI_IMAGE_FAILED')) {
            failed = true;
            failureDetail = this.state.detail;
          }
        },
      );
      if (result.code !== 0 || !completed || failed) {
        if (failureDetail) this.state = { ...this.state, detail: failureDetail };
        throw new Error(
          'Linux preparation failed. See Setup details for the installer error, then retry setup.',
        );
      }
    } finally {
      await seed.close();
    }
    await this.phase('verifying', 'Starting the prepared Linux VM to verify its tools…');
    const verification = new QemuComputer(buildDir, {
      binary: this.binary,
      image: candidate,
      accelerator,
    });
    const abort = () => {
      void verification.shutdown();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const result = (await verification.request(
        'terminal',
        { command: 'uname -s && node --version && google-chrome --version', yieldMs: 30000 },
        { workspaceId: 'setup', botId: 'setup', conversationId: 'setup' },
        signal,
      )) as { exitCode: number | null; output: string };
      if (result.exitCode !== 0 || !result.output.includes('Linux'))
        throw new Error('Prepared Linux VM failed its tool check. Retry setup.');
    } finally {
      signal.removeEventListener('abort', abort);
      await verification.shutdown();
    }
    signal.throwIfAborted();
    const image = join(this.root, 'mukai-linux.qcow2');
    await rename(candidate, image);
    this.managed = { binary: this.binary, image, accelerator };
    await writeFile(join(this.root, 'ready.json'), JSON.stringify(this.managed), { mode: 0o600 });
    await this.phase('ready', 'Linux VM is ready.');
  }
  async shutdown() {
    this.closed = true;
    this.controller?.abort();
    await this.operation;
    await this.logWrite;
  }
}
