import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

export type SearchProvider = 'exa' | 'tavily';
export type ProviderRequest = {
  action: 'search' | 'fetch';
  target: string;
  maxResults: number;
  maxCharacters: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  startDate?: string;
  endDate?: string;
};
export type WebSource = {
  title: string;
  url: string;
  text: string;
  publishedAt?: string;
  truncated: boolean;
};
export type ProviderResult = { sources: WebSource[] };
export type ProviderCall = (
  provider: SearchProvider,
  request: ProviderRequest,
  signal: AbortSignal,
) => Promise<ProviderResult>;

export class WebProviderError extends Error {
  constructor(
    public readonly provider: SearchProvider,
    public readonly code: 'rate_limited' | 'provider_error',
    public readonly retryAfterMs?: number,
  ) {
    super(
      code === 'rate_limited'
        ? `${provider} is rate limited.${retryAfterMs ? ` Retry in ${Math.ceil(retryAfterMs / 1000)} seconds.` : ''}`
        : `${provider} could not complete this web request.`,
    );
  }
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TAVILY_SESSION_ID = randomUUID();
const optionalText = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);
const exaSource = z.object({
  title: optionalText,
  url: z.string(),
  text: optionalText,
  publishedDate: optionalText,
});
const tavilySource = z.object({
  title: optionalText,
  url: z.string(),
  content: optionalText,
  raw_content: optionalText,
  published_date: optionalText,
});

export function source(
  title: string | undefined,
  url: string,
  text: string,
  maxCharacters: number,
  publishedAt?: string,
): WebSource {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error('Provider returned an invalid source URL.');
  return {
    title: title || parsed.hostname,
    url,
    text: text.slice(0, maxCharacters),
    // At the upstream extraction limit, completeness is unknown.
    truncated: text.length >= maxCharacters,
    ...(publishedAt ? { publishedAt } : {}),
  };
}

function retryAfter(response: Response, now = Date.now()) {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (reset > 0) return Math.max(0, (reset > 1e12 ? reset : reset * 1000) - now);
  return undefined;
}

function boundedResponse(response: Response, provider: SearchProvider) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) return controller.close();
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          controller.error(new WebProviderError(provider, 'provider_error'));
        } else controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function envelopeError(provider: SearchProvider, value: unknown) {
  if (!value || typeof value !== 'object' || !('error' in value) || !value.error) return;
  const error = value.error;
  const detail = typeof error === 'string' ? error : JSON.stringify(error);
  const throttled = /rate.?limit|quota|keyless.*limit|limit.*keyless|too many requests/i.test(
    detail,
  );
  const retry =
    typeof error === 'object' && error !== null && 'retry_after_seconds' in error
      ? error.retry_after_seconds
      : undefined;
  throw new WebProviderError(
    provider,
    throttled ? 'rate_limited' : 'provider_error',
    typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 ? retry * 1000 : undefined,
  );
}

async function callExa(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResult> {
  const client = new Client({ name: 'mukai', version: '0.1.0' });
  let transportError: WebProviderError | undefined;
  const transport = new StreamableHTTPClientTransport(
    new URL('https://mcp.exa.ai/mcp?tools=web_search_advanced_exa,web_fetch_exa'),
    {
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (url, init) => {
        const response = await fetch(url, {
          ...init,
          signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        });
        if (response.status === 429) {
          transportError = new WebProviderError('exa', 'rate_limited', retryAfter(response));
          await response.body?.cancel();
          throw transportError;
        }
        return boundedResponse(response, 'exa');
      },
    },
  );
  try {
    await client.connect(transport, { signal, timeout: 20000 });
    const result = await client.callTool(
      request.action === 'search'
        ? {
            name: 'web_search_advanced_exa',
            arguments: {
              query: request.target,
              numResults: request.maxResults,
              type: 'auto',
              textMaxCharacters: request.maxCharacters,
              ...(request.includeDomains?.length ? { includeDomains: request.includeDomains } : {}),
              ...(request.excludeDomains?.length ? { excludeDomains: request.excludeDomains } : {}),
              ...(request.startDate ? { startPublishedDate: request.startDate } : {}),
              ...(request.endDate ? { endPublishedDate: request.endDate } : {}),
            },
          }
        : {
            name: 'web_fetch_exa',
            arguments: { urls: [request.target], maxCharacters: request.maxCharacters },
          },
      undefined,
      { signal, timeout: 20000 },
    );
    const text = (result.content as { type: string; text?: string }[])
      .filter((block) => block.type === 'text')
      .map((block) => block.text || '')
      .join('\n');
    if (result.isError) {
      envelopeError('exa', { error: text });
    }
    if (request.action === 'fetch') {
      if (!text.trim() || /^No content found[. ]/i.test(text.trim()))
        throw new WebProviderError('exa', 'provider_error');
      const title = /^# ([^\n]+)/.exec(text)?.[1];
      return { sources: [source(title, request.target, text, request.maxCharacters)] };
    }
    if (/^No search results found\./i.test(text.trim())) return { sources: [] };
    const data: unknown = result.structuredContent ?? JSON.parse(text);
    envelopeError('exa', data);
    const parsed = z.object({ results: z.array(exaSource) }).parse(data);
    return {
      sources: parsed.results
        .slice(0, request.maxResults)
        .map((item) =>
          source(item.title, item.url, item.text || '', request.maxCharacters, item.publishedDate),
        ),
    };
  } catch (error) {
    signal.throwIfAborted();
    if (transportError) throw transportError;
    if (error instanceof WebProviderError) throw error;
    // Exa can report throttling as a JSON-RPC error rather than HTTP 429.
    envelopeError('exa', { error: error instanceof Error ? error.message : '' });
    throw new WebProviderError('exa', 'provider_error');
  } finally {
    await client.close().catch(() => {});
  }
}

async function callTavily(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResult> {
  const response = await fetch(
    `https://api.tavily.com/${request.action === 'search' ? 'search' : 'extract'}`,
    {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-Tavily-Access-Mode': 'keyless',
        'X-Client-Source': 'mukai-keyless',
        'X-Session-Id': TAVILY_SESSION_ID,
      },
      body: JSON.stringify(
        request.action === 'search'
          ? {
              query: request.target,
              max_results: request.maxResults,
              search_depth: 'basic',
              include_answer: false,
              include_domains: request.includeDomains,
              exclude_domains: request.excludeDomains,
              start_date: request.startDate,
              end_date: request.endDate,
            }
          : { urls: [request.target], format: 'markdown', extract_depth: 'basic' },
      ),
      signal,
    },
  );
  if (response.status === 429) {
    const delay = retryAfter(response);
    // Keyless responses can supply retry timing in their JSON error envelope.
    const data: unknown = await boundedResponse(response, 'tavily')
      .json()
      .catch(() => null);
    try {
      envelopeError('tavily', data);
    } catch (error) {
      if (error instanceof WebProviderError)
        throw new WebProviderError('tavily', 'rate_limited', delay ?? error.retryAfterMs);
      throw error;
    }
    throw new WebProviderError('tavily', 'rate_limited', delay);
  }
  const data: unknown = await boundedResponse(response, 'tavily').json();
  envelopeError('tavily', data);
  if (!response.ok) throw new WebProviderError('tavily', 'provider_error');
  const parsed = z.object({ results: z.array(tavilySource) }).parse(data);
  if (request.action === 'fetch' && !parsed.results.length)
    throw new WebProviderError('tavily', 'provider_error');
  return {
    sources: parsed.results
      .slice(0, request.action === 'search' ? request.maxResults : 1)
      .map((item) =>
        source(
          item.title,
          item.url,
          item.raw_content || item.content || '',
          request.maxCharacters,
          item.published_date,
        ),
      ),
  };
}

export const callWebProvider: ProviderCall = async (provider, request, signal) => {
  try {
    return await (provider === 'exa' ? callExa(request, signal) : callTavily(request, signal));
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof WebProviderError) throw error;
    throw new WebProviderError(provider, 'provider_error');
  }
};
