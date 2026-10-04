import { BlockList, isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { webSearchDefinition, type WebSearchInput } from '../tools/web-search/definition';
import {
  callWebProvider,
  WebProviderError,
  type ProviderCall,
  type ProviderRequest,
  type SearchProvider,
  type WebSource,
} from '../tools/web-search/providers';

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  privateAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  privateAddresses.addSubnet(address, prefix, 'ipv6');

function publicUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('fetch requires valid public HTTP(S) URLs.');
  }
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  const version = isIP(host);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !host ||
    host === 'localhost' ||
    /\.(localhost|local|internal)$/.test(host) ||
    (!version && !host.includes('.')) ||
    (version && privateAddresses.check(host, version === 4 ? 'ipv4' : 'ipv6'))
  )
    throw new Error('fetch requires public HTTP(S) URLs without embedded credentials.');
  return url.href;
}

export type WebSearchItem =
  | { target: string; ok: true; provider: SearchProvider; fallback: boolean; sources: WebSource[] }
  | {
      target: string;
      ok: false;
      error: string;
      code: 'rate_limited' | 'provider_error';
      retryAfterSeconds?: number;
    };

/** One instance per ToolService: anonymous quotas and concurrency are shared across bots. */
export class WebSearchService {
  private cooldown: Record<SearchProvider, number> = { exa: 0, tavily: 0 };
  private nextExaAt = 0;
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private call: ProviderCall = callWebProvider,
    private now: () => number = Date.now,
  ) {}

  private async acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.active < 2) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        this.waiting = this.waiting.filter((entry) => entry !== ready);
        reject(signal.reason);
      };
      this.waiting.push(ready);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  private async attempt(provider: SearchProvider, request: ProviderRequest, signal: AbortSignal) {
    if (this.cooldown[provider] > this.now())
      throw new WebProviderError(provider, 'rate_limited', this.cooldown[provider] - this.now());
    if (provider === 'exa') {
      // Pace concurrent chats against Exa's anonymous per-IP limit.
      const start = Math.max(this.now(), this.nextExaAt);
      this.nextExaAt = start + 600;
      if (start > this.now()) await delay(start - this.now(), undefined, { signal });
      if (this.cooldown.exa > this.now())
        throw new WebProviderError('exa', 'rate_limited', this.cooldown.exa - this.now());
    }
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    try {
      return await this.call(provider, request, attemptSignal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof WebProviderError) {
        if (error.code === 'rate_limited')
          this.cooldown[provider] = Math.max(
            this.cooldown[provider],
            this.now() + (error.retryAfterMs ?? 60000),
          );
        throw error;
      }
      throw new WebProviderError(provider, 'provider_error');
    }
  }

  private async route(request: ProviderRequest, signal: AbortSignal): Promise<WebSearchItem> {
    await this.acquire(signal);
    try {
      try {
        const result = await this.attempt('exa', request, signal);
        return { target: request.target, ok: true, provider: 'exa', fallback: false, ...result };
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof WebProviderError) || error.code !== 'rate_limited') throw error;
        try {
          const result = await this.attempt('tavily', request, signal);
          return {
            target: request.target,
            ok: true,
            provider: 'tavily',
            fallback: true,
            ...result,
          };
        } catch (fallbackError) {
          if (fallbackError instanceof WebProviderError && fallbackError.code === 'rate_limited') {
            const remaining = Math.max(
              0,
              Math.min(this.cooldown.exa, this.cooldown.tavily) - this.now(),
            );
            const limited = new WebProviderError('exa', 'rate_limited', remaining);
            limited.message = `Both web search providers are rate limited. Retry in ${Math.ceil(remaining / 1000)} seconds.`;
            throw limited;
          }
          throw fallbackError;
        }
      }
    } finally {
      this.release();
    }
  }

  async execute(raw: WebSearchInput, signal: AbortSignal, consume: () => void) {
    signal.throwIfAborted();
    const input = webSearchDefinition.inputSchema.parse(raw);
    if (input.startDate && input.endDate && input.startDate > input.endDate)
      throw new Error('startDate must be on or before endDate.');
    for (const domain of [...(input.includeDomains || []), ...(input.excludeDomains || [])])
      if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(domain))
        throw new Error('Domain filters must contain hostnames, such as docs.example.com.');
    let targets: string[];
    if (input.action === 'search') {
      if (Boolean(input.query) === Boolean(input.queries) || input.urls)
        throw new Error('search requires query or queries (not both), without urls.');
      targets = input.queries || [input.query!];
    } else {
      if (!input.urls || input.query || input.queries)
        throw new Error('fetch requires urls, without query or queries.');
      targets = input.urls.map(publicUrl);
    }
    const actionSignal = AbortSignal.any([signal, AbortSignal.timeout(90000)]);
    const items: WebSearchItem[] = [];
    // Reserve the whole batch before doing work, so budget exhaustion cannot lose completed items.
    targets.forEach(() => consume());
    // Small batches are serial so later items observe cooldowns from earlier ones.
    for (const target of targets) {
      actionSignal.throwIfAborted();
      try {
        items.push(
          await this.route(
            {
              ...input,
              target,
              maxResults: input.maxResults ?? 5,
              maxCharacters: input.maxCharacters ?? (input.action === 'search' ? 2000 : 8000),
            },
            actionSignal,
          ),
        );
      } catch (error) {
        actionSignal.throwIfAborted();
        if (targets.length === 1) throw error;
        items.push({
          target,
          ok: false,
          error: error instanceof Error ? error.message : 'Web request failed.',
          code: error instanceof WebProviderError ? error.code : 'provider_error',
          ...(error instanceof WebProviderError && error.retryAfterMs !== undefined
            ? { retryAfterSeconds: Math.ceil(error.retryAfterMs / 1000) }
            : {}),
        });
      }
    }
    return { items, partial: items.some((item) => !item.ok) };
  }
}
