import { expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { buildBotRuntimeContext } from '../../shared/botSystemPrompt';
import { chatGPTRequest } from './chatgptTransport';

it.each(['openai', 'compatible', 'anthropic', 'google', 'chatgpt'] as const)(
  'keeps runtime snapshots after the reusable history in the %s wire payload',
  async (provider) => {
    const requests: Record<string, unknown>[] = [];
    // Capture the real SDK serialization; no network or provider credentials.
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(provider === 'chatgpt' ? chatGPTRequest(body) : body);
      throw new Error('Request captured');
    };
    const settings = { apiKey: 'test', fetch };
    const model =
      provider === 'anthropic'
        ? createAnthropic(settings)('claude-sonnet-4-5')
        : provider === 'google'
          ? createGoogleGenerativeAI(settings)('gemini-2.5-flash')
          : provider === 'compatible'
            ? createOpenAICompatible({
                ...settings,
                name: 'test',
                baseURL: 'https://fixture.invalid',
              })('test')
            : createOpenAI(settings).responses('gpt-4.1');
    const runtime = (now: string): ModelMessage => ({
      role: 'user',
      content: buildBotRuntimeContext({ now, pursuits: [], previousOperations: false }),
    });
    const first: ModelMessage[] = [
      { role: 'user', content: 'Check the saved work.' },
      runtime('2026-10-15T01:00:00Z'),
    ];
    const second: ModelMessage[] = [
      ...first,
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'check', toolName: 'check', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'check',
            toolName: 'check',
            output: { type: 'text', value: 'Verified.' },
          },
        ],
      },
      runtime('2026-10-15T01:01:00Z'),
    ];
    for (const messages of [first, second]) {
      await expect(
        generateText({
          model,
          system: 'Stable instructions.',
          messages,
          tools: { check: tool({ inputSchema: z.object({}) }) },
          maxRetries: 0,
        }),
      ).rejects.toThrow();
    }
    expect(requests).toHaveLength(2);
    const historyKey =
      provider === 'google'
        ? 'contents'
        : provider === 'openai' || provider === 'chatgpt'
          ? 'input'
          : 'messages';
    const before = requests[0][historyKey] as unknown[];
    const after = requests[1][historyKey] as unknown[];
    expect(after.slice(0, before.length)).toEqual(before);
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(JSON.stringify(after.at(-1))).toContain('2026-10-15T01:01:00Z');
    const stable = { ...requests[1], [historyKey]: undefined };
    expect(JSON.stringify(stable)).not.toContain('Runtime UTC now:');
  },
);
