import { describe, expect, it, vi } from 'vitest';
import { CodeExecutionRuntime, type CodeToolBridge } from './runtime';
import { toolCatalog } from '../registry';
import { workspaceToolIds } from '../../../shared/toolAssignments';

const run = (
  code: string,
  bridge: CodeToolBridge = { names: () => [], call: async () => null },
  signal = new AbortController().signal,
  timeout = 2000,
) => new CodeExecutionRuntime().run(code, timeout, 'parent', signal, bridge);

describe('isolated code execution', () => {
  it('registers its own family', () => {
    expect(workspaceToolIds).toContain('execute_code');
    expect(toolCatalog().find((x) => x.id === 'execute_code')).toMatchObject({
      name: 'Code Execution',
      actions: ['execute'],
    });
  });

  it('processes full intermediate data and returns only explicit output', async () => {
    const data = Array.from({ length: 10000 }, (_, i) => ({
      i,
      text: 'unprinted-intermediate-data'.repeat(5),
    }));
    const call = vi.fn(async () => ({ rows: data }));
    const result = await run(
      'const r = await tools.web_search({query:"x"}); print(r.rows.length, r.rows.at(-1).i);',
      { names: () => ['web_search'], call },
    );
    expect(result).toMatchObject({ ok: true, output: '10000 9999\n', toolCalls: 1 });
    expect(result.output).not.toContain('unprinted');
    expect(call).toHaveBeenCalledWith(
      'web_search',
      { query: 'x' },
      'parent:code:1',
      expect.any(AbortSignal),
    );
  });

  it('supports dependent calls and parallel independent calls', async () => {
    const result = await run(
      `const values = await Promise.all([1,2,3].map(i => tools.web_search({i}))); print(values.reduce((sum,x)=>sum+x,0)); print(await tools.web_search({i:values[2]}));`,
      {
        names: () => ['web_search'],
        call: async (_name, input) => Number((input as { i: number }).i) * 2,
      },
    );
    expect(result).toMatchObject({ ok: true, output: '12\n12\n', toolCalls: 4 });
  });

  it('does not expose Node, host globals, imports or recursive tools', async () => {
    const result = await run(
      'print(typeof process, typeof require, typeof fetch, typeof Buffer, typeof tools.execute_code); try { await import("node:fs"); } catch(e) { print("imports blocked"); }',
    );
    expect(result).toMatchObject({
      ok: true,
      output: 'undefined undefined undefined undefined undefined\nimports blocked\n',
    });
    const escape = await run('print(print.constructor("return typeof process")());');
    expect(escape.output).toBe('undefined\n');
  });

  it('starts fresh and does not return the value of a script', async () => {
    expect(await run('globalThis.secret = 42; return "do not return this";')).toMatchObject({
      ok: true,
      output: '',
    });
    expect(await run('print(typeof secret);')).toMatchObject({ ok: true, output: 'undefined\n' });
  });

  it('bounds final output without truncating tool responses', async () => {
    const result = await run('print("x".repeat(200000));');
    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(96000);
    expect(result.output).toContain('truncated');
  });

  it('returns useful script errors and preserves earlier output', async () => {
    expect(await run('print("before"); throw new Error("broken script");')).toMatchObject({
      ok: false,
      status: 'error',
      output: 'before\n',
      error: expect.stringContaining('broken script'),
    });
    expect(await run('const =')).toMatchObject({ ok: false, status: 'error' });
  });

  it('terminates infinite computation and supports Stop', async () => {
    const controller = new AbortController();
    const running = run('while(true) {}', undefined, controller.signal);
    setTimeout(() => controller.abort(), 150);
    expect(await running).toMatchObject({ ok: false, status: 'interrupted' });
    const timeout = await run('while(true) {}', undefined, undefined, 150);
    expect(timeout.ok).toBe(false);
    expect(timeout.status).toBe('timeout');
  });

  it('pauses the computation deadline while awaiting a tool and passes cancellation through', async () => {
    const result = await run(
      'await tools.web_search({}); print("done");',
      {
        names: () => ['web_search'],
        call: async () => {
          await new Promise((resolve) => setTimeout(resolve, 450));
          return {};
        },
      },
      undefined,
      300,
    );
    expect(result).toMatchObject({ ok: true, output: 'done\n' });
    const controller = new AbortController();
    let nestedSignal: AbortSignal | undefined;
    const promise = run(
      'await tools.web_search({});',
      {
        names: () => ['web_search'],
        call: async (_name, _input, _id, signal) => {
          nestedSignal = signal;
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          return {};
        },
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(nestedSignal).toBeDefined());
    controller.abort();
    expect(await promise).toMatchObject({ status: 'interrupted' });
    expect(nestedSignal?.aborted).toBe(true);
  });

  it('bounds internal calls and rechecks tool availability', async () => {
    const result = await run('for(let i=0;i<51;i++) await tools.web_search({});', {
      names: () => ['web_search'],
      call: async () => ({}),
    });
    expect(result).toMatchObject({
      ok: false,
      toolCalls: 50,
      error: expect.stringContaining('tool-call limit'),
    });
    let available = true;
    const denied = await run('await tools.web_search({}); await tools.web_search({});', {
      names: () => (available ? ['web_search'] : []),
      call: async () => {
        available = false;
        return {};
      },
    });
    expect(denied).toMatchObject({ ok: false, error: expect.stringContaining('unavailable') });
  });

  it('reports memory exhaustion and rejects unfinished asynchronous work', async () => {
    expect(await run('new ArrayBuffer(128 * 1024 * 1024);')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/memory/i),
    });
    expect(await run('await new Promise(() => {});')).toMatchObject({
      ok: false,
      error: expect.stringContaining('no pending tool calls'),
    });
    expect(
      await run('tools.web_search({});', {
        names: () => ['web_search'],
        call: async (_n, _i, _id, signal) => {
          if (!signal.aborted)
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          return {};
        },
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('Await every tool call') });
    expect(await run('throw null;')).toMatchObject({ ok: false, error: 'null' });
  });
});
