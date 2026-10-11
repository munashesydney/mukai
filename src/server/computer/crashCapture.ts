import { chmod, mkdir, open, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { qemuControl } from './qemuControl';

type Control = Pick<Awaited<ReturnType<typeof qemuControl>>, 'command'>;
const GiB = 1024 ** 3;

/** A local diagnostic opt-in. Recovery never depends on a successful memory dump. */
export async function captureGuestCrash(
  directory: string,
  control: Control | undefined,
  metadata: Record<string, unknown>,
  memoryMiB: number,
  vcpus: number,
) {
  const path = join(directory, 'crash');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const report: Record<string, unknown> = { capturedAt: new Date().toISOString(), ...metadata };
  const save = () =>
    writeFile(join(path, 'latest.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await save();
  if (!control) return report;
  const signal = AbortSignal.timeout(45000);
  let dumping = false;
  const partial = join(path, 'vmcore.partial');
  try {
    report.qemuVersion = await control.command('query-version', undefined, signal);
    const enabled =
      process.env.MUKAI_VM_CRASH_CAPTURE === '1' ||
      (await stat(join(directory, 'capture-crashes')).then(
        (item) => item.isFile(),
        () => false,
      ));
    report.memoryCaptureEnabled = enabled;
    if (!enabled) {
      await save();
      return report;
    }
    if (memoryMiB > 8192) throw new Error('Crash capture is limited to guests of at most 8 GiB.');
    const space = await statfs(path);
    if (space.bavail * space.bsize < memoryMiB * 1024 ** 2 + GiB)
      throw new Error('Insufficient free disk space for a crash dump plus 1 GiB reserve.');
    // Allow the kernel's short panic trace to finish before freezing its CPU state.
    await delay(1000, undefined, { signal });
    await control.command('stop', undefined, signal);
    report.cpus = await control.command('query-cpus-fast', undefined, signal);
    const registers = [];
    for (let cpu = 0; cpu < Math.min(vcpus, 8); cpu++) {
      registers.push({
        cpu,
        registers: await control.command(
          'human-monitor-command',
          { 'command-line': 'info registers', 'cpu-index': cpu },
          signal,
        ),
      });
    }
    report.registers = registers;
    await save();
    await unlink(partial).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await control.command(
      'dump-guest-memory',
      { paging: false, protocol: 'file:' + partial, detach: true, format: 'elf' },
      signal,
    );
    dumping = true;
    while (true) {
      const result = (await control.command('query-dump', undefined, signal)) as {
        status?: string;
        completed?: number;
        total?: number;
      };
      report.memoryDump = result;
      if (result.status === 'completed') break;
      if (result.status !== 'active') throw new Error('Guest memory dump failed.');
      await delay(500, undefined, { signal });
    }
    const file = await open(partial, 'r');
    const header = Buffer.alloc(4);
    try {
      await file.read(header, 0, 4, 0);
    } finally {
      await file.close();
    }
    if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
      throw new Error('Guest dump is not ELF.');
    await chmod(partial, 0o600);
    await unlink(join(path, 'vmcore')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rename(partial, join(path, 'vmcore'));
    report.memoryDumpFile = 'vmcore';
    await writeFile(join(path, 'vmcore.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  } catch (error) {
    report.captureError = error instanceof Error ? error.message : String(error);
    report.partialDump = dumping;
  } finally {
    await save();
  }
  return report;
}
