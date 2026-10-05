import type { Bot, ProviderSettings } from './ai';

export function modelContextWindow(
  bot: Pick<Bot, 'model' | 'contextWindowTokens'>,
  provider?: Pick<ProviderSettings, 'defaultModel' | 'contextWindowTokens' | 'models'>,
) {
  return (
    provider?.models?.find((model) => model.id === (bot.model || provider.defaultModel))
      ?.contextWindowTokens ??
    bot.contextWindowTokens ??
    (!bot.model || bot.model === provider?.defaultModel
      ? (provider?.contextWindowTokens ?? null)
      : null)
  );
}
