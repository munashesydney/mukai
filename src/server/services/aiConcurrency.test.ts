import { expect, it, vi } from 'vitest';
import { generateText, streamText, tool, wrapLanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { AIConcurrency } from './aiConcurrency';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const signal = () => new AbortController().signal;

it('shares FIFO capacity across workspaces and kinds, supports live limits, and removes canceled waiters', async () => {
  let limit = 2;
  const pool = new AIConcurrency(
    () => limit,
    (id) => `Workspace ${id}`,
  );
  const gates = Array.from({ length: 6 }, deferred);
  const order: number[] = [];
  const controller = new AbortController();
  const tasks = gates.map((gate, index) =>
    pool
      .run(
        {
          kind: index % 2 ? 'memory' : 'chat',
          workspaceId: String(index),
          messageId: String(index),
        },
        index === 4 ? controller.signal : signal(),
        async () => {
          order.push(index);
          await gate.promise;
        },
      )
      .catch((error) => error),
  );
  await vi.waitFor(() => expect(order).toEqual([0, 1]));
  expect(pool.snapshot().running.map((work) => work.workspaceName)).toEqual([
    'Workspace 0',
    'Workspace 1',
  ]);
  expect(pool.waiting('4')).toBe(true);
  controller.abort(new Error('Canceled queued chat'));
  expect(await tasks[4]).toMatchObject({ message: 'Canceled queued chat' });
  expect(pool.waiting('4')).toBe(false);
  limit = 3;
  pool.drain();
  await vi.waitFor(() => expect(order).toEqual([0, 1, 2]));
  limit = 1;
  pool.drain();
  gates[0].resolve();
  gates[1].resolve();
  await Promise.all(tasks.slice(0, 2));
  expect(order).toEqual([0, 1, 2]);
  gates[2].resolve();
  await vi.waitFor(() => expect(order).toEqual([0, 1, 2, 3]));
  gates.forEach((gate) => gate.resolve());
  await Promise.all(tasks);
  expect(order).toEqual([0, 1, 2, 3, 5]);
  expect(pool.snapshot()).toMatchObject({ running: [], queued: [] });
});

it('reuses the same permit for nested memory work and releases failures and shutdown waiters', async () => {
  const pool = new AIConcurrency(() => 1);
  await pool.run({ kind: 'memory', workspaceId: 'one' }, signal(), () =>
    pool.run({ kind: 'memory' }, signal(), async () => {
      expect(pool.snapshot().running).toHaveLength(1);
    }),
  );
  await expect(
    pool.run({ kind: 'compaction' }, signal(), async () => {
      throw new Error('Failed');
    }),
  ).rejects.toThrow('Failed');
  expect(pool.snapshot().running).toEqual([]);
  const gate = deferred();
  const first = pool.run({ kind: 'chat' }, signal(), () => gate.promise);
  const next = pool.run({ kind: 'chat' }, signal(), async () => {}).catch((error) => error);
  pool.close();
  expect(await next).toMatchObject({ message: 'AI scheduler is shutting down.' });
  gate.resolve();
  await first;
});

it('releases a streamed parent before delegated tool inference so a limit of one cannot deadlock', async () => {
  const pool = new AIConcurrency(() => 1);
  let maximum = 0;
  const model = (workspaceId: string) =>
    wrapLanguageModel({
      model: createOpenAICompatible({
        name: 'fixture',
        baseURL: 'https://fixture.invalid/v1',
        fetch: async (_url, init) => {
          maximum = Math.max(maximum, pool.snapshot().running.length);
          const input = JSON.parse(String(init?.body));
          if (!input.stream)
            return Response.json({
              id: 'child',
              model: 'fixture',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Child result' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
          const event = {
            id: 'parent',
            model: 'fixture',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-child',
                      type: 'function',
                      function: { name: 'delegate', arguments: '{}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          };
          return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        },
      })('fixture'),
      middleware: pool.middleware({ workspaceId }),
    });
  const result = streamText({
    model: model('parent'),
    prompt: 'Delegate',
    tools: {
      delegate: tool({
        inputSchema: z.object({}),
        execute: async () => {
          expect(pool.snapshot().running).toHaveLength(0);
          return (await generateText({ model: model('child'), prompt: 'Check', maxRetries: 0 }))
            .text;
        },
      }),
    },
    maxRetries: 0,
  });
  const steps = await result.steps;
  expect(steps[0].toolResults[0].output).toBe('Child result');
  expect(maximum).toBe(1);
  expect(pool.snapshot()).toMatchObject({ running: [], queued: [] });
});
