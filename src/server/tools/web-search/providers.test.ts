import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWebProvider, type ProviderRequest } from './providers';

const request: ProviderRequest = {
  action: 'search',
  target: 'public documentation',
  maxResults: 2,
  maxCharacters: 500,
};
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

function exaFixture(
  result: unknown,
  options: { sse?: boolean; rpcError?: unknown; http?: Response } = {},
) {
  const calls: { method: string; params?: { name: string; arguments: Record<string, unknown> } }[] =
    [];
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'initialize')
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'exa-fixture', version: '1' },
        },
      });
    if (options.http) return options.http;
    const message = {
      jsonrpc: '2.0',
      id: body.id,
      ...(options.rpcError ? { error: options.rpcError } : { result }),
    };
    return options.sse
      ? new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      : Response.json(message);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

describe('keyless provider adapters', () => {
  it.each([false, true])('reads structured Exa results over MCP (SSE=%s)', async (sse) => {
    const { calls, fetchMock } = exaFixture(
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              results: [
                {
                  title: 'Official docs',
                  url: 'https://example.com/docs',
                  text: 'x'.repeat(600),
                  publishedDate: '2026-01-01',
                },
                { url: 'https://example.com/another', text: 'Second' },
                { url: 'https://example.com/omitted', text: 'Third' },
              ],
            }),
          },
        ],
      },
      { sse },
    );
    const result = await callWebProvider(
      'exa',
      {
        ...request,
        includeDomains: ['example.com'],
        startDate: '2026-01-01',
      },
      signal(),
    );
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toMatchObject({
      title: 'Official docs',
      publishedAt: '2026-01-01',
      truncated: true,
    });
    expect(result.sources[0].text).toHaveLength(500);
    expect(calls.find((call) => call.method === 'tools/call')?.params).toMatchObject({
      name: 'web_search_advanced_exa',
      arguments: {
        query: request.target,
        numResults: 2,
        includeDomains: ['example.com'],
        startPublishedDate: '2026-01-01',
      },
    });
    for (const [, init] of fetchMock.mock.calls)
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });

  it('recognizes HTTP throttling and Retry-After through the MCP client', async () => {
    exaFixture(undefined, {
      http: new Response('limited', { status: 429, headers: { 'Retry-After': '42' } }),
    });
    await expect(callWebProvider('exa', request, signal())).rejects.toMatchObject({
      provider: 'exa',
      code: 'rate_limited',
      retryAfterMs: 42000,
    });
  });

  it.each(['rpc', 'tool'])(
    'recognizes Exa throttling inside successful HTTP responses (%s)',
    async (kind) => {
      exaFixture(
        {
          isError: true,
          content: [{ type: 'text', text: "You've hit Exa's free MCP rate limit." }],
        },
        kind === 'rpc'
          ? { rpcError: { code: -32000, message: 'Free MCP rate limit reached' } }
          : {},
      );
      await expect(callWebProvider('exa', request, signal())).rejects.toMatchObject({
        code: 'rate_limited',
      });
    },
  );

  it('does not treat missing Exa page content or malformed search output as success', async () => {
    exaFixture({ content: [{ type: 'text', text: 'No content found for the provided URL(s).' }] });
    await expect(
      callWebProvider(
        'exa',
        { ...request, action: 'fetch', target: 'https://example.com/' },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'provider_error' });
    exaFixture({ content: [{ type: 'text', text: 'not JSON' }] });
    await expect(callWebProvider('exa', request, signal())).rejects.toMatchObject({
      code: 'provider_error',
    });
  });

  it('returns bounded page content and the page title through Exa', async () => {
    exaFixture({
      content: [{ type: 'text', text: '# Example\nURL: https://example.com/\n\nPage content' }],
    });
    const result = await callWebProvider(
      'exa',
      { ...request, action: 'fetch', target: 'https://example.com/' },
      signal(),
    );
    expect(result.sources[0]).toMatchObject({
      title: 'Example',
      url: 'https://example.com/',
      truncated: false,
    });
  });

  it('uses Tavily keyless headers, maps filters, and keeps one session identity', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        results: [
          {
            title: 'Docs',
            url: 'https://example.com/',
            content: 'Snippet',
            raw_content: null,
            published_date: null,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await callWebProvider(
      'tavily',
      { ...request, includeDomains: ['example.com'], endDate: '2026-01-01' },
      signal(),
    );
    await callWebProvider('tavily', request, signal());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.tavily.com/search');
    expect(init.headers).toMatchObject({
      'X-Tavily-Access-Mode': 'keyless',
      'X-Client-Source': 'mukai-keyless',
    });
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(JSON.parse(String(init.body))).toMatchObject({
      include_domains: ['example.com'],
      end_date: '2026-01-01',
    });
    const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('X-Session-Id')).toBe(
      new Headers(second[1].headers).get('X-Session-Id'),
    );
  });

  it('extracts and bounds Tavily content; failed extraction is an error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ results: [{ url: 'https://example.com/', raw_content: 'x'.repeat(700) }] }),
      )
      .mockResolvedValueOnce(
        Response.json({ results: [], failed_results: [{ url: 'https://example.com/' }] }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const input = { ...request, action: 'fetch' as const, target: 'https://example.com/' };
    const result = await callWebProvider('tavily', input, signal());
    expect(result.sources[0].text).toHaveLength(500);
    expect(result.sources[0].truncated).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.tavily.com/extract');
    await expect(callWebProvider('tavily', input, signal())).rejects.toMatchObject({
      code: 'provider_error',
    });
  });

  it('recognizes Tavily keyless envelopes even with HTTP 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          error: {
            code: 'KEYLESS_DAILY_LIMIT',
            message: 'Fair-use quota exhausted',
            retry_after_seconds: 120,
          },
        }),
      ),
    );
    await expect(callWebProvider('tavily', request, signal())).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 120000,
    });
  });

  it('reads retry dates and rejects oversized provider responses', async () => {
    const date = new Date(Date.now() + 60000).toUTCString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': date } })),
    );
    await expect(callWebProvider('tavily', request, signal())).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterMs: expect.any(Number),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))),
    );
    await expect(callWebProvider('tavily', request, signal())).rejects.toMatchObject({
      code: 'provider_error',
    });
  });

  it('preserves aborts instead of converting them into rate-limit fallback errors', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Interrupted'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw controller.signal.reason;
      }),
    );
    await expect(callWebProvider('tavily', request, controller.signal)).rejects.toThrow(
      'Interrupted',
    );
  });
});
