import type { ChatEvent, ChatInput, ChatMessage } from '../../../shared/ai';
import { api, apiFetch } from './http';
import { chatRoot as root } from './chatTarget';

export const chatService = {
  history: (id: string) => api<ChatMessage[]>(`${root(id)}/messages`),
  stop: (id: string) => api<{ ok: boolean }>(`${root(id)}/stop`, 'POST'),
  async stream(
    id: string,
    input: ChatInput & { botId?: string | null },
    onEvent: (event: ChatEvent) => void,
  ) {
    const response = await apiFetch(`${root(id)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        id.startsWith('space:')
          ? { requestId: input.requestId, text: input.text, botId: input.botId ?? null }
          : input,
      ),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The response stream is unavailable.');
    const decoder = new TextDecoder();
    let buffer = '',
      finished = false;
    const dispatch = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as ChatEvent;
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
