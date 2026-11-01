import type { ProviderSettings, SavedProviderModel } from './ai';

export const MAX_RESPONSE_TIMEOUT_SECONDS = 7200;

/** Local engines may buffer an entire tool call before emitting its arguments. */
export function providerResponseTimeouts(
  provider: Pick<ProviderSettings, 'kind' | 'baseUrl'>,
  model?: Pick<SavedProviderModel, 'responseTimeoutSeconds' | 'responseIdleTimeoutSeconds'>,
) {
  let local = false;
  if (provider.kind === 'compatible') {
    try {
      local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(provider.baseUrl).hostname);
    } catch {
      // An invalid endpoint still gets finite defaults and its normal validation error.
    }
  }
  const seconds = (value: number | undefined, fallback: number) =>
    value !== undefined &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_RESPONSE_TIMEOUT_SECONDS
      ? value
      : fallback;
  const total = seconds(model?.responseTimeoutSeconds, local ? 900 : 300);
  const idle = seconds(model?.responseIdleTimeoutSeconds, local ? 600 : 120);
  return { totalMs: total * 1000, idleMs: Math.min(idle, total) * 1000 };
}
