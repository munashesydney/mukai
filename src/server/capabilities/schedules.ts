import type { CapabilityRegistration, CustomJobEvent } from '../../shared/customCapabilities';
import type { Database } from '../db/database';

/** Durable due times; the shared backend owns the only scheduler for its data directory. */
export class CapabilitySchedules {
  private active = new Set<string>();
  private tasks = new Set<Promise<unknown>>();
  private closing = false;
  constructor(
    private db: Database,
    private runtime: (workspaceId: string) => string | undefined,
    private invoke: (id: string, event: CustomJobEvent) => Promise<unknown>,
  ) {}
  configure(registration: CapabilityRegistration, resetInterval: boolean, resetStartup = false) {
    const interval = registration.definition.triggers?.find((t) => t.type === 'interval');
    const once = registration.definition.triggers?.find((t) => t.type === 'once');
    this.db.run(
      `INSERT INTO capability_schedules VALUES(?,?,?) ON CONFLICT(capability_id) DO UPDATE SET
       next_at=CASE WHEN ? THEN excluded.next_at ELSE capability_schedules.next_at END,
       last_runtime=CASE WHEN ? THEN excluded.last_runtime ELSE capability_schedules.last_runtime END`,
      registration.id,
      once ? Date.parse(once.runAt) : interval ? Date.now() + interval.intervalMs : null,
      this.runtime(registration.workspaceId) || null,
      Number(resetInterval),
      Number(resetStartup),
    );
  }
  busy(id: string) {
    return this.active.has(id);
  }
  async run(id: string, task: () => Promise<unknown>) {
    if (this.closing) throw new Error('Job scheduler is stopping.');
    if (this.active.has(id)) throw new Error('This custom job is already running.');
    this.active.add(id);
    try {
      const execution = task();
      this.tasks.add(execution);
      try {
        return await execution;
      } finally {
        this.tasks.delete(execution);
      }
    } finally {
      this.active.delete(id);
    }
  }
  tick(registrations: CapabilityRegistration[], now = Date.now()) {
    if (this.closing) return;
    for (const registration of registrations) {
      if (this.active.size >= 4) break;
      if (
        registration.kind !== 'job' ||
        registration.status !== 'ready' ||
        this.busy(registration.id)
      )
        continue;
      // Never power up a stopped VM just to run a scheduled job.
      const runtimeId = this.runtime(registration.workspaceId);
      if (!runtimeId) continue;
      const saved = this.db.get(
        'SELECT * FROM capability_schedules WHERE capability_id=?',
        registration.id,
      );
      if (!saved) continue;
      const triggers = registration.definition.triggers || [];
      const interval = triggers.find((t) => t.type === 'interval');
      const once = triggers.find((t) => t.type === 'once');
      const startup =
        triggers.some((t) => t.type === 'workspace_start') && saved.last_runtime !== runtimeId;
      const due = (interval || once) && saved.next_at !== null && Number(saved.next_at) <= now;
      if (!startup && !due) continue;
      // Claim before dispatch. Interrupted work is visible in run history and is never
      // automatically replayed: arbitrary user code can have partial external effects.
      this.db.run(
        'UPDATE capability_schedules SET last_runtime=?,next_at=? WHERE capability_id=?',
        runtimeId,
        interval ? now + interval.intervalMs : null,
        registration.id,
      );
      const event: CustomJobEvent = {
        trigger: startup ? 'workspace_start' : once ? 'once' : 'interval',
        scheduledAt: new Date(startup ? now : Number(saved.next_at)).toISOString(),
        runtimeId,
      };
      void this.invoke(registration.id, event).catch(() => {
        /* Recorded by the capability runtime. */
      });
    }
  }
  async shutdown() {
    this.closing = true;
    await Promise.allSettled([...this.tasks]);
  }
}
