import type { Bot, ProviderSettings, SavedProviderModel } from './ai';
import { findProviderPreset } from './providerPresets';

export const reasoningLevels = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ReasoningLevel = (typeof reasoningLevels)[number];
export const reasoningEfforts = ['provider-default', ...reasoningLevels] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];
export interface CustomReasoning {
  /** Explicit declaration for an otherwise unknown compatible endpoint. */
  supportedEfforts: ReasoningLevel[];
}
export const reasoningLabels: Record<ReasoningEffort, string> = {
  'provider-default': 'Provider default',
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum',
};
export type ReasoningDriver =
  'sdk' | 'claude-budget' | 'gemini-budget' | 'deepseek' | 'effort' | 'thinking' | 'qwen';
export interface ReasoningProfile {
  driver: ReasoningDriver;
  levels: readonly ReasoningLevel[];
}
type Provider = Pick<ProviderSettings, 'kind' | 'baseUrl' | 'models' | 'defaultModel'>;
const profile = (driver: ReasoningDriver, ...levels: ReasoningLevel[]): ReasoningProfile => ({
  driver,
  levels,
});

/** Conservative, endpoint-scoped capabilities. Sources and update rules: docs/reasoning.md. */
export function reasoningProfile(provider: Provider, id: string): ReasoningProfile {
  const saved = provider.models?.find((model) => model.id === id);
  if (provider.kind === 'openai' || provider.kind === 'chatgpt') {
    if (saved?.reasoningEfforts)
      return profile(
        'sdk',
        ...new Set(
          saved.reasoningEfforts.filter(
            (level) =>
              !/^gpt-6(?:\.|-|$)/.test(id) ||
              (level !== 'minimal' && (level !== 'none' || /^gpt-6-(?:sol|luna)$/.test(id))),
          ),
        ),
      );
    if (/chat|audio|realtime|image|search/i.test(id)) return profile('sdk');
    if (id === 'gpt-6' || /^gpt-6(?:\.\d+)?-(?:astra|terra|sol|luna)(?:-|$)/.test(id))
      return profile(
        'sdk',
        ...(/^gpt-6-(?:sol|luna)$/.test(id) ? ['none' as const] : []),
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      );
    if (/^gpt-5(?:\.\d+)?-pro(?:-|$)/.test(id)) return profile('sdk', 'high');
    if (id === 'gpt-5.6' || id === 'gpt-5.6-sol')
      return profile('sdk', 'none', 'low', 'medium', 'high', 'xhigh', 'max');
    if (/^gpt-5\.[2-6](?:-|$)/.test(id))
      return profile(
        'sdk',
        ...(/codex/.test(id) ? [] : ['none' as const]),
        'low',
        'medium',
        'high',
        'xhigh',
      );
    if (/^gpt-5\.1(?:-|$)/.test(id))
      return profile(
        'sdk',
        ...(/codex/.test(id) ? [] : ['none' as const]),
        'low',
        'medium',
        'high',
      );
    if (/^gpt-5(?:-|$)/.test(id))
      return profile(
        'sdk',
        ...(/codex/.test(id) ? [] : ['minimal' as const]),
        'low',
        'medium',
        'high',
      );
    if (/^o[134](?:-|$)/.test(id) && !/pro/.test(id))
      return profile('sdk', 'low', 'medium', 'high');
  }
  if (provider.kind === 'anthropic') {
    if (/^claude-(?:opus|sonnet)-(?:4-[6-9]|5)(?:-|$)/.test(id)) {
      const opus = id.startsWith('claude-opus-');
      return profile(
        'sdk',
        ...(/-4-6(?:-|$)/.test(id) ? ['none' as const] : []),
        'low',
        'medium',
        'high',
        ...(opus && !/-4-6(?:-|$)/.test(id) ? ['xhigh' as const] : []),
        ...(opus ? ['max' as const] : []),
      );
    }
    if (/^claude-(?:3-7-sonnet|(?:sonnet|opus)-4(?:-5)?)(?:-|$)/.test(id))
      return profile('claude-budget', 'none', 'low', 'medium', 'high');
  }
  if (provider.kind === 'google' && !/image|tts|live|audio/.test(id)) {
    if (/^gemini-2\.5-flash(?:-|$)/.test(id))
      return profile('gemini-budget', 'none', 'low', 'medium', 'high');
    if (/^gemini-2\.5-pro(?:-|$)/.test(id))
      return profile('gemini-budget', 'low', 'medium', 'high');
    if (/^gemini-3(?:\.\d+)?-flash(?:-|$)/.test(id))
      return profile('sdk', 'minimal', 'low', 'medium', 'high');
    if (/^gemini-3(?:\.\d+)?-pro(?:-|$)/.test(id)) return profile('sdk', 'low', 'high');
  }
  if (provider.kind === 'compatible') {
    const preset = findProviderPreset(provider)?.id;
    if (preset === 'deepseek' && /^(deepseek-flash|deepseek-v4-pro)$/.test(id))
      return profile('deepseek', 'none', 'low', 'high', 'max');
    if (preset === 'glm' && /^glm-5\.3(?:-flashx?)?$/.test(id))
      return profile('effort', 'low', 'high', 'max');
    if (preset === 'kimi' && /^kimi-k3(?:\.1-pro(?:-highspeed)?)?$/.test(id))
      return profile('effort', 'low', 'high', 'max');
    if (preset === 'kimi' && id === 'kimi-k2.6') return profile('thinking', 'none', 'high');
    if (preset === 'mimo' && /^mimo-v2\.6-(pro|flash)$/.test(id))
      return profile('thinking', 'none', 'high');
    if (preset === 'qwen' && /^qwen3\.8-(max|flash)$/.test(id))
      return profile('qwen', 'low', 'medium', 'high');
    // Never override a known endpoint's constraints through custom declarations.
    if (!preset || preset === 'compatible')
      return profile('effort', ...(saved?.customReasoning?.supportedEfforts ?? []));
  }
  return profile('sdk');
}

export function supportsReasoning(provider: Provider, id: string, effort: ReasoningEffort) {
  return effort === 'provider-default' || reasoningProfile(provider, id).levels.includes(effort);
}

export function reasoningChoiceLabel(provider: Provider, id: string, effort: ReasoningEffort) {
  return effort === 'high' && reasoningProfile(provider, id).driver === 'thinking'
    ? 'Thinking on'
    : reasoningLabels[effort];
}

/** Undefined retains pre-feature behavior; explicit provider-default removes that policy. */
export function effectiveReasoning(bot: Pick<Bot, 'reasoningEffort'>, saved?: SavedProviderModel) {
  return bot.reasoningEffort ?? saved?.reasoningEffort;
}

export function reasoningDefaultLabel(provider: Provider, id: string) {
  const saved = provider.models?.find((model) => model.id === id);
  if (saved?.reasoningEffort) return reasoningChoiceLabel(provider, id, saved.reasoningEffort);
  if (['openai', 'chatgpt'].includes(provider.kind) && /^(o[1-9]|gpt-[5-9])/i.test(id))
    return 'Medium';
  if (provider.kind === 'anthropic' && /claude-(?:sonnet|opus)-4-[6-9]/i.test(id))
    return 'Adaptive thinking';
  if (provider.kind === 'anthropic' && /claude-(?:3-7|(?:sonnet|opus)-4)/i.test(id))
    return '2,048 thinking tokens';
  return 'Provider default';
}
