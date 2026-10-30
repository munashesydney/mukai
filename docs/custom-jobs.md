# Custom jobs

Tools → **Custom jobs** lists registered jobs, their triggers, saved code, next due time and run history. Use **Run now** to invoke a job manually. Enable, disable, update and delete use the same workspace registry as custom tools and routes. Bots manage them through `register_custom_job`.

Mukai's shared backend owns the scheduler and persists due times in its data directory. Desktop and web clients share it. Job modules execute on their workspace computer: locally for folder workspaces, inside the guest for VM workspaces. No cron daemon or guest timer is installed. Mukai must be running; scheduled jobs wait while a VM is stopped and never boot it. Overdue interval ticks coalesce into one run when the runtime is available.

Existing VM installations need guest revision 20 or newer for workspacePath support (job execution was added in revision 19). Updating the host app alone does not replace an already-running guest worker. With the updated guest bundle present, the next VM start detects older revisions, installs the guest update, and reboots the guest before exposing its runtime to scheduled jobs.

`name` is an identifier matching `^[a-zA-Z][a-zA-Z0-9_]{0,63}$` (for example `heartbeat_job`); `description` holds human-readable text.

Write a `.ts`/`.js` workspace module, then register its path:

```ts
export default {
  name: 'check_pending',
  description: 'Check pending work and wake the owning bot when needed.',
  triggers: [{ type: 'interval', intervalMs: 300_000 }, { type: 'workspace_start' }],
  requiredEnv: ['DESK_API_KEY'],
  timeoutMs: 15_000,
  async run(event, context) {
    const result = await fetch('https://example.com/pending', {
      headers: { Authorization: `Bearer ${context.env.DESK_API_KEY}` },
      signal: context.signal,
    });
    if (!result.ok) throw new Error(`Pending check failed: HTTP ${result.status}`);
    const { tickets } = await result.json();
    if (tickets.length) {
      await context.wakeBot(`${tickets.length} tickets need attention. Inspect the desk.`);
    }
    return { trigger: event.trigger, pendingCount: tickets.length };
  },
};
```

```json
{ "operation": "register", "modulePath": "jobs/check-pending.ts" }
```

`register_custom_job` returns the registration ID. Use that exact ID for `inspect`, `update`, `enable`, `disable`, `remove`, or `run_now`; `list` discovers shared workspace jobs. The saved module version runs until a validated update succeeds. Editing the file alone does not change registered code.

## Triggers

- `{ type: 'interval', intervalMs: 300000 }`: an integer interval between one second and 365 days. The first tick is due one interval after registration. A delayed run schedules its next interval from dispatch time.
- `{ type: 'workspace_start' }`: once per real runtime start. For VM workspaces this means a successful boot with a ready guest worker. For folder workspaces it means backend startup with the connected folder available. Refreshes, bridge reconnections and additional desktop/web clients preserve that identity. Registering or enabling a startup job in a running runtime waits for its next start; use **Run now** to test immediately.
- `{ type: 'once', runAt: '2026-11-01T18:00:00Z' }`: one scheduled attempt at an ISO timestamp with timezone. Use this as the only trigger. Past timestamps run when the workspace becomes available. The attempt is consumed before execution and stays consumed after failure, interruption, restart, disable/enable, or a code-only update. Changing `runAt` explicitly rearms it. A manual run consumes a pending one-shot; subsequent manual runs are deliberate additional invocations.

Interval and startup triggers may be combined. A startup and overdue interval arriving together produce one startup run. Same-job invocations are serialized, including manual runs and queued `processJob` handlers. A second manual invocation while busy fails explicitly. Failures, timeouts, and interruptions are visible in Runs; Mukai does not automatically retry scheduled invocations because code may already have caused external effects. A crash between claiming a due event and executing it can consume that event; this is not an exactly-once guarantee for external effects. Make consequential code idempotent.

## Handler context

`run(event, context)` receives `event.trigger` (`interval`, `workspace_start`, `once`, or `manual`), `event.scheduledAt` (ISO), and a runtime ID for scheduled executions. Context matches the other custom capabilities:

- `context.env`: only declared workspace environment variables, configured through Settings. Returned values and errors use the existing secret-redaction rules.
- `context.workspacePath`: the absolute workspace root on the executing computer. Use `path.join(context.workspacePath, ...)` for file access and pass it as `cwd` when launching a child process. Custom handlers do not inherit the terminal tool’s workspace cwd.
- `context.workspaceId` and `context.signal`: workspace identity and cancellation. Timeouts are 100–30000 ms (default 15000). Mukai terminates the worker when its lifetime ends; use the signal for outgoing requests.
- `await context.wakeBot(message, { botId? })`: durably queues a bot wake-up. Omit `botId` to wake the registration owner. Ownerless registrations need an explicit target. Existing workspace and bot-hierarchy checks apply; acceptance means queued, not that the model finished.
- `await context.callRoute(routeId, request)`: invokes a registered workspace route with the same authentication, request limits, cancellation and cycle protections as tools/routes.
- `await context.enqueue(provider, eventId, payload)`: queues deduplicated background work when the module also declares `processJob(payload, context)`.

Job lists and inspection include `health.lastRun`, `health.consecutiveFailures`, and `health.lastError`. The failure count covers failed/interrupted handler runs since the last successful run, including queued handlers; starting another run does not clear it. Updating code does not erase failure history. Configuration status `ready` means the module can run; it does not mean execution succeeded. Disabled, invalid, and unconfigured jobs report `nextRunAt: null` while retaining internal due/consumption state.

Job registration enables unattended code execution within the user's authorized scope. Modules are trusted code with OS access on their workspace computer, using the same execution boundary as custom tools/routes. Keep module-level initialization free of side effects: validation imports the module but does not call its handlers.
