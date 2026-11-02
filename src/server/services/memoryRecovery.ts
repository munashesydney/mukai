/** Only provider memory/admission failures qualify; never infer a tool's effects from its text. */
export function isProviderMemoryError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length && seen.size < 24) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const item = current as Record<string, unknown>;
    if (
      typeof item.code === 'string' &&
      /^(prefill_memory_exceeded|generation_memory_guard|memory_admission_stalled|store_cache_admission_stalled)$/.test(
        item.code,
      )
    )
      return true;
    if (
      typeof item.message === 'string' &&
      /(?:oMLX (?:prefill )?memory guard (?:rejected|aborted)|prefill context too large for available memory)/i.test(
        item.message,
      )
    )
      return true;
    pending.push(item.cause, item.lastError, item.error, item.data);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(-3));
    if (typeof item.responseBody === 'string' && item.responseBody.length <= 65536) {
      try {
        pending.push(JSON.parse(item.responseBody));
      } catch {
        /* Not a JSON provider error. */
      }
    }
  }
  return false;
}

export const MEMORY_RETRY_DELAYS = [60000, 120000, 180000] as const;
export const MEMORY_RETRY_LIMIT = MEMORY_RETRY_DELAYS.length;
export const MEMORY_RECOVERY_QUIET_MS = 120000;
export const MEMORY_RECOVERY_SUCCESSES = 3;

/** Memory retries belong to the shared queue, never the SDK's generic network backoff. */
export class ProviderMemoryError extends Error {
  readonly name = 'MukaiProviderMemoryError';
  readonly isRetryable = false;
  constructor(cause: unknown) {
    super('The provider rejected model inference because of memory pressure.', { cause });
  }
}

export class MemoryRecoveryExhaustedError extends Error {
  readonly name = 'MukaiMemoryRecoveryExhaustedError';
  constructor(cause: unknown) {
    super(
      'The provider still cannot fit this request in memory after bounded automatic recovery. Saved progress is preserved; free memory or reduce the model context before retrying.',
      { cause },
    );
  }
}
