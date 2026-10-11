import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureGuestCrash } from './crashCapture';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(enabled = false) {
  const directory = await mkdtemp(join(tmpdir(), 'mukai-crash-'));
  directories.push(directory);
  vi.stubEnv('MUKAI_VM_CRASH_CAPTURE', '');
  if (enabled) await writeFile(join(directory, 'capture-crashes'), 'enabled');
  const command = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === 'query-version') return { qemu: { major: 11, minor: 1, micro: 0 } };
    if (name === 'human-monitor-command') return 'RIP=deadbeef';
    if (name === 'dump-guest-memory')
      await writeFile(String(args?.protocol).slice(5), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    if (name === 'query-dump') return { status: 'completed', completed: 4, total: 4 };
    return {};
  });
  return { directory, command };
}
it('records a panic without dumping memory unless the workspace opted in', async () => {
  const { directory, command } = await fixture();
  await captureGuestCrash(directory, { command }, { qemuPid: 123 }, 1, 2);
  expect(JSON.parse(await readFile(join(directory, 'crash', 'latest.json'), 'utf8'))).toMatchObject(
    { qemuPid: 123, memoryCaptureEnabled: false },
  );
  expect(command.mock.calls.map(([name]) => name)).toEqual(['query-version']);
});
it('freezes the guest, captures each CPU and publishes a completed ELF dump', async () => {
  const { directory, command } = await fixture(true);
  await captureGuestCrash(directory, { command }, { qemuPid: 123 }, 1, 2);
  expect(
    command.mock.calls
      .filter(([name]) => name === 'human-monitor-command')
      .map(([, args]) => args?.['cpu-index']),
  ).toEqual([0, 1]);
  expect(command.mock.calls.findIndex(([name]) => name === 'stop')).toBeLessThan(
    command.mock.calls.findIndex(([name]) => name === 'dump-guest-memory'),
  );
  expect(await readFile(join(directory, 'crash', 'vmcore'))).toEqual(
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  );
  expect(JSON.parse(await readFile(join(directory, 'crash', 'vmcore.json'), 'utf8'))).toMatchObject(
    { qemuPid: 123, memoryDumpFile: 'vmcore', memoryDump: { status: 'completed' } },
  );
});
it('preserves the previous completed dump if QEMU cannot produce another', async () => {
  const { directory, command } = await fixture(true);
  await mkdir(join(directory, 'crash'));
  await writeFile(join(directory, 'crash', 'vmcore'), 'previous-crash');
  command.mockImplementation(async (name: string) => {
    if (name === 'dump-guest-memory') throw new Error('Dump not supported');
    return {};
  });
  await captureGuestCrash(directory, { command }, { qemuPid: 456 }, 1, 2);
  expect(await readFile(join(directory, 'crash', 'vmcore'), 'utf8')).toBe('previous-crash');
  expect(JSON.parse(await readFile(join(directory, 'crash', 'latest.json'), 'utf8'))).toMatchObject(
    { qemuPid: 456, captureError: 'Dump not supported' },
  );
});
