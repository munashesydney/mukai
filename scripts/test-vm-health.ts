/** Opt-in, bounded load checks in a disposable clone of the prepared Linux base. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { freemem, homedir, platform, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  QemuComputer,
  qemuConfig,
  qemuSetup,
  type QemuConfig,
} from '../src/server/computer/qemuComputer';
import { DiagnosticService } from '../src/server/services/diagnosticService';
import { upgradeGuest } from '../src/server/computer/upgradeGuest';

const GiB = 1024 ** 3;
const help = `Usage: npm run test:vm-health -- --preflight | --stress [--data-dir PATH] [--offline-debs PATH.tar]

Without --preflight or --stress, this prints help and never starts a VM.
--preflight checks the prepared base read-only, without guest upgrades or load tests.
--offline-debs supplies desktop packages from a verified local flat USTAR .tar (at most 64 MiB).
Offline preparation uses only the disposable clone and has a 300-second overall limit.
Uses a disposable copy of the prepared base; never opens a personal workspace disk.
Runs 6 GiB / 2 CPUs, one CPU task for 15 seconds and at most 1 GiB of memory for 20 seconds.
Requires at least 8 GiB of host RAM available and 12 GiB of disk space.
Checks guest health, terminal responses, and bridge reconnect without rebooting Linux.
No downloads, network installs, host mounts, or changes to your running workspace.
Reports and diagnostic logs remain under artifacts/vm-health; the test VM is removed.
The disposable VM disk lives in OS temporary storage to avoid cloud-sync interference.
MUKAI_QEMU_* overrides and MUKAI_DATA_DIR are supported for an existing prepared setup.`;

const manifestSchema = z.object({
  binary: z.string(),
  image: z.string(),
  accelerator: z.string(),
  architecture: z.enum(['x64', 'arm64']).default('x64'),
});
const sessionSchema = z.object({
  id: z.string().uuid(),
  pid: z.number().nullable().optional(),
  status: z.string(),
  exitCode: z.number().nullable(),
  output: z.string().default(''),
});
type Session = z.infer<typeof sessionSchema>;
type Phase = {
  name: string;
  startedAt: string;
  elapsedMs?: number;
  detail?: unknown;
  error?: string;
};
interface OfflinePackages {
  source: string;
  bytes: number;
  sha256: string;
  packages: { name: string; bytes: number; sha256: string }[];
  archive: Buffer;
}

async function offlinePackages(path: string): Promise<OfflinePackages> {
  const source = await realpath(path);
  const information = await stat(source);
  if (
    !source.toLowerCase().endsWith('.tar') ||
    !information.isFile() ||
    information.size <= 0 ||
    information.size > 64 * 1024 ** 2
  )
    throw new Error(
      '--offline-debs requires a regular uncompressed .tar file no larger than 64 MiB.',
    );
  const archive = await readFile(source);
  assert.equal(archive.length, information.size, 'Offline archive changed while being read.');
  assert.equal(archive.length % 512, 0, 'Offline archive must use standard 512-byte TAR blocks.');
  const packages: OfflinePackages['packages'] = [];
  const names = new Set<string>();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert.ok(
        archive.subarray(offset).every((byte) => byte === 0),
        'Unexpected data after TAR end marker.',
      );
      break;
    }
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .split('\0')[0];
    assert.equal(
      field(257, 6),
      'ustar',
      'Offline archive must be plain USTAR without extended headers.',
    );
    const name = field(0, 100);
    assert.ok(
      /^[a-zA-Z0-9][a-zA-Z0-9+._~%-]*\.deb$/.test(name) && !names.has(name),
      'Offline archive requires unique flat .deb file names.',
    );
    assert.equal(field(345, 155), '', 'Offline archive must not contain directory prefixes.');
    assert.ok(
      header[156] === 0 || header[156] === 48,
      'Offline archive must contain only regular .deb files.',
    );
    const sizeField = field(124, 12).trim();
    const checksumField = field(148, 8).trim();
    assert.ok(
      /^[0-7]+$/.test(sizeField) && /^[0-7]+$/.test(checksumField),
      'Invalid TAR size or checksum.',
    );
    const size = Number.parseInt(sizeField, 8);
    let checksum = 0;
    for (let index = 0; index < 512; index++)
      checksum += index >= 148 && index < 156 ? 32 : header[index];
    assert.equal(
      checksum,
      Number.parseInt(checksumField, 8),
      'Offline archive header checksum failed.',
    );
    assert.ok(size > 8 && offset + 512 + size <= archive.length, 'Truncated offline package.');
    const contents = archive.subarray(offset + 512, offset + 512 + size);
    assert.equal(
      contents.subarray(0, 8).toString('ascii'),
      '!<arch>\n',
      'Offline package is not a Debian ar archive.',
    );
    names.add(name);
    packages.push({
      name,
      bytes: size,
      sha256: createHash('sha256').update(contents).digest('hex'),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(packages.length > 0, 'Offline archive contains no Debian packages.');
  return {
    source,
    bytes: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex'),
    packages,
    archive,
  };
}

function dataDirectory() {
  if (process.env.MUKAI_DATA_DIR) return resolve(process.env.MUKAI_DATA_DIR);
  const parent =
    platform() === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : platform() === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(parent, 'mukai', 'data');
}

async function configuration(dataDir: string): Promise<QemuConfig> {
  let managed: z.infer<typeof manifestSchema> | undefined;
  try {
    managed = manifestSchema.parse(
      JSON.parse(await readFile(join(dataDir, 'computer-setup', 'ready.json'), 'utf8')),
    );
  } catch (error) {
    if (!process.env.MUKAI_QEMU_BINARY || !process.env.MUKAI_QEMU_IMAGE)
      throw new Error(
        `No prepared VM setup at ${dataDir}. Set --data-dir to Mukai's existing data directory.`,
        { cause: error },
      );
  }
  const override = qemuConfig();
  const config: QemuConfig = {
    ...override,
    binary: override.binary || managed?.binary || '',
    image: override.image || managed?.image || '',
    accelerator: process.env.MUKAI_QEMU_ACCEL || managed?.accelerator || override.accelerator,
    architecture: override.image
      ? override.architecture
      : managed?.architecture || override.architecture,
    resources: { memoryMiB: 6144, vcpus: 2 },
  };
  const setup = await qemuSetup(config);
  if (!setup.available) throw new Error(setup.reason);
  config.image = await realpath(config.image);
  if (
    basename(config.image).toLowerCase() === 'disk.qcow2' ||
    /[\\/](?:workspaces|computers)[\\/]/i.test(config.image)
  )
    throw new Error(
      'Refusing a workspace disk. Use the prepared base from computer-setup/ready.json.',
    );
  return config;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log(help);
    return;
  }
  let dataDir = dataDirectory();
  let stress = false;
  let preflight = false;
  let offlinePath: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--stress') stress = true;
    else if (args[index] === '--preflight') preflight = true;
    else if (args[index] === '--offline-debs' && args[index + 1])
      offlinePath = resolve(args[++index]);
    else if (args[index] === '--data-dir' && args[index + 1]) dataDir = resolve(args[++index]);
    else throw new Error(`Unknown or incomplete argument: ${args[index]}\n${help}`);
  }
  if (stress === preflight)
    throw new Error(`Choose exactly one of --preflight or --stress.\n${help}`);
  if (offlinePath && !stress) throw new Error('--offline-debs requires --stress.');
  const offline = offlinePath ? await offlinePackages(offlinePath) : undefined;
  const config = await configuration(dataDir);
  const free = freemem();
  if (free < 8 * GiB)
    throw new Error(
      `Only ${(free / GiB).toFixed(1)} GiB of host RAM is available. Free at least 8 GiB before testing.`,
    );
  if (stress) await access(resolve('dist/guest/guest.cjs'));
  const artifactParent = resolve('artifacts/vm-health');
  await mkdir(artifactParent, { recursive: true });
  const temporaryParent = await realpath(tmpdir());
  const space = await statfs(temporaryParent);
  if (space.bavail * space.bsize < 12 * GiB)
    throw new Error('Free at least 12 GiB on the OS temporary-storage drive before testing.');
  const reportDirectory = await realpath(await mkdtemp(join(artifactParent, 'run-')));
  const vmDirectory = await realpath(await mkdtemp(join(temporaryParent, 'mukai-vm-health-')));
  const offlineDrive = offline ? join(vmDirectory, 'offline-desktop-cache.tar') : undefined;
  const diagnostics = new DiagnosticService(reportDirectory);
  const vm = new QemuComputer(
    vmDirectory,
    config,
    (binary, values, options) => {
      // Keep the clone isolated from external network traffic; local browser checks use guest loopback.
      const args = [...values];
      assert.ok(
        !args.includes('-virtfs') &&
          !args.includes('-fsdev') &&
          !args.some((value) => value.includes('virtiofs')),
      );
      const drive = args.indexOf('-drive');
      assert.ok(
        drive >= 0 &&
          args[drive + 1].startsWith(
            `file=${join(vmDirectory, 'disk.qcow2').replace(/,/g, ',,')},`,
          ),
      );
      const network = args.indexOf('-netdev');
      assert.ok(network >= 0 && args[network + 1].startsWith('user,'));
      args[network + 1] += ',restrict=on';
      if (offlineDrive)
        args.push(
          '-drive',
          `file=${offlineDrive.replace(/,/g, ',,')},format=raw,if=virtio,readonly=on`,
        );
      return spawn(binary, args, options);
    },
    preflight || offline ? undefined : resolve('dist/guest'),
    diagnostics,
  );
  const controller = new AbortController();
  // Leave 15 seconds for QEMU shutdown; preflight never waits for or attempts a guest upgrade.
  const durationLimit = preflight ? 45000 : offline ? 285000 : 165000;
  const deadline = setTimeout(
    () =>
      controller.abort(new Error(`VM check exceeded its ${durationLimit / 1000}-second limit.`)),
    durationLimit,
  );
  const interrupt = () => controller.abort(new Error('VM check interrupted.'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const owner = {
    workspaceId: basename(vmDirectory),
    botId: 'health-test',
    conversationId: 'health-test',
  };
  const phases: Phase[] = [];
  const loadSamples: unknown[] = [];
  const sessions = new Set<string>();
  const startedAt = new Date().toISOString();
  let failure: unknown;
  let preparationOutput = '';
  let preflightResult:
    | {
        output: string;
        missingDesktopPrograms: string[];
        status: ReturnType<QemuComputer['status']>;
        guestRevision: string;
      }
    | undefined;
  const signal = (milliseconds = 10000) =>
    AbortSignal.any([controller.signal, AbortSignal.timeout(milliseconds)]);
  const request = (
    method: Parameters<QemuComputer['request']>[0],
    input: unknown,
    milliseconds = 10000,
  ) => vm.request(method, input, owner, signal(milliseconds));
  const phase = async <T>(name: string, run: () => Promise<T>) => {
    const entry: Phase = { name, startedAt: new Date().toISOString() };
    phases.push(entry);
    const started = Date.now();
    console.log(`[VM health] ${name}`);
    try {
      const result = await run();
      entry.detail = result;
      return result;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      entry.elapsedMs = Date.now() - started;
    }
  };
  const run = async (command: string, milliseconds = 10000, timeoutSeconds = 15) => {
    let state = sessionSchema.parse(
      await request('terminal', { command, yieldMs: 1000, timeoutSeconds }, milliseconds),
    );
    while (state.status === 'running')
      state = sessionSchema.parse(
        await request('process', { action: 'wait', sessionId: state.id, waitMs: 1000 }),
      );
    assert.equal(state.exitCode, 0, state.output);
    return state.output;
  };
  const background = async (command: string, timeoutSeconds: number): Promise<Session> => {
    const state = sessionSchema.parse(
      await request('terminal', { command, background: true, timeoutSeconds }),
    );
    assert.equal(state.status, 'running', state.output);
    sessions.add(state.id);
    return state;
  };
  const health = () => vm.inspectHealth(signal(6000));
  const observe = async (session: Session, durationSeconds: number) => {
    const samples: unknown[] = [];
    const endsAt = Date.now() + (durationSeconds + 6) * 1000;
    while (Date.now() < endsAt) {
      const started = Date.now();
      const [sample, response] = await Promise.all([health(), run('printf terminal-responsive')]);
      assert.equal(response, 'terminal-responsive');
      const observation = {
        timestamp: new Date().toISOString(),
        responseMs: Date.now() - started,
        health: sample,
      };
      samples.push(observation);
      loadSamples.push(observation);
      const current = sessionSchema.parse(
        await request('process', { action: 'poll', sessionId: session.id }),
      );
      if (current.status !== 'running') {
        assert.equal(current.exitCode, 0, current.output);
        sessions.delete(session.id);
        return { samples, output: current.output };
      }
      await delay(3000, undefined, { signal: controller.signal });
    }
    throw new Error('Bounded load did not finish within its expected lifetime.');
  };
  const preserveVmLogs = async () => {
    const retained: string[] = [];
    for (const name of [
      'health.log',
      'console.log',
      'health.log.1',
      'health.log.2',
      'console.log.1',
      'console.log.2',
    ]) {
      try {
        const destination = join(reportDirectory, name);
        await copyFile(join(vmDirectory, name), destination);
        retained.push(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return retained;
  };
  try {
    console.log(
      `Disposable clone: ${vmDirectory}\nReport: ${join(reportDirectory, 'report.json')}\nDiagnostics: ${diagnostics.path}`,
    );
    if (offlineDrive && offline) {
      await phase('stage verified package archive as a read-only raw drive', async () => {
        await writeFile(offlineDrive, offline.archive, { mode: 0o600 });
        return { sha256: offline.sha256, bytes: offline.bytes, packages: offline.packages.length };
      });
    }
    if (preflight) {
      await phase('prepared base preflight without upgrades', async () => {
        const output = await run(
          'uname -a && node --version && free -m; for binary in Xtigervnc startxfce4; do if command -v "$binary" >/dev/null 2>&1; then printf "MUKAI_PREFLIGHT_%s=present\\n" "$binary"; else printf "MUKAI_PREFLIGHT_%s=missing\\n" "$binary"; fi; done',
          45000,
        );
        const missingDesktopPrograms = ['Xtigervnc', 'startxfce4'].filter(
          (binary) => !output.includes(`MUKAI_PREFLIGHT_${binary}=present`),
        );
        preflightResult = {
          output,
          missingDesktopPrograms,
          status: vm.status(),
          guestRevision: 'Not exposed by the public VM status API; no private state was inspected.',
        };
        console.log(output);
        if (missingDesktopPrograms.length)
          throw new Error(
            `Prepared base is missing desktop programs: ${missingDesktopPrograms.join(', ')}. Stress was not attempted, and no packages were installed or downloaded.`,
          );
        return preflightResult;
      });
    } else {
      if (offline) {
        await phase('boot legacy base without automatic guest upgrades', () =>
          run('uname -s && node --version', 125000),
        );
        await phase('install supplied desktop packages without downloads', () =>
          run(
            'sudo -n mkdir -p /var/tmp/mukai-health-apt-cache/partial && sudo -n chmod 0755 /var/tmp/mukai-health-apt-cache /var/tmp/mukai-health-apt-cache/partial && sudo -n tar --no-same-owner --no-same-permissions -xf /dev/vdb -C /var/tmp/mukai-health-apt-cache && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get --no-download -o Dir::Cache::archives=/var/tmp/mukai-health-apt-cache -o Acquire::Retries=0 -o DPkg::Lock::Timeout=10 install -y --no-install-recommends /var/tmp/mukai-health-apt-cache/*.deb tigervnc-standalone-server tigervnc-tools xfce4 xfce4-terminal dbus-x11 x11-utils fonts-dejavu-core polkitd && command -v Xtigervnc && command -v startxfce4',
            10000,
            120,
          ),
        );
        await phase('apply guest bundle manually in the owned clone', async () => {
          await upgradeGuest(
            resolve('dist/guest'),
            vm.request.bind(vm),
            controller.signal,
            (output) => {
              preparationOutput = output;
            },
          );
          return { output: preparationOutput };
        });
        await phase('reboot only the prepared disposable clone', async () => {
          await vm.stop('offline health preparation complete');
          await run(
            'uname -s && node --version && command -v Xtigervnc && command -v startxfce4',
            125000,
          );
          return vm.status();
        });
      }
      await phase('boot and baseline terminal', () =>
        run('uname -s && node --version && python3 --version && printf healthy', 125000),
      );
      const baselineHealth = await phase('independent guest health', health);
      assert.deepEqual(vm.status().activeResources, { memoryMiB: 6144, vcpus: 2 });
      assert.ok(
        baselineHealth.memory.swapTotalKiB !== null && baselineHealth.memory.swapTotalKiB > 0,
        'Guest swap provisioning did not activate.',
      );
      await phase('swap and persistent diagnostics', () =>
        run(
          'free -m && test -d /var/log/mukai-guest && sudo -n test -s /var/log/mukai-guest/health.log && sudo -n journalctl --disk-usage',
        ),
      );

      await request('files', {
        action: 'write_file',
        path: 'health-test.html',
        content: '<title>VM health</title><h1>VM health browser responsive</h1>',
      });
      const web = await background('python3 -m http.server 8765 --bind 127.0.0.1', 120);
      await delay(500, undefined, { signal: controller.signal });
      const tab = z
        .object({ tab: z.object({ id: z.string().uuid() }) })
        .parse(
          await phase('Chrome baseline', () =>
            request(
              'browser',
              { action: 'open', url: 'http://127.0.0.1:8765/health-test.html' },
              20000,
            ),
          ),
        );
      assert.match(
        JSON.stringify(await request('browser', { action: 'snapshot', sessionId: tab.tab.id })),
        /VM health browser responsive/,
      );

      const marker = await background(
        'printf "%s\\n" "$$" > bridge-survival.pid; exec sleep 90',
        95,
      );
      const markerPid = (await run('cat bridge-survival.pid')).trim();
      assert.match(markerPid, /^\d+$/);
      await phase('bridge reconnect preserves guest processes and Chrome', async () => {
        const beforeReconnect = await health();
        await vm.recoverBridge('isolated health harness', signal(15000));
        // Recovery must already have verified both directions. Do not mask an
        // early-readiness regression by retrying this acceptance check.
        const started = Date.now();
        await health();
        const reconnectProbes = [{ elapsedMs: Date.now() - started }];
        const current = sessionSchema.parse(
          await request('process', { action: 'poll', sessionId: marker.id }),
        );
        assert.equal(current.status, 'running');
        await run(`kill -0 ${markerPid}; test "$(cat bridge-survival.pid)" = ${markerPid}`);
        assert.match(
          JSON.stringify(await request('browser', { action: 'snapshot', sessionId: tab.tab.id })),
          /VM health browser responsive/,
        );
        const afterReconnect = await health();
        assert.equal(afterReconnect.bridgePid, beforeReconnect.bridgePid);
        assert.equal(afterReconnect.workerPid, beforeReconnect.workerPid);
        return { health: afterReconnect, reconnectProbes };
      });
      await request('process', { action: 'kill', sessionId: marker.id });
      sessions.delete(marker.id);

      await request('files', {
        action: 'write_file',
        path: 'health-cpu.py',
        content:
          'import time\nend = time.monotonic() + 15\nvalue = 1\nwhile time.monotonic() < end:\n    value = (value * 1664525 + 1013904223) & 0xffffffff\nprint("bounded CPU load completed")\n',
      });
      await phase('one CPU process for 15 seconds', async () =>
        observe(await background('python3 health-cpu.py', 22), 15),
      );

      const beforeMemory = await health();
      const availableKiB = beforeMemory.memory.availableKiB;
      assert.ok(availableKiB !== null, 'Guest available memory could not be measured safely.');
      const memoryMiB = Math.floor(Math.min(1024, availableKiB / 2048));
      assert.ok(memoryMiB >= 64, 'Guest has insufficient available memory for a safe load check.');
      await request('files', {
        action: 'write_file',
        path: 'health-memory.py',
        content: `import resource, time\nresource.setrlimit(resource.RLIMIT_AS, (${(memoryMiB + 128) * 1024 ** 2}, ${(memoryMiB + 128) * 1024 ** 2}))\nblocks = [bytearray(1024 * 1024) for _ in range(${memoryMiB})]\nfor block in blocks:\n    for offset in range(0, len(block), 4096):\n        block[offset] = 1\ntime.sleep(20)\nprint("bounded memory load completed: ${memoryMiB} MiB")\n`,
      });
      await phase(`bounded memory allocation: ${memoryMiB} MiB for 20 seconds`, async () =>
        observe(await background('python3 health-memory.py', 27), 20),
      );
      await phase('final guest and Chrome health', async () => {
        assert.match(
          JSON.stringify(await request('browser', { action: 'snapshot', sessionId: tab.tab.id })),
          /VM health browser responsive/,
        );
        const finalHealth = await health();
        if (baselineHealth.oomKillCount !== null && finalHealth.oomKillCount !== null)
          assert.equal(
            finalHealth.oomKillCount,
            baselineHealth.oomKillCount,
            'An OOM kill occurred during the bounded check.',
          );
        return finalHealth;
      });
      await request('process', { action: 'kill', sessionId: web.id });
      sessions.delete(web.id);
    }
  } catch (error) {
    failure = error;
    console.error(error);
    diagnostics.record('computer.health_test_failed', error, {
      phase: 'computer',
      workspaceId: owner.workspaceId,
    });
  } finally {
    clearTimeout(deadline);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (!controller.signal.aborted && vm.status().state === 'running') {
      for (const id of sessions)
        await request('process', { action: 'kill', sessionId: id }, 3000).catch(() => {});
    }
    let shutdownSucceeded = false;
    let cloneRemoved = false;
    let retainedLogs: string[] = [];
    try {
      await vm.shutdown();
      shutdownSucceeded = true;
      // QemuComputer shutdown flushes these logs; preserve them before deleting the cloned disk.
      retainedLogs = await preserveVmLogs();
      const target = await realpath(vmDirectory);
      // Delete only the owned direct child created above, after the guest process exits.
      assert.equal(dirname(target), temporaryParent);
      assert.ok(basename(target).startsWith('mukai-vm-health-'));
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      cloneRemoved = true;
    } catch (error) {
      failure ||= error;
      console.error('The disposable clone was retained because shutdown or cleanup failed.', error);
    }
    await writeFile(
      join(reportDirectory, 'report.json'),
      JSON.stringify(
        {
          startedAt,
          finishedAt: new Date().toISOString(),
          mode: preflight ? 'preflight' : 'stress',
          guestUpgradeEnabled: !preflight,
          automaticGuestUpgradeEnabled: !preflight && !offline,
          offlinePreparation: offline
            ? {
                source: offline.source,
                bytes: offline.bytes,
                sha256: offline.sha256,
                packages: offline.packages,
                output: preparationOutput,
                driveMode: 'read-only raw virtio',
                guestArchiveDevice: '/dev/vdb',
              }
            : undefined,
          preflight: preflightResult,
          passed: !failure,
          error: failure instanceof Error ? failure.message : failure ? String(failure) : undefined,
          host: { totalMemoryGiB: totalmem() / GiB, initialAvailableMemoryGiB: free / GiB },
          resources: config.resources,
          preparedImage: config.image,
          diagnosticsPath: diagnostics.path,
          retainedLogs,
          shutdownSucceeded,
          cloneRemoved,
          retainedClone: cloneRemoved ? undefined : vmDirectory,
          phases,
          loadSamples,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      `Report saved: ${join(reportDirectory, 'report.json')}\nDiagnostics saved: ${diagnostics.path}`,
    );
  }
  if (failure) throw failure;
  console.log(
    preflight
      ? 'Verified prepared-base terminal and desktop prerequisites without guest upgrades or load tests.'
      : 'Verified baseline, bounded CPU/memory load, and bridge reconnect in a disposable VM.',
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
