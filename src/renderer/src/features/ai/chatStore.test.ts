import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../../../shared/ai';

const saved = new Map<string, string>();
const user = (requestId: string): ChatMessage => ({
  id: 'user-id',
  requestId,
  botId: 'scout',
  role: 'user',
  content: 'Keep this prompt',
  status: 'complete',
  error: null,
  createdAt: '2026-10-01T00:00:00Z',
  attachments: [],
});
const assistant = (requestId: string, status: ChatMessage['status'] = 'complete'): ChatMessage => ({
  ...user(requestId),
  id: 'assistant-id',
  role: 'assistant',
  content: status === 'complete' ? 'Saved reply' : '',
  status,
});
beforeEach(() => {
  vi.resetModules();
  saved.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) || null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  vi.stubGlobal('window', {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('Durable chat drafts and transport recovery', () => {
  it('recovers an accepted request after refresh and clears its draft without duplicating it', async () => {
    const requestId = crypto.randomUUID();
    saved.set('mukai.draft.scout', JSON.stringify({ text: 'Keep this prompt', requestId }));
    const network = vi.fn(async (url: string) =>
      Response.json(url.endsWith('/messages') ? [user(requestId), assistant(requestId)] : []),
    );
    vi.stubGlobal('fetch', network);
    const { chatStore } = await import('./chatStore');
    await chatStore.load('scout');
    const draft = JSON.parse(saved.get('mukai.draft.scout')!);
    expect(draft.text).toBe('');
    expect(draft.requestId).not.toBe(requestId);
    expect(network.mock.calls.every((call) => !call[0].endsWith('/chat'))).toBe(true);
  });
  it('retains a modified draft when recovering a previously accepted prompt', async () => {
    const requestId = crypto.randomUUID();
    saved.set('mukai.draft.scout', JSON.stringify({ text: 'A new question instead', requestId }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        Response.json(url.endsWith('/messages') ? [user(requestId), assistant(requestId)] : []),
      ),
    );
    const { chatStore } = await import('./chatStore');
    await chatStore.load('scout');
    const draft = JSON.parse(saved.get('mukai.draft.scout')!);
    expect(draft.text).toBe('A new question instead');
    expect(draft.requestId).not.toBe(requestId);
  });
  it('recovers a prompt accepted before a dropped stream and retries its existing request ID', async () => {
    const bodies: { requestId: string }[] = [];
    let acceptedId = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/chat')) {
          const body = JSON.parse(String(init?.body));
          bodies.push(body);
          acceptedId = body.requestId;
          if (bodies.length === 1) throw new Error('Transport lost before first event');
          return new Response(
            JSON.stringify({
              type: 'start',
              user: user(acceptedId),
              assistant: assistant(acceptedId, 'streaming'),
            }) +
              '\n' +
              JSON.stringify({ type: 'done', message: assistant(acceptedId) }) +
              '\n',
          );
        }
        return Response.json(
          url.endsWith('/messages') && acceptedId
            ? [user(acceptedId), assistant(acceptedId, 'failed')]
            : [],
        );
      }),
    );
    const { chatStore } = await import('./chatStore');
    await chatStore.load('scout');
    chatStore.draft('scout', 'Keep this prompt');
    await chatStore.send('scout');
    expect(JSON.parse(saved.get('mukai.draft.scout')!).text).toBe('');
    await chatStore.send('scout', acceptedId);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].requestId).toBe(bodies[0].requestId);
  });
  it('keeps an unaccepted prompt and its request ID available after a rejected request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/chat')
          ? Response.json({ error: 'Check provider settings.' }, { status: 400 })
          : Response.json([]),
      ),
    );
    const { chatStore } = await import('./chatStore');
    await chatStore.load('scout');
    chatStore.draft('scout', 'Keep this prompt');
    const before = saved.get('mukai.draft.scout');
    await chatStore.send('scout');
    expect(saved.get('mukai.draft.scout')).toBe(before);
  });
});
