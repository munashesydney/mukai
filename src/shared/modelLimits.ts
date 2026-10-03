import type { Bot, ProviderSettings } from './ai';

export function modelContextWindow(
  bot: Pick<Bot, 'model' | 'contextWindowTokens'>,
  provider?: Pick<ProviderSettings, 'defaultModel' | 'contextWindowTokens'>,
) {
  return (
    bot.contextWindowTokens ??
    (!bot.model || bot.model === provider?.defaultModel
      ? (provider?.contextWindowTokens ?? null)
      : null)
  );
}
