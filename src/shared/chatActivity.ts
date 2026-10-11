export interface ChatServerOutput {
  id: string;
  botId: string;
  messageId: string;
  sessionId: string;
  url: string;
  computer: 'local' | 'qemu';
  status: 'running' | 'exited' | 'killed' | 'failed' | 'unavailable';
}

export function localServerUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(url.hostname)
    )
      return;
    if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = 'localhost';
    return url.toString();
  } catch {
    return;
  }
}

/** Only local server addresses emitted by tools qualify; assistant prose is not evidence. */
export function serverUrls(output: string): string[] {
  // Terminal color sequences are control characters by definition.
  // eslint-disable-next-line no-control-regex
  const clean = output.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
  const matches =
    clean.match(
      /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):\d{1,5}(?!\d)(?:\/[^\s<>"'`]*)?/gi,
    ) || [];
  const urls = new Set<string>();
  for (const match of matches) {
    try {
      const port = Number(match.match(/\]?:([0-9]+)/)?.[1]);
      if (port < 1 || port > 65535) continue;
      const url = localServerUrl(match.replace(/[),.;\]}]+$/, ''));
      if (url) urls.add(url);
    } catch {
      /* Ignore malformed log fragments. */
    }
  }
  return [...urls];
}
