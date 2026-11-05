# Code Execution

The **Code Execution** family exposes `execute_code({code, timeoutMs?})`. It is enabled by default and can be assigned independently of System in Tools. Shared backend support makes it available to desktop, browser, CLI and phone chats.

The model writes a JavaScript body with top-level `await`. An isolated QuickJS interpreter runs it in a terminable worker. The interpreter has JavaScript built-ins, `tools`, `print` and `console.log/info/warn/error`; it has no Node APIs, imports, direct filesystem/network access, environment variables or provider credentials. Each call starts fresh. Persistent kernels and third-party packages are not included.

```js
const response = await tools.file_operations({
  action: 'search_files',
  query: 'TODO',
  path: 'src',
});
if (!response.ok) throw new Error(JSON.stringify(response));
// File responses are flat on local workspaces and nested in result on VMs.
const data = response.result ?? response;
const counts = {};
for (const match of data.matches) {
  counts[match.path] = (counts[match.path] ?? 0) + 1;
}
print({ counts, truncated: data.truncated });
```

Use this for loops, conditional calls, filtering and aggregation. Direct calls are still useful for simple actions and observations the model needs to inspect, such as screenshots. Code can select excerpts for the model, but cannot replace semantic reasoning over omitted content.

## Tool bridge

`Object.keys(tools)` lists supported tools available in the current run. The first version supports `file_operations`, `web_search`, `browser`, `terminal` and `process`. Only assigned and available tools are exposed. Internal calls use the existing schemas, permission guards, approvals, activity tracking, artifact/file recording, cancellation and call budgets. Access is checked again when execution begins. Unsupported tools, custom tools, recursive execution, registration, delegation and response control are not exposed.

Internal calls return structured execution results before `toModelOutput` or model-context truncation. Only explicitly printed output enters the model's next request. Normal tool pagination, source limits and operational safeguards still apply. Internal data consumes runtime memory rather than model context; it is not unlimited. Activity previews remain bounded separately and are saved in the conversation. Nested activities carry `parentToolCallId`; automatic history and retry reconstruction retain their operation statuses while omitting intermediate previews, terminal output and target details. The saved previews remain available in the UI for deliberate inspection.

Every call must be awaited. `Promise.all` supports independent work. There are no detached JavaScript tasks. A returned tool result can indicate failure or denial without throwing; inspect it before reporting success. Terminal processes retain the normal Terminal lifecycle.

## Limits and recovery

- 64 MiB interpreter heap, 512 KiB interpreter stack, at most eight active workers per backend.
- 50 internal tool calls per execution, plus existing per-run tool budgets.
- Computation timeout: 30 seconds by default, configurable from 100 ms to five minutes. Tool and human approval waits do not consume the computation allowance. Underlying tools retain their own timeouts.
- Printed output is bounded at 96,000 bytes and then passes through the same context limits as any other final tool result. Overflow is explicitly marked.
- Results include `ok`, `status`, `output`, optional `error`, `toolCalls` and `durationMs`. Output printed before a failure is retained.

Stop terminates the interpreter, cancels internal waits and waits for host operations to settle. Errors and interruptions can leave completed actions; they are not rolled back. The parent script is checkpointed as running before execution. Internal calls are visible activities, not separately replayable model calls. After a restart, a running script is reported as uncertain, its nested approvals are discarded, and neither the script nor its internal actions are automatically replayed. Inspect saved activity and actual state before retrying.

`src/server/tools/code-execution/codeExecution.test.ts` exercises the interpreter and bridge. `src/server/codeExecution.test.ts` exercises the real chat/AI SDK path for local and guest-dispatched VM tools, output selection, approval/denial, assignments, Stop and restart behavior.

`npm run test:code-execution:electron` packs the worker and its dependencies into an ASAR and checks JavaScript execution and full internal responses under the installed Electron runtime.
