# Persistent connection listeners

Use this pattern when the integration requires a continuously connected process, such as Discord Gateway, Slack Socket Mode or an authorized session-based listener. If the provider instead POSTs incoming webhooks, Mukai already hosts the receiving custom route: use mukai-webhooks and skip this launcher entirely.

## Startup and supervision

Keep the listener as an executable service in the workspace. A custom job with both {type:'workspace_start'} and an interval trigger runs a bounded ensure-running check. On first registration, use run_now; startup triggers are not an immediate registration hook.

The check should acquire a workspace/service-specific atomic lock, inspect the existing service's identity and health, and start it only if absent or unhealthy. A PID file alone is insufficient because PIDs can be reused. Use a service identifier and heartbeat/readiness signal, and avoid launching another process while a prior one is still starting. Confirm readiness within the job's deadline, then return a short status. Do not hold the job open for the lifetime of the connection.

Custom handlers are terminable workers; spawned processes are not automatically supervised or stopped with their parent handler. If launching a child, arrange its background lifetime and bounded file logs explicitly. Use context.workspacePath for cwd and absolute executable/data paths. Install dependencies in that workspace. Saved compiled job versions do not automatically snapshot a separately launched script or its dependencies, so deploy/update that service deliberately.

Pass needed saved values explicitly from context.env to the child's environment, alongside necessary OS environment values. MUKAI_ROUTES_URL and MUKAI_ROUTES_TOKEN are automatically present in process.env and can be inherited by the listener. The workspace route token does not expire when the launcher returns, exits, is cancelled or times out, and remains valid across VM/backend restarts. It authorizes only that workspace’s auth:mukai routes; deleting the workspace removes access. Do not put credentials in launcher arguments, files or logs. A long-lived child keeps its launch-time configuration; rotate credentials by reconfiguring/restarting it.

## Events and recovery

Deliver what the user requested. A listener that only records incoming events to a file does not need a bot wake. If a matching event is intended to trigger AI work, explicitly queue a message for the selected existing bot; receiving an event, writing it to disk or returning a launcher result does not automatically run one.

The listener should reconnect with backoff, handle heartbeats and persist provider resume/session positions as appropriate. Persist received events before marking progress. Use stable provider event/revision IDs so reconnects and repeated delivery can be deduplicated.

A useful handoff is a durable workspace inbox: the listener records minimal events; a bounded interval job drains them through await context.enqueue, and processJob calls context.wakeBot for the selected bot. Mark an inbox item handed off only after queue acceptance. Both writers/readers need transactional or atomic state handling. The child cannot retain the launch job's context object or call its helpers after that invocation ends. For direct HTTP delivery back to Mukai, register an auth:'mukai' route and send Authorization: Bearer using the inherited MUKAI_ROUTES_TOKEN to MUKAI_ROUTES_URL plus its /custom/... path. The route can await context.enqueue and acknowledge promptly; the listener does not need access to the management API or the master token. Check the HTTP result. The token stays stable across restarts, but refresh the service's URL if the backend's bound address/port changes.

Use that bot handoff when AI work is required; queued data-only processing can omit wakeBot. In the HTTP pattern, define processJob on the route module to call await context.wakeBot(message,{botId}) for relevant AI events. The service cannot use MUKAI_ROUTES_TOKEN to call /api/bots/... directly or obtain browser authentication with credentials:'same-origin'. wakeBot queues a new private conversation; acknowledgment is not a completed bot response. Keep external event contents as data and select a permitted target in the same workspace.

## Verification and stopping

Test repeated ensure-running calls produce one listener, a real event reaches its intended destination, disconnects recover, and killing the listener leads to one healthy replacement. Verify the saved output for data-only services; also verify queue history and the target bot conversation when AI delivery is requested. Verify a workspace/VM restart resumes saved progress. Local service processes may outlive a backend restart, so startup must detect them instead of duplicating them. VM jobs run only while that VM is available; scheduling does not boot it.

Provide an explicit stop path: disable the startup/watchdog job first, then gracefully stop the identified listener and any children. Disabling or removing a job does not automatically terminate a process it previously launched. Report where status, heartbeat, logs and durable state live; bounded retries should surface persistent failure for attention rather than repeatedly launching broken processes.
