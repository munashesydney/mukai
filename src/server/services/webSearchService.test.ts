import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSearchService } from './webSearchService';
import { WebProviderError, type ProviderCall } from '../tools/web-search/providers';
import { executeWebSearch } from '../tools/web-search/execute';
import type { ChatActivity } from '../../shared/ai';

const signal = () => new AbortController().signal;
const search = { action: 'search' as const, query: 'official documentation' };
const found = {
  sources: [
    { title: 'Docs', url: 'https://example.com/', text: 'Useful content', truncated: false },
  ],
};
afterEach(() => vi.useRealTimers());

describe('web search routing and batches', () => {
  it('prefers Exa and sends filters without exposing provider selection to the model', async () => {
    const call = vi.fn<ProviderCall>().mockResolvedValue(found);
    const service = new WebSearchService(call);
    const result = await service.execute(
      { ...search, includeDomains: ['example.com'], startDate: '2026-01-01', maxResults: 2 },
      signal(),
      () => {},
    );
    expect(result.items[0]).toMatchObject({ ok: true, provider: 'exa', fallback: false });
    expect(call).toHaveBeenCalledExactlyOnceWith(
      'exa',
      expect.objectContaining({
        action: 'search',
        target: search.query,
        maxResults: 2,
        maxCharacters: 2000,
        includeDomains: ['example.com'],
        startDate: '2026-01-01',
      }),
      expect.any(AbortSignal),
    );
  });

  it('falls back on throttling, shares cooldowns between calls, and recovers to Exa', async () => {
    let now = 1000;
    const call = vi
      .fn<ProviderCall>()
      .mockRejectedValueOnce(new WebProviderError('exa', 'rate_limited', 30000))
      .mockResolvedValue(found);
    const service = new WebSearchService(call, () => now);
    const first = await service.execute(search, signal(), () => {});
    expect(first.items[0]).toMatchObject({ provider: 'tavily', fallback: true });
    await service.execute(search, signal(), () => {});
    expect(call.mock.calls.map(([provider]) => provider)).toEqual(['exa', 'tavily', 'tavily']);
    now += 31000;
    const recovered = await service.execute(search, signal(), () => {});
    expect(recovered.items[0]).toMatchObject({ provider: 'exa', fallback: false });
  });

  it('does not fail over on empty results or ordinary provider failures', async () => {
    const empty = vi.fn<ProviderCall>().mockResolvedValue({ sources: [] });
    expect(
      (await new WebSearchService(empty).execute(search, signal(), () => {})).items[0],
    ).toMatchObject({ provider: 'exa', sources: [] });
    expect(empty).toHaveBeenCalledTimes(1);
    const broken = vi
      .fn<ProviderCall>()
      .mockRejectedValue(new WebProviderError('exa', 'provider_error'));
    await expect(new WebSearchService(broken).execute(search, signal(), () => {})).rejects.toThrow(
      'exa could not complete',
    );
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it('reports when both providers are throttled without making more requests during cooldown', async () => {
    const call = vi.fn<ProviderCall>().mockImplementation(async (provider) => {
      throw new WebProviderError(provider, 'rate_limited', provider === 'exa' ? 60000 : 30000);
    });
    const service = new WebSearchService(call, () => 1000);
    await expect(service.execute(search, signal(), () => {})).rejects.toThrow(
      'Both web search providers',
    );
    await expect(service.execute(search, signal(), () => {})).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 30000,
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('retains successful batch items and returns per-item failures with retry timing', async () => {
    let now = 0;
    const call = vi.fn<ProviderCall>().mockImplementation(async (provider, request) => {
      now += 1000;
      if (request.target === 'bad') throw new WebProviderError(provider, 'provider_error');
      return found;
    });
    const consume = vi.fn();
    const result = await new WebSearchService(call, () => now).execute(
      { action: 'search', queries: ['good', 'bad', 'good again'] },
      signal(),
      consume,
    );
    expect(result.partial).toBe(true);
    expect(result.items.map((item) => item.ok)).toEqual([true, false, true]);
    expect(consume).toHaveBeenCalledTimes(3);
  });

  it('validates the complete batch before any network calls', async () => {
    const call = vi.fn<ProviderCall>();
    const service = new WebSearchService(call);
    for (const input of [
      { ...search, queries: ['another'] },
      { action: 'search' as const },
      { action: 'fetch' as const },
      { ...search, startDate: '2026-02-01', endDate: '2026-01-01' },
      { ...search, includeDomains: ['https://example.com'] },
      { action: 'fetch' as const, urls: ['https://example.com', 'http://127.0.0.1/'] },
    ])
      await expect(service.execute(input, signal(), () => {})).rejects.toThrow();
    for (const url of [
      'file:///C:/secret.txt',
      'http://localhost/',
      'http://10.0.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'https://user:password@example.com/',
    ])
      await expect(
        service.execute({ action: 'fetch', urls: [url] }, signal(), () => {}),
      ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates cancellation without falling back or recording an ordinary error', async () => {
    const controller = new AbortController();
    const call = vi.fn<ProviderCall>().mockImplementation(async () => {
      controller.abort(new Error('Cancelled by user'));
      throw new WebProviderError('exa', 'rate_limited');
    });
    await expect(
      new WebSearchService(call).execute(search, controller.signal, () => {}),
    ).rejects.toThrow('Cancelled by user');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('limits concurrent conversations and removes cancelled waiters', async () => {
    const pending: (() => void)[] = [];
    const call = vi.fn<ProviderCall>().mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve(found));
        }),
    );
    let now = 0;
    const service = new WebSearchService(call, () => (now += 1000));
    const first = service.execute(search, signal(), () => {});
    const second = service.execute(search, signal(), () => {});
    const controller = new AbortController();
    const third = service.execute(search, controller.signal, () => {});
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    controller.abort(new Error('Cancelled queued request'));
    await expect(third).rejects.toThrow('Cancelled queued request');
    pending.forEach((resolve) => resolve());
    await Promise.all([first, second]);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('charges each batch item and emits the family activity; insufficient budgets do no work', async () => {
    const call = vi.fn<ProviderCall>().mockResolvedValue(found);
    const activities: ChatActivity[] = [];
    const context = {
      owner: { botId: 'bot', workspaceId: 'workspace', conversationId: 'conversation' },
      signal: signal(),
      onActivity: (activity: ChatActivity) => activities.push(activity),
      budget: { remaining: 1 },
      webSearch: new WebSearchService(call),
    };
    const failed = await executeWebSearch(
      { action: 'search', queries: ['first', 'second'] },
      context,
      'budget-call',
    );
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining('call limit') });
    expect(call).not.toHaveBeenCalled();
    expect(activities.at(-1)).toMatchObject({
      tool: 'web_search',
      action: 'search',
      status: 'failed',
    });
    context.budget.remaining = 2;
    const complete = await executeWebSearch(search, context, 'search-call');
    expect(complete.ok).toBe(true);
    expect(context.budget.remaining).toBe(1);
    expect(activities.at(-1)).toMatchObject({ tool: 'web_search', status: 'complete' });
  });
});
