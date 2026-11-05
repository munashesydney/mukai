import { expect, it, vi } from 'vitest';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, wrapLanguageModel, type ModelMessage } from 'ai';
import { AIConcurrency } from './aiConcurrency';
import { runtimeTimeMiddleware } from './runtimeTimeMiddleware';
import { buildBotRuntimeContext } from '../../shared/botSystemPrompt';

it('refreshes after the provider queue, preserves retry payloads and history, and picks up a changed zone on the next step', async () => {
  const requests: unknown[] = [];
  let zone = 'UTC';
  let now = '2025-01-16T07:30:00Z';
  const pool = new AIConcurrency(() => 1);
  const adapter = createOpenAICompatible({
    name: 'fixture',
    baseURL: 'https://fixture.invalid/v1',
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: 'clock',
        model: 'clock',
        created: 1,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  })('clock');
  const model = wrapLanguageModel({
    model: adapter,
    middleware: [
      pool.middleware(),
      runtimeTimeMiddleware(
        () => zone,
        () => now,
      ),
    ],
  });
  let release!: () => void;
  const occupied = pool.run(
    { kind: 'memory' },
    new AbortController().signal,
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  await vi.waitFor(() => expect(pool.snapshot().running).toHaveLength(1));
  const historical = buildBotRuntimeContext({
    now: '2025-01-15T01:00:00Z',
    timeZone: 'UTC',
    pursuits: [],
    previousOperations: false,
  });
  const pending = buildBotRuntimeContext({
    now: '2025-01-16T07:00:00Z',
    timeZone: 'UTC',
    pursuits: [],
    previousOperations: false,
    notice: 'Preserve me.',
  });
  const messages: ModelMessage[] = [
    { role: 'user', content: historical },
    { role: 'assistant', content: 'Earlier.' },
    { role: 'user', content: 'What day is it?' },
    { role: 'user', content: pending },
  ];
  const original = JSON.stringify(messages);
  const generation = generateText({ model, messages, maxRetries: 0 });
  await vi.waitFor(() => expect(pool.snapshot().queued).toHaveLength(1));
  zone = 'America/Vancouver';
  release();
  await occupied;
  await generation;
  expect(JSON.stringify(requests[0])).toContain('2025-01-15T23:30:00-08:00');
  expect(JSON.stringify(requests[0])).toContain('Preserve me.');
  expect(JSON.stringify(requests[0])).toContain(historical.replaceAll('\n', '\\n'));
  expect(JSON.stringify(messages)).toBe(original);
  now = '2025-01-16T08:30:00Z';
  zone = 'Asia/Tokyo';
  // A transport retry of the same pending snapshot remains identical.
  await generateText({ model, messages, maxRetries: 0 });
  expect(requests[1]).toEqual(requests[0]);
  await generateText({
    model,
    messages: [
      ...messages,
      { role: 'assistant', content: 'Continuing.' },
      {
        role: 'user',
        content: buildBotRuntimeContext({
          now,
          timeZone: zone,
          pursuits: [],
          previousOperations: false,
        }),
      },
    ],
    maxRetries: 0,
  });
  expect(JSON.stringify(requests[2])).toContain('2025-01-16T17:30:00+09:00');
  expect(JSON.stringify(requests[2])).toContain('Workspace timezone: Asia/Tokyo');
});
