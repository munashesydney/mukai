import { app } from 'electron';
import assert from 'node:assert/strict';
import { CodeExecutionRuntime } from '../src/server/tools/code-execution/runtime';

void app.whenReady().then(async () => {
  try {
    const runtime = new CodeExecutionRuntime();
    const result = await runtime.run(
      'const r = await tools.web_search({query:"fixture"}); print(r.rows.length, r.rows.at(-1).id, typeof process, typeof require);',
      10000,
      'packaged',
      new AbortController().signal,
      {
        names: () => ['web_search'],
        call: async () => ({
          rows: Array.from({ length: 10000 }, (_, id) => ({ id, text: 'internal'.repeat(50) })),
        }),
      },
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.output, '10000 9999 undefined undefined\n');
    assert.equal(result.toolCalls, 1);
    console.log(
      'PASS: Electron ASAR loads QuickJS/WASM and processes full tool data in isolation.',
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
