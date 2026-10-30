export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';

/**
 * Was this request cancelled rather than refused?
 *
 * Browsers cancel in-flight fetches when a page navigates or when the component that
 * started one unmounts, and a caller sometimes aborts on purpose through a signal. None
 * of that says anything about the server, yet it reaches a `fetch()` caller as a
 * rejection shaped exactly like a connection failure — so the connection banner told the
 * user to start the backend while every other poll on the same page was answering 200.
 *
 * A `TimeoutError` deliberately does not count here: a request that hung past its own
 * deadline is a server that is not answering, which is exactly what the banner is for.
 */
const hasName = (value: unknown, name: string): boolean =>
  typeof value === 'object' && value !== null && (value as { name?: unknown }).name === name;

export const isCancellation = (error: unknown): boolean =>
  hasName(error, 'AbortError') ||
  hasName((error as { cause?: unknown } | null)?.cause, 'AbortError');
