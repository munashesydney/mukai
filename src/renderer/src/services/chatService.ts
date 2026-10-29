import type {
  ChatEvent,
  ChatInput,
  ChatMessage,
  ChatFollowup,
  FollowupAction,
} from '../../../shared/ai';
import { api, apiFetch } from './http';
import { chatRoot as root } from './chatTarget';

export const chatService = {
  history: (id: string) => api<ChatMessage[]>(`${root(id)}/messages`),
  stop: (id: string) => api<{ ok: boolean }>(`${root(id)}/stop`, 'POST'),
  followups: (id: string) => api<ChatFollowup[]>(`${root(id)}/followups`),
  queue: (
    id: string,
    input: { id: string; text: string; attachmentIds?: string[]; botId?: string },
  ) => api<ChatFollowup[]>(`${root(id)}/followups`, 'POST', input),
  updateFollowup: (id: string, input: FollowupAction) =>
    api<ChatFollowup[]>(`${root(id)}/followups`, 'PUT', input),
  async stream(
    id: string,
    input: ChatInput & { botId?: string | null },
    onEvent: (event: ChatEvent) => void,
  ) {
    const response = await apiFetch(`${root(id)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(
        id.startsWith('space:')
          ? {
              requestId: input.requestId,
              text: input.text,
              botId: input.botId ?? null,
              attachmentIds: input.attachmentIds,
            }
          : input,
      ),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The response stream is unavailable.');
    const decoder = new TextDecoder();
    let buffer = '',
      finished = false;
    const dispatch = (line: string) => {
      const payload = line.trim();
      // Blank lines end an SSE event and ':' lines are comments (keepalives).
      if (!payload || payload.startsWith(':')) return;
      const json = payload.startsWith('data:') ? payload.slice(5).trim() : payload;
      if (!json) return;
      const event = JSON.parse(json) as ChatEvent;
      onEvent(event);
      if (event.type === 'done' || event.type === 'error') finished = true;
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          dispatch(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
        if (done) {
          dispatch(buffer);
          break;
        }
      }
      if (!finished)
        throw new Error('The response was interrupted. Your saved message can be retried.');
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  },
};
