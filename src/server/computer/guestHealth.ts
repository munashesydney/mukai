import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const GUEST_HEALTH_INTERVAL_MS = 10000;
export const GUEST_HEALTH_LOG_LIMIT = 1024 * 1024;
const nullableNumber = z.number().finite().nonnegative().nullable();
const pressureLine = z.object({
  avg10: z.number().finite().nonnegative(),
  avg60: z.number().finite().nonnegative(),
  avg300: z.number().finite().nonnegative(),
  totalMicroseconds: z.number().finite().nonnegative(),
});
const pressure = z.object({ some: pressureLine.nullable(), full: pressureLine.nullable() });
export const guestHealthSchema = z.object({
  version: z.literal(1),
  sampledAt: z.iso.datetime(),
  uptimeSeconds: nullableNumber,
  bridgePid: z.number().int().positive(),
  workerPid: z.number().int().positive().nullable(),
  memory: z.object({
    totalKiB: nullableNumber,
    availableKiB: nullableNumber,
    swapTotalKiB: nullableNumber,
    swapFreeKiB: nullableNumber,
  }),
  loadAverage: z.tuple([nullableNumber, nullableNumber, nullableNumber]).nullable(),
  pressure: z.object({
    memory: pressure.nullable(),
    cpu: pressure.nullable(),
    io: pressure.nullable(),
  }),
  oomKillCount: nullableNumber,
  processes: z
    .array(
      z.object({
        pid: z.number().int().positive(),
        comm: z.string().max(80),
        rssKiB: z.number().finite().nonnegative(),
      }),
    )
    .max(8),
  errors: z.array(z.string().max(80)).max(8),
});
export type GuestHealth = z.infer<typeof guestHealthSchema>;

function number(value: string | undefined): number | null {
  if (value === undefined || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function parsePressure(value: string | undefined): z.infer<typeof pressure> | null {
  if (value === undefined) return null;
  const result: z.infer<typeof pressure> = { some: null, full: null };
  for (const line of value.split('\n')) {
    const [kind, ...fields] = line.trim().split(/\s+/);
    if (kind !== 'some' && kind !== 'full') continue;
    const values = Object.fromEntries(fields.map((field) => field.split('=')));
    const parsed = pressureLine.safeParse({
      avg10: number(values.avg10),
      avg60: number(values.avg60),
      avg300: number(values.avg300),
      totalMicroseconds: number(values.total),
    });
    if (parsed.success) result[kind] = parsed.data;
  }
  return result;
}

/** Reads kernel counters and executable names, never command lines or environment variables. */
export async function collectGuestHealth(
  options: {
    procDirectory?: string;
    bridgePid?: number;
    workerPid?: number | null;
  } = {},
): Promise<GuestHealth> {
  const directory = options.procDirectory || '/proc';
  const errors: string[] = [];
  const signal = AbortSignal.timeout(3000);
  const read = async (name: string, report = true) => {
    try {
      return await readFile(join(directory, name), { encoding: 'utf8', signal });
    } catch {
      if (report && errors.length < 8) errors.push('unavailable:' + name);
      return undefined;
    }
  };
  const [meminfo, uptime, loadavg, vmstat, memoryPressure, cpuPressure, ioPressure] =
    await Promise.all([
      read('meminfo'),
      read('uptime'),
      read('loadavg'),
      read('vmstat'),
      read('pressure/memory'),
      read('pressure/cpu'),
      read('pressure/io'),
    ]);
  const memoryValue = (name: string) =>
    number(meminfo?.match(new RegExp('^' + name + ':\\s+(\\d+)', 'm'))?.[1]);
  let pids: string[] = [];
  try {
    // Bound work even when a guest has an unusually large process table.
    pids = (await readdir(directory)).filter((name) => /^\d+$/.test(name)).slice(0, 256);
  } catch {
    if (errors.length < 8) errors.push('unavailable:processes');
  }
  const processes: GuestHealth['processes'] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, pids.length) }, async () => {
      while (next < pids.length && !signal.aborted) {
        const pid = pids[next++];
        const status = await read(pid + '/status', false);
        const rssKiB = number(status?.match(/^VmRSS:\s+(\d+)/m)?.[1]);
        const comm = status?.match(/^Name:\s+(.+)$/m)?.[1];
        if (rssKiB !== null && comm)
          processes.push({ pid: Number(pid), comm: comm.slice(0, 80), rssKiB });
      }
    }),
  );
  processes.sort((a, b) => b.rssKiB - a.rssKiB);
  const loads = loadavg?.trim().split(/\s+/).slice(0, 3).map(number);
  return guestHealthSchema.parse({
    version: 1,
    sampledAt: new Date().toISOString(),
    uptimeSeconds: number(uptime?.split(/\s+/)[0]),
    bridgePid: options.bridgePid ?? process.pid,
    workerPid: options.workerPid ?? null,
    memory: {
      totalKiB: memoryValue('MemTotal'),
      availableKiB: memoryValue('MemAvailable'),
      swapTotalKiB: memoryValue('SwapTotal'),
      swapFreeKiB: memoryValue('SwapFree'),
    },
    loadAverage: loads?.length === 3 ? loads : null,
    pressure: {
      memory: parsePressure(memoryPressure),
      cpu: parsePressure(cpuPressure),
      io: parsePressure(ioPressure),
    },
    oomKillCount: number(vmstat?.match(/^oom_kill\s+(\d+)$/m)?.[1]),
    processes: processes.slice(0, 8),
    errors,
  });
}

/** Two bounded root-only JSONL files retain evidence across a VM reboot. */
export class GuestHealthLog {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private directory = '/var/log/mukai-guest',
    private limit = GUEST_HEALTH_LOG_LIMIT,
  ) {}
  append(health: GuestHealth) {
    const task = this.pending
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const file = join(this.directory, 'health.log');
        const line = JSON.stringify(guestHealthSchema.parse(health)) + '\n';
        if (Buffer.byteLength(line) > this.limit) return;
        const size = (await stat(file).catch(() => undefined))?.size || 0;
        if (size + Buffer.byteLength(line) > this.limit) {
          await unlink(file + '.1').catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
          await rename(file, file + '.1');
        }
        await appendFile(file, line, { mode: 0o600 });
      });
    this.pending = task;
    return task;
  }
}
