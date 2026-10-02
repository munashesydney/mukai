import { useEffect, useSyncExternalStore } from 'react';
import type { Attachment, ChatEvent, ChatMessage } from '../../../../shared/ai';
import { UPLOAD_LIMIT, ATTACHMENT_LIMIT } from '../../../../shared/ai';
import { api, apiFetch, errorText } from './api';

interface ChatState {
  messages: ChatMessage[];
  loading: boolean;
  busy: boolean;
  error: string;
  text: string;
  files: Attachment[];
  uploading: boolean;
  requestId: string;
}
const states = new Map<string, ChatState>();
const listeners = new Set<() => void>();
const active = new Set<string>();
const loading = new Set<string>();
function get(id: string) {
  if (!states.has(id)) {
    let text = '',
      requestId = crypto.randomUUID();
    try {
      const saved = JSON.parse(localStorage.getItem(`mukai.draft.${id}`) || 'null') as {
        text?: string;
        requestId?: string;
      } | null;
      if (
        typeof saved?.text === 'string' &&
        saved.text.length <= 16000 &&
        typeof saved.requestId === 'string' &&
        /^[a-f0-9-]{36}$/i.test(saved.requestId)
      ) {
        text = saved.text;
        requestId = saved.requestId as typeof requestId;
      }
    } catch {
      /* Server-side messages remain authoritative if device storage is unavailable. */
    }
    states.set(id, {
      messages: [],
      loading: true,
      busy: false,
      error: '',
      text,
      files: [],
      uploading: false,
      requestId,
    });
  }
  return states.get(id)!;
}
function update(id: string, value: Partial<ChatState>) {
  states.set(id, { ...get(id), ...value });
  if (value.text !== undefined || value.requestId !== undefined) {
    try {
      const state = get(id);
      localStorage.setItem(
        `mukai.draft.${id}`,
        JSON.stringify({ text: state.text, requestId: state.requestId }),
      );
    } catch {
      /* An unavailable draft cache never prevents sending to the durable backend. */
    }
  }
  listeners.forEach((listener) => listener());
}
export const chatStore = {
  async load(id: string) {
    if (active.has(id) || loading.has(id) || get(id).uploading) return;
    loading.add(id);
    const previous = get(id);
    try {
      const [messages, files] = await Promise.all([
        api<ChatMessage[]>(`/bots/${id}/messages`),
        api<Attachment[]>(`/bots/${id}/attachments`),
      ]);
      if (active.has(id) || get(id).messages !== previous.messages) return;
      const accepted = messages.find(
        (message) => message.role === 'user' && message.requestId === previous.requestId,
      );
      update(id, {
        messages,
        files: get(id).files === previous.files ? files : get(id).files,
        loading: false,
        busy: messages.some((message) => message.status === 'streaming'),
        error: '',
        ...(accepted
          ? {
              text: get(id).text.trim() === accepted.content ? '' : get(id).text,
              requestId: crypto.randomUUID(),
            }
          : {}),
      });
    } catch (error) {
      update(id, { loading: false, error: errorText(error) });
    } finally {
      loading.delete(id);
    }
  },
  draft(id: string, text: string) {
    update(id, { text });
  },
  async upload(id: string, files: File[]) {
    if (get(id).uploading || get(id).busy) return;
    if (get(id).files.length + files.length > ATTACHMENT_LIMIT) {
      update(id, { error: 'Attach up to four files per message.' });
      return;
    }
    if (files.some((file) => file.size > UPLOAD_LIMIT || file.size === 0)) {
      update(id, { error: 'Each file must be between 1 byte and 10 MB.' });
      return;
    }
    update(id, { uploading: true, error: '' });
    try {
      for (const file of files) {
        const response = await apiFetch(`/bots/${id}/attachments`, {
          method: 'POST',
          headers: {
            'X-Filename': encodeURIComponent(file.name),
            'Content-Type': 'application/octet-stream',
          },
          body: file,
        });
        const attachment = (await response.json()) as Attachment;
        update(id, { files: [...get(id).files, attachment] });
      }
    } catch (error) {
      update(id, { error: errorText(error) });
    } finally {
      update(id, { uploading: false });
    }
  },
  async removeFile(id: string, fileId: string) {
    try {
      await api(`/attachments/${fileId}`, 'DELETE');
      update(id, { files: get(id).files.filter((file) => file.id !== fileId) });
    } catch (error) {
      update(id, { error: errorText(error) });
    }
  },
  async send(id: string, retryId?: string) {
    if (get(id).error && !retryId) {
      await chatStore.load(id);
      if (get(id).error) return;
    }
    const state = get(id);
    if (state.busy || state.uploading || (!retryId && !state.text.trim() && !state.files.length))
      return;
    const requestId = retryId || state.requestId;
    active.add(id);
    update(id, { busy: true, error: '' });
    let accepted = false,
      finished = false;
    const accept = () => {
      accepted = true;
      if (!retryId) update(id, { text: '', files: [], requestId: crypto.randomUUID() });
    };
    try {
      const response = await apiFetch(`/bots/${id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          text: retryId ? '' : state.text,
          attachmentIds: retryId ? [] : state.files.map((file) => file.id),
        }),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('The response stream is unavailable.');
      const decoder = new TextDecoder();
      let buffer = '';
      const handle = (event: ChatEvent) => {
        if (event.type === 'start') {
          accept();
          const previous = get(id).messages.filter((message) => message.requestId !== requestId);
          update(id, { messages: [...previous, event.user, event.assistant] });
        } else if (event.type === 'delta')
          update(id, {
            messages: get(id).messages.map((message) =>
              message.id === event.id
                ? { ...message, content: message.content + event.text }
                : message,
            ),
          });
        else {
          finished = true;
          update(id, {
            messages: get(id).messages.map((message) =>
              message.id === event.message.id ? event.message : message,
            ),
          });
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line) handle(JSON.parse(line) as ChatEvent);
        }
        if (done) break;
      }
      if (!finished)
        throw new Error('The response was interrupted. Your saved message can be retried.');
    } catch (error) {
      // Recover acceptance after a transport failure before the first stream event.
      try {
        const messages = await api<ChatMessage[]>(`/bots/${id}/messages`);
        if (!accepted && messages.some((message) => message.requestId === requestId)) accept();
        update(id, { messages });
      } catch {
        /* Keep the draft and its request ID: resending is idempotent. */
      }
      update(id, { error: errorText(error) });
    } finally {
      active.delete(id);
      update(id, { busy: get(id).messages.some((message) => message.status === 'streaming') });
    }
  },
  async stop(id: string) {
    try {
      await api(`/bots/${id}/stop`, 'POST');
    } catch (error) {
      update(id, { error: errorText(error) });
    }
  },
};
export function useChat(id: string) {
  const state = useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => get(id),
  );
  useEffect(() => {
    void chatStore.load(id);
    const timer = window.setInterval(() => {
      if (!active.has(id) && get(id).busy) void chatStore.load(id);
    }, 1000);
    const refresh = () => {
      if (!active.has(id)) void chatStore.load(id);
    };
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [id]);
  return state;
}
