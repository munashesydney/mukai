import { describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  reasoningProfile,
  supportsReasoning,
  reasoningChoiceLabel,
  effectiveReasoning,
  type ReasoningEffort,
} from '../../shared/reasoning';
import type { ProviderSettings } from '../../shared/ai';
import {
  chatOutputReserve,
  chatReasoningSettings,
  type ChatReasoningConfig,
} from './reasoningOptions';
import { chatGPTRequest } from './chatgptTransport';
import { ContextManager } from './contextPolicy';

function config(
  kind: ProviderSettings['kind'],
  id: string,
  reasoningEffort?: ReasoningEffort,
  baseUrl = '',
): ChatReasoningConfig {
  const provider = { kind, baseUrl, defaultModel: id };
  return {
    provider,
    reasoningEffort,
    reasoningProfile: reasoningProfile(provider, id),
    maxOutputTokens: 8192,
    options: {},
  };
}

async function request(
  kind: ProviderSettings['kind'],
  id: string,
  effort: ReasoningEffort,
  baseUrl = '',
) {
  let body:
    | (Record<string, unknown> & {
        reasoning: { effort: string };
        thinking: { budget_tokens: number };
        max_tokens: number;
      })
    | undefined;
  const fetchStub: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    throw new Error('Inspection only. No network.');
  };
  const options = { apiKey: 'test-only', fetch: fetchStub };
  const model =
    kind === 'openai' || kind === 'chatgpt'
      ? createOpenAI(options).responses(id)
      : kind === 'anthropic'
        ? createAnthropic(options)(id)
        : kind === 'google'
          ? createGoogleGenerativeAI(options)(id)
          : createOpenAICompatible({
              ...options,
              name: 'mukai-custom',
              baseURL: 'https://test.invalid/v1',
            })(id);
  try {
    await model.doGenerate({
      ...chatReasoningSettings(config(kind, id, effort, baseUrl), 8192),
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
    });
  } catch {
    /* The fetch stub terminates before network access. */
  }
  expect(body).toBeDefined();
  return body!;
}

describe('Reasoning capabilities', () => {
  it('scopes compatible support by endpoint and model and validates exact native tiers', () => {
    const provider = {
      kind: 'compatible' as const,
      baseUrl: 'https://api.z.ai/api/paas/v4',
      defaultModel: 'glm-5.3',
    };
    expect(reasoningProfile(provider, provider.defaultModel).levels).toEqual([
      'low',
      'high',
      'max',
    ]);
    expect(supportsReasoning(provider, 'glm-5.3', 'none')).toBe(false);
    expect(
      reasoningProfile({ ...provider, baseUrl: 'http://localhost:11434/v1' }, 'glm-5.3').levels,
    ).toEqual([]);
    expect(
      reasoningProfile(
        {
          ...provider,
          baseUrl: 'http://localhost:11434/v1',
          models: [
            {
              id: 'custom',
              name: 'Custom',
              maxOutputTokens: 8192,
              contextWindowTokens: 128000,
              supportsImages: false,
              customReasoning: { supportedEfforts: ['low', 'high'] },
            },
          ],
        },
        'custom',
      ).levels,
    ).toEqual(['low', 'high']);
    expect(
      reasoningProfile(
        {
          kind: 'chatgpt',
          baseUrl: '',
          defaultModel: 'gpt-6.1-sol',
          models: [
            {
              id: 'gpt-6.1-sol',
              name: 'Sol',
              contextWindowTokens: 128000,
              maxOutputTokens: 8192,
              supportsImages: false,
              reasoningEfforts: ['none', 'minimal', 'high', 'high'],
            },
          ],
        },
        'gpt-6.1-sol',
      ).levels,
    ).toEqual(['high']);
    expect(
      reasoningProfile({ ...provider, baseUrl: 'https://api.moonshot.ai/v1' }, 'kimi-k2.7-code')
        .levels,
    ).toEqual([]);
    expect(
      reasoningChoiceLabel(
        { ...provider, baseUrl: 'https://api.xiaomimimo.com/v1' },
        'mimo-v2.6-pro',
        'high',
      ),
    ).toBe('Thinking on');
  });
  it('uses advertised account capabilities and distinguishes inheritance from provider default', () => {
    const saved = {
      id: 'new-model',
      name: 'New',
      maxOutputTokens: 8192,
      contextWindowTokens: 128000,
      supportsImages: false,
      reasoningEffort: 'low' as const,
      reasoningEfforts: ['low', 'high'] as const,
    };
    expect(
      reasoningProfile(
        {
          kind: 'chatgpt',
          baseUrl: '',
          defaultModel: saved.id,
          models: [{ ...saved, reasoningEfforts: [...saved.reasoningEfforts] }],
        },
        saved.id,
      ).levels,
    ).toEqual(['low', 'high']);
    expect(
      effectiveReasoning(
        { reasoningEffort: null },
        { ...saved, reasoningEfforts: [...saved.reasoningEfforts] },
      ),
    ).toBe('low');
    expect(
      effectiveReasoning(
        { reasoningEffort: 'provider-default' },
        { ...saved, reasoningEfforts: [...saved.reasoningEfforts] },
      ),
    ).toBe('provider-default');
  });
});

describe('Direct SDK request serialization', () => {
  it('sends OpenAI effort without a gateway and preserves it through the ChatGPT transport', async () => {
    expect(
      supportsReasoning(
        { kind: 'openai', baseUrl: '', defaultModel: 'gpt-5.6-sol' },
        'gpt-5.6-sol',
        'max',
      ),
    ).toBe(true);
    const body = await request('openai', 'gpt-6.1-sol', 'max');
    expect(body.reasoning.effort).toBe('max');
    expect(chatGPTRequest(body).reasoning).toMatchObject({ effort: 'max' });
    expect((await request('openai', 'gpt-5.4', 'high')).reasoning.effort).toBe('high');
    expect((await request('openai', 'gpt-5.4', 'provider-default')).reasoning).toBeUndefined();
  });
  it('sends Claude adaptive/native max and bounds legacy thinking within the full output allowance', async () => {
    expect(await request('anthropic', 'claude-opus-4-6', 'max')).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' },
      max_tokens: 8192,
    });
    expect(await request('anthropic', 'claude-sonnet-4-6', 'high')).toMatchObject({
      output_config: { effort: 'high' },
    });
    const low = await request('anthropic', 'claude-sonnet-4-5-20250929', 'low');
    const high = await request('anthropic', 'claude-sonnet-4-5-20250929', 'high');
    expect(high.thinking.budget_tokens).toBeGreaterThan(low.thinking.budget_tokens);
    expect(high.max_tokens).toBe(8192);
    expect(low.max_tokens).toBe(8192);
    expect(() =>
      chatReasoningSettings(config('anthropic', 'claude-sonnet-4-5-20250929', 'high'), 1024),
    ).toThrow('1,280');
  });
  it('uses Gemini levels and output-bounded budgets while retaining thought summaries', async () => {
    expect(await request('google', 'gemini-3-flash-preview', 'high')).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
    });
    expect(await request('google', 'gemini-2.5-flash', 'high')).toMatchObject({
      generationConfig: {
        maxOutputTokens: 8192,
        thinkingConfig: { includeThoughts: true, thinkingBudget: 4915 },
      },
    });
    expect(await request('google', 'gemini-2.5-flash', 'none')).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    });
  });
  it.each([
    ['https://api.deepseek.com', 'deepseek-flash', 'none', { thinking: { type: 'disabled' } }],
    [
      'https://api.deepseek.com',
      'deepseek-v4-pro',
      'max',
      { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
    ],
    ['https://api.z.ai/api/paas/v4', 'glm-5.3', 'low', { reasoning_effort: 'low' }],
    ['https://api.moonshot.ai/v1', 'kimi-k3', 'max', { reasoning_effort: 'max' }],
    ['https://api.xiaomimimo.com/v1', 'mimo-v2.6-pro', 'high', { thinking: { type: 'enabled' } }],
    [
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      'qwen3.8-max',
      'low',
      { enable_thinking: true, thinking_budget: 819 },
    ],
  ] as const)('sends native controls for %s %s', async (url, id, effort, expected) => {
    expect(await request('compatible', id, effort, url)).toMatchObject(expected);
  });
  it('reserves the existing legacy budget without mutating settings or leaking chat effort', () => {
    const legacy = {
      ...config('anthropic', 'claude-sonnet-4-5-20250929'),
      options: { anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } } },
    };
    expect(chatOutputReserve(legacy)).toBe(10240);
    expect(chatReasoningSettings(legacy, 10240).maxOutputTokens).toBe(8192);
    const manager = new ContextManager(16384, 8192, 100, async () => '', 2048);
    const allowance = manager.outputAllowance([]);
    expect(allowance).toBe(4096);
    expect(chatReasoningSettings(legacy, allowance).maxOutputTokens).toBe(2048);
    expect(() => chatReasoningSettings(legacy, 2048)).toThrow('Not enough context');
    const explicit = config('anthropic', 'claude-opus-4-6', 'max');
    chatReasoningSettings(explicit, 8192);
    expect(explicit.options).toEqual({});
    expect(
      chatReasoningSettings(config('compatible', 'custom', 'provider-default'), 8192)
        .providerOptions,
    ).toEqual({});
  });
});
