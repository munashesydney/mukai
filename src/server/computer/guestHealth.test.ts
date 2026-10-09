import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGuestHealth, GuestHealthLog, guestHealthSchema } from './guestHealth';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'mukai-health-'));
  directories.push(value);
  return value;
}
async function fixture() {
  const procDirectory = await directory();
  await mkdir(join(procDirectory, 'pressure'));
  await Promise.all(
    Object.entries({
      meminfo:
        'MemTotal: 6291456 kB\nMemAvailable: 524288 kB\nSwapTotal: 2097152 kB\nSwapFree: 1048576 kB\n',
      uptime: '1234.56 789.0\n',
      loadavg: '4.1 2.0 0.5 2/100 123\n',
      vmstat: 'pgfault 1000\noom_kill 2\n',
      'pressure/memory':
        'some avg10=5.20 avg60=3.10 avg300=1.01 total=7890\nfull avg10=1.2 avg60=0.4 avg300=0.1 total=900\n',
      'pressure/cpu': 'some avg10=11.1 avg60=3.2 avg300=0.3 total=999\n',
      'pressure/io':
        'some avg10=2.0 avg60=1.0 avg300=0.2 total=123\nfull avg10=0.0 avg60=0.0 avg300=0.0 total=0\n',
    }).map(([name, value]) => writeFile(join(procDirectory, name), value)),
  );
  return procDirectory;
}

it('captures guest memory, swap, OOM and pressure evidence with bounded process names and no arguments', async () => {
  const procDirectory = await fixture();
  for (let pid = 1; pid <= 10; pid++) {
    await mkdir(join(procDirectory, String(pid)));
    await writeFile(
      join(procDirectory, String(pid), 'status'),
      `Name:\t${pid === 10 ? 'chrome' : 'node'}\nVmRSS:\t${pid * 100} kB\n`,
    );
    await writeFile(join(procDirectory, String(pid), 'cmdline'), 'secret-token=do-not-collect');
  }
  const health = await collectGuestHealth({ procDirectory, bridgePid: 20, workerPid: 21 });
  expect(health.memory).toEqual({
    totalKiB: 6291456,
    availableKiB: 524288,
    swapTotalKiB: 2097152,
    swapFreeKiB: 1048576,
  });
  expect(health.uptimeSeconds).toBe(1234.56);
  expect(health.loadAverage).toEqual([4.1, 2, 0.5]);
  expect(health.oomKillCount).toBe(2);
  expect(health.pressure.memory?.some).toEqual({
    avg10: 5.2,
    avg60: 3.1,
    avg300: 1.01,
    totalMicroseconds: 7890,
  });
  expect(health.pressure.cpu?.full).toBeNull();
  expect(health.processes).toHaveLength(8);
  expect(health.processes[0]).toEqual({ pid: 10, comm: 'chrome', rssKiB: 1000 });
  expect(health.errors).toEqual([]);
  expect(JSON.stringify(health)).not.toContain('secret-token');
  expect(guestHealthSchema.safeParse(health).success).toBe(true);
});

it('reports missing kernel counters as unavailable rather than claiming zero memory or OOM', async () => {
  const procDirectory = await directory();
  await writeFile(join(procDirectory, 'loadavg'), 'NaN -2 Infinity\n');
  const health = await collectGuestHealth({ procDirectory });
  expect(health.memory.availableKiB).toBeNull();
  expect(health.memory.swapTotalKiB).toBeNull();
  expect(health.oomKillCount).toBeNull();
  expect(health.pressure.memory).toBeNull();
  expect(health.loadAverage).toEqual([null, null, null]);
  expect(health.errors).toContain('unavailable:meminfo');
  expect(health.processes).toEqual([]);
});

it('serializes and rotates persistent samples into at most two bounded JSONL files', async () => {
  const procDirectory = await fixture();
  const health = await collectGuestHealth({ procDirectory });
  const logDirectory = join(await directory(), 'logs');
  const limit = Buffer.byteLength(JSON.stringify(health) + '\n') * 2;
  const log = new GuestHealthLog(logDirectory, limit);
  await Promise.all(Array.from({ length: 5 }, () => log.append(health)));
  expect((await readdir(logDirectory)).sort()).toEqual(['health.log', 'health.log.1']);
  for (const file of ['health.log', 'health.log.1']) {
    expect((await stat(join(logDirectory, file))).size).toBeLessThanOrEqual(limit);
    const lines = (await readFile(join(logDirectory, file), 'utf8')).trim().split('\n');
    for (const line of lines) expect(guestHealthSchema.parse(JSON.parse(line))).toEqual(health);
  }
});
