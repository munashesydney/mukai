import type { streamText } from 'ai';
import type { ReasoningEffort, ReasoningProfile } from '../../shared/reasoning';
import type { ProviderSettings } from '../../shared/ai';
import { ApiError } from '../config';

type Call = Parameters<typeof streamText>[0];
export type ReasoningOptions = NonNullable<Call['providerOptions']>;
export interface ChatReasoningConfig {
  provider: Pick<ProviderSettings, 'kind'>;
  reasoningEffort?: ReasoningEffort;
  reasoningProfile: ReasoningProfile;
  options: ReasoningOptions;
  maxOutputTokens: number;
}

/** SDK manual thinking adds budget_tokens to maxOutputTokens. Reserve the sum. */
export function chatOutputReserve(config: ChatReasoningConfig) {
  const thinking = config.options.anthropic?.thinking as
    { type?: string; budgetTokens?: number } | undefined;
  return config.maxOutputTokens + (thinking?.type === 'enabled' ? (thinking.budgetTokens ?? 0) : 0);
}

/** Only chat uses this policy; background memory and compaction keep their own options. */
export function chatReasoningSettings(
  config: ChatReasoningConfig,
  allowance: number,
): Pick<Call, 'reasoning' | 'providerOptions' | 'maxOutputTokens'> {
  const providerOptions: ReasoningOptions = Object.fromEntries(
    Object.entries(config.options).map(([key, value]) => [key, { ...value }]),
  );
  const result: Pick<Call, 'reasoning' | 'providerOptions' | 'maxOutputTokens'> = {
    providerOptions,
    maxOutputTokens: allowance,
  };
  const effort = config.reasoningEffort;
  if (effort === undefined) {
    const thinking = providerOptions.anthropic?.thinking as
      { type?: string; budgetTokens?: number } | undefined;
    if (thinking?.type === 'enabled') {
      const budget = thinking.budgetTokens ?? 0;
      if (allowance < budget + 256)
        throw new ApiError(
          400,
          'Not enough context for the configured thinking budget and response.',
        );
      result.maxOutputTokens = Math.min(config.maxOutputTokens, allowance - budget);
    }
    return result;
  }
  if (effort === 'provider-default') return result;
  const driver = config.reasoningProfile.driver;
  if (driver === 'claude-budget' && effort !== 'none') {
    if (allowance < 1280)
      throw new ApiError(
        400,
        'Thinking requires an output allowance of at least 1,280 tokens. Increase this model’s output limit.',
      );
    const fraction = effort === 'low' ? 0.1 : effort === 'medium' ? 0.3 : 0.6;
    const budget = Math.min(
      32768,
      allowance - 256,
      Math.max(1024, Math.floor(allowance * fraction)),
    );
    providerOptions.anthropic = {
      ...providerOptions.anthropic,
      thinking: { type: 'enabled', budgetTokens: budget },
    };
    result.maxOutputTokens = allowance - budget;
  } else if (driver === 'gemini-budget') {
    providerOptions.google = {
      ...providerOptions.google,
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget:
          effort === 'none'
            ? 0
            : Math.min(
                24576,
                Math.max(
                  128,
                  Math.floor(
                    allowance * (effort === 'low' ? 0.1 : effort === 'medium' ? 0.3 : 0.6),
                  ),
                ),
              ),
      },
    };
  } else if (driver === 'deepseek') {
    providerOptions.mukaiCustom =
      effort === 'none'
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'enabled' }, reasoningEffort: effort };
  } else if (driver === 'effort') {
    providerOptions.mukaiCustom = { reasoningEffort: effort };
  } else if (driver === 'thinking') {
    providerOptions.mukaiCustom = {
      thinking: { type: effort === 'none' ? 'disabled' : 'enabled' },
    };
  } else if (driver === 'qwen') {
    providerOptions.mukaiCustom = {
      enable_thinking: true,
      thinking_budget: Math.min(
        32768,
        Math.max(
          1,
          Math.floor(allowance * (effort === 'low' ? 0.1 : effort === 'medium' ? 0.3 : 0.6)),
        ),
      ),
    };
  } else if (effort === 'max') {
    // Installed AI SDK 7.0.127's shared enum stops at xhigh; native adapters support max.
    if (config.provider.kind === 'anthropic')
      providerOptions.anthropic = {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'max',
      };
    else providerOptions.openai = { ...providerOptions.openai, reasoningEffort: 'max' };
  } else {
    result.reasoning = effort;
  }
  return result;
}
