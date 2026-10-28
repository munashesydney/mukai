import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../../../shared/ai';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatState } from '../../models/chat';

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
  it('uploads while working, retains files on queue failure, and clears only an accepted attachment draft', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([])),
    );
    const { chatStore, useChat } = await import('./chatStore');
    const { chatService } = await import('../../services/chatService');
    const { attachmentService } = await import('../../services/attachmentService');
    const id = 'private:attachment-queue';
    await chatStore.load(id);
    let finish!: () => void;
    vi.spyOn(chatService, 'stream').mockImplementation(async (_id, input, emit) => {
      emit({
        type: 'start',
        user: user(input.requestId),
        assistant: assistant(input.requestId, 'streaming'),
      });
      await new Promise<void>((resolve) => {
        finish = () => {
          emit({ type: 'done', message: assistant(input.requestId) });
          resolve();
        };
      });
    });
    chatStore.draft(id, 'Original task');
    const running = chatStore.send(id);
    const file = {
      id: crypto.randomUUID(),
      botId: 'scout',
      messageId: null,
      name: 'guidance.txt',
      mediaType: 'text/plain',
      kind: 'text' as const,
      size: 10,
      warning: null,
    };
    const uploads = vi.spyOn(attachmentService, 'upload').mockResolvedValue(file);
    await chatStore.upload(id, [new File(['guidance'], file.name)]);
    let state!: ChatState;
    const inspect = () => {
      renderToStaticMarkup(
        createElement(() => {
          state = useChat(id);
          return null;
        }),
      );
      return state;
    };
    expect(uploads).toHaveBeenCalledOnce();
    expect(inspect().files).toEqual([file]);
    const queue = vi.spyOn(chatService, 'queue').mockRejectedValueOnce(new Error('Offline'));
    await chatStore.send(id);
    expect(queue.mock.calls[0][1]).toMatchObject({ text: '', attachmentIds: [file.id] });
    expect(inspect().files).toEqual([file]);
    let accept!: () => void;
    queue.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        accept = resolve;
      });
      return [];
    });
    const submitting = chatStore.send(id);
    chatStore.draft(id, 'New detail typed during submission');
    await chatStore.upload(id, [new File(['later'], 'later.txt')]);
    expect(uploads).toHaveBeenCalledOnce();
    accept();
    await submitting;
    expect(inspect().files).toEqual([]);
    expect(inspect().text).toBe('New detail typed during submission');
    finish();
    await running;
  });
  it('queues during an active run and preserves text typed while the queue request is in flight', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([])),
    );
    const { chatStore } = await import('./chatStore');
    const { chatService } = await import('../../services/chatService');
    const id = 'private:queue-chat';
    await chatStore.load(id);
    let finish!: () => void;
    vi.spyOn(chatService, 'stream').mockImplementation(async (_id, input, emit) => {
      emit({
        type: 'start',
        user: user(input.requestId),
        assistant: assistant(input.requestId, 'streaming'),
      });
      await new Promise<void>((resolve) => {
        finish = () => {
          emit({ type: 'done', message: assistant(input.requestId) });
          resolve();
        };
      });
    });
    chatStore.draft(id, 'Original task');
    const running = chatStore.send(id);
    let deliver!: () => void;
    const queue = vi.spyOn(chatService, 'queue').mockImplementation(async (_id, input) => {
      await new Promise<void>((resolve) => {
        deliver = resolve;
      });
      return [
        {
          id: input.id,
          conversationId: 'queue-chat',
          botId: 'scout',
          text: input.text,
          state: 'queued',
          targetMessageId: null,
          createdAt: '',
          error: null,
        },
      ];
    });
    chatStore.draft(id, 'Focus on mobile');
    const submitting = chatStore.send(id);
    chatStore.draft(id, 'Another detail');
    deliver();
    await submitting;
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][1].text).toBe('Focus on mobile');
    expect(JSON.parse(saved.get('mukai.draft.' + id)!).text).toBe('Another detail');
    finish();
    await running;
  });

  it('does not resurrect pending steering when its HTTP receipt arrives after the applied event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([])),
    );
    const { chatStore, useChat } = await import('./chatStore');
    const { chatService } = await import('../../services/chatService');
    const id = 'private:steering-race';
    await chatStore.load(id);
    let emit!: Parameters<typeof chatService.stream>[2];
    let finish!: () => void;
    vi.spyOn(chatService, 'stream').mockImplementation(async (_id, input, onEvent) => {
      emit = onEvent;
      emit({
        type: 'start',
        user: user(input.requestId),
        assistant: assistant(input.requestId, 'streaming'),
      });
      await new Promise<void>((resolve) => {
        finish = () => {
          emit({ type: 'done', message: assistant(input.requestId) });
          resolve();
        };
      });
    });
    chatStore.draft(id, 'Original task');
    const running = chatStore.send(id);
    const followupId = crypto.randomUUID();
    vi.spyOn(chatService, 'updateFollowup').mockImplementation(async () => {
      emit({
        type: 'part',
        id: 'assistant-id',
        part: { id: followupId, type: 'steering', text: 'Correction' },
      });
      emit({ type: 'followups', followups: [] });
      return [
        {
          id: followupId,
          conversationId: 'steering-race',
          botId: 'scout',
          text: 'Correction',
          state: 'steering',
          targetMessageId: 'assistant-id',
          createdAt: '',
          error: null,
        },
      ];
    });
    await chatStore.followup(id, {
      action: 'steer',
      id: followupId,
      expectedRequestId: crypto.randomUUID(),
    });
    let state!: ChatState;
    const Inspect = () => {
      state = useChat(id);
      return null;
    };
    renderToStaticMarkup(createElement(Inspect));
    expect(state.followups).toEqual([]);
    expect(state.messages[1].parts).toContainEqual({
      id: followupId,
      type: 'steering',
      text: 'Correction',
    });
    finish();
    await running;
  });
  it.each(['complete', 'stopped', 'failed'] as const)(
    'shows conversation activity only for the working chat and clears it on %s',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json([])),
      );
      const { chatStore } = await import('./chatStore');
      const { chatService } = await import('../../services/chatService');
      const { ConversationStatus } = await import('./ConversationStatus');
      const id = 'private:working-chat';
      await chatStore.load(id);
      let finish!: () => void;
      vi.spyOn(chatService, 'stream').mockImplementation(async (_id, input, onEvent) => {
        onEvent({
          type: 'start',
          user: user(input.requestId),
          assistant: assistant(input.requestId, 'streaming'),
        });
        await new Promise<void>((resolve) => {
          finish = () => {
            onEvent({ type: 'done', message: assistant(input.requestId, status) });
            resolve();
          };
        });
      });
      const render = (chatId: string) =>
        renderToStaticMarkup(
          createElement(ConversationStatus, {
            chatId,
            updatedAt: '2026-10-01T00:00:00Z',
            children: 'now',
          }),
        );
      expect(render(id)).toContain('<time');
      chatStore.draft(id, 'Work in the background');
      const pending = chatStore.send(id);
      expect(render(id)).toContain('aria-label="AI is working"');
      expect(render(id)).not.toContain('<time');
      expect(render('private:other-chat')).toContain('<time');
      finish();
      await pending;
      expect(render(id)).toContain('<time');
      expect(render(id)).not.toContain('typing-dots');
    },
  );

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
