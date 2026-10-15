import { useEffect, useSyncExternalStore } from 'react';
import type { ChatEvent, FollowupAction } from '../../../../shared/ai';
import { UPLOAD_LIMIT, ATTACHMENT_LIMIT } from '../../../../shared/ai';
import { appendResponseText, upsertResponsePart } from '../../../../shared/responseParts';
import { chatService } from '../../services/chatService';
import { attachmentService } from '../../services/attachmentService';
import { errorText } from '../../utils/errors';
import type { ChatState, ChatDraft } from '../../models/chat';
import { conversationService } from '../../services/conversationService';
import { chatConversationId } from '../../services/chatTarget';
import { approvalStore } from './approvalStore';

const states = new Map<string, ChatState>();
const listeners = new Set<() => void>();
const active = new Set<string>();
const loading = new Set<string>();
const forgotten = new Set<string>();
const followupWatching = new Set<string>();
const followupVersions = new Map<string, number>();
function get(id: string) {
  if (!states.has(id)) {
    let text = '',
      requestId = crypto.randomUUID();
    try {
      const saved = JSON.parse(
        localStorage.getItem(`mukai.draft.${id}`) ||
          (id.startsWith('private:bot-')
            ? localStorage.getItem(`mukai.draft.${id.slice(12)}`)
            : null) ||
          'null',
      ) as Partial<ChatDraft> | null;
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
      followups: [],
      submittingFollowup: false,
    });
  }
  return states.get(id)!;
}
function update(id: string, value: Partial<ChatState>) {
  if (forgotten.has(id)) return;
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
  forget(ids: string[]) {
    for (const id of ids) {
      forgotten.add(id);
      states.delete(id);
      active.delete(id);
      loading.delete(id);
      followupWatching.delete(id);
      followupVersions.delete(id);
    }
    listeners.forEach((listener) => listener());
  },
  async load(id: string) {
    if (forgotten.has(id)) return;
    if (active.has(id) || loading.has(id) || get(id).uploading) return;
    loading.add(id);
    const previous = get(id);
    try {
      const [messages, files, followups] = await Promise.all([
        chatService.history(id),
        id.startsWith('space:') ? Promise.resolve([]) : attachmentService.pending(id),
        chatService.followups(id),
      ]);
      if (active.has(id) || get(id).messages !== previous.messages) return;
      const accepted = messages.find(
        (message) => message.role === 'user' && message.requestId === previous.requestId,
      );
      const acceptedFollowup = followups.find((item) => item.id === previous.requestId);
      const appliedFollowup = messages
        .flatMap((message) => message.parts || [])
        .find((part) => part.type === 'steering' && part.id === previous.requestId);
      if (!messages.some((message) => message.status === 'streaming') && !followups.length)
        followupWatching.delete(id);
      update(id, {
        messages,
        followups,
        files: get(id).files === previous.files ? files : get(id).files,
        loading: false,
        busy: messages.some((message) => message.status === 'streaming'),
        error: '',
        ...(accepted || acceptedFollowup || appliedFollowup
          ? {
              text:
                get(id).text.trim() ===
                (accepted?.content ||
                  acceptedFollowup?.text ||
                  (appliedFollowup?.type === 'steering' ? appliedFollowup.text : ''))
                  ? ''
                  : get(id).text,
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
  async queue(id: string, botId?: string | null) {
    const state = get(id);
    if (state.submittingFollowup || state.uploading || !state.text.trim()) return;
    if (state.files.length) {
      update(id, {
        error: 'Send attachments after this response finishes. Follow-ups currently support text.',
      });
      return;
    }
    update(id, { submittingFollowup: true, error: '' });
    followupWatching.add(id);
    const version = followupVersions.get(id) || 0;
    try {
      const followups = await chatService.queue(id, {
        id: state.requestId,
        text: state.text.trim(),
        ...(botId ? { botId } : {}),
      });
      update(id, {
        ...((followupVersions.get(id) || 0) === version ? { followups } : {}),
        ...(get(id).requestId === state.requestId
          ? {
              text: get(id).text === state.text ? '' : get(id).text,
              requestId: crypto.randomUUID(),
            }
          : {}),
      });
    } catch (caught) {
      update(id, { error: errorText(caught) });
    } finally {
      update(id, { submittingFollowup: false });
    }
  },
  async followup(id: string, input: FollowupAction) {
    if (get(id).submittingFollowup) return false;
    update(id, { submittingFollowup: true, error: '' });
    followupWatching.add(id);
    const version = followupVersions.get(id) || 0;
    try {
      const followups = await chatService.updateFollowup(id, input);
      if ((followupVersions.get(id) || 0) === version) update(id, { followups });
      return true;
    } catch (caught) {
      update(id, { error: errorText(caught) });
      return false;
    } finally {
      update(id, { submittingFollowup: false });
    }
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
        const attachment = await attachmentService.upload(id, file);
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
      await attachmentService.remove(fileId);
      update(id, { files: get(id).files.filter((file) => file.id !== fileId) });
    } catch (error) {
      update(id, { error: errorText(error) });
    }
  },
  async send(id: string, retryId?: string, botId?: string | null) {
    if (get(id).busy && !retryId) return chatStore.queue(id, botId);
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
    let accepted = false;
    const accept = () => {
      accepted = true;
      if (!retryId) update(id, { text: '', files: [], requestId: crypto.randomUUID() });
    };
    try {
      const handle = (event: ChatEvent) => {
        if (event.type === 'followups') {
          followupVersions.set(id, (followupVersions.get(id) || 0) + 1);
          if (event.followups.length) followupWatching.add(id);
          update(id, { followups: event.followups });
        } else if (event.type === 'approval') {
          void approvalStore.refresh();
        } else if (event.type === 'start') {
          accept();
          const previous = get(id).messages.filter((message) => message.requestId !== requestId);
          update(id, { messages: [...previous, event.user, event.assistant] });
        } else if (event.type === 'delta')
          update(id, {
            messages: get(id).messages.map((message) =>
              message.id === event.id
                ? {
                    ...message,
                    content: message.content + event.text,
                    parts: event.partId
                      ? appendResponseText(message.parts || [], event.partId, 'text', event.text)
                      : message.parts,
                  }
                : message,
            ),
          });
        else if (event.type === 'reasoning')
          update(id, {
            messages: get(id).messages.map((message) =>
              message.id === event.id
                ? {
                    ...message,
                    reasoning: (message.reasoning || '') + event.text,
                    parts: event.partId
                      ? appendResponseText(
                          message.parts || [],
                          event.partId,
                          'reasoning',
                          event.text,
                        )
                      : message.parts,
                  }
                : message,
            ),
          });
        else if (event.type === 'context')
          update(id, {
            messages: get(id).messages.map((message) =>
              message.id === event.id ? { ...message, contextUsage: event.usage } : message,
            ),
          });
        else if (event.type === 'part')
          update(id, {
            messages: get(id).messages.map((message) =>
              message.id === event.id
                ? { ...message, parts: upsertResponsePart(message.parts || [], event.part) }
                : message,
            ),
          });
        else if (event.type === 'activity')
          update(id, {
            messages: get(id).messages.map((message) =>
              message.id === event.id
                ? {
                    ...message,
                    ...(event.changes ? { changes: event.changes } : {}),
                    activity: message.activity?.some((item) => item.id === event.activity.id)
                      ? message.activity.map((item) =>
                          item.id === event.activity.id ? event.activity : item,
                        )
                      : [...(message.activity || []), event.activity],
                  }
                : message,
            ),
          });
        else {
          if (!accepted) accept();
          update(id, {
            messages: get(id).messages.some((message) => message.id === event.message.id)
              ? get(id).messages.map((message) =>
                  message.id === event.message.id ? event.message : message,
                )
              : [...get(id).messages, event.message],
          });
        }
      };
      await chatService.stream(
        id,
        {
          requestId,
          text: retryId ? '' : state.text,
          attachmentIds: retryId ? [] : state.files.map((file) => file.id),
          ...(id.startsWith('space:')
            ? {
                botId: retryId
                  ? state.messages.find(
                      (message) => message.requestId === retryId && message.role === 'assistant',
                    )?.botId || botId
                  : botId,
              }
            : {}),
        },
        handle,
      );
    } catch (error) {
      // Recover acceptance after a transport failure before the first stream event.
      try {
        const messages = await chatService.history(id);
        if (!accepted && messages.some((message) => message.requestId === requestId)) accept();
        update(id, { messages });
      } catch {
        /* Keep the draft and its request ID: resending is idempotent. */
      }
      update(id, { error: errorText(error) });
    } finally {
      active.delete(id);
      update(id, { busy: get(id).messages.some((message) => message.status === 'streaming') });
      if (followupWatching.has(id)) await chatStore.load(id);
    }
  },
  async stop(id: string) {
    try {
      await chatService.stop(id);
    } catch (error) {
      update(id, { error: errorText(error) });
    }
  },
  async save(id: string, messageId: string, saved: boolean) {
    try {
      const message = await conversationService.save(chatConversationId(id), messageId, saved);
      update(id, {
        messages: get(id).messages.map((item) =>
          item.id === messageId ? { ...item, saved: message.saved } : item,
        ),
      });
    } catch (caught) {
      update(id, { error: errorText(caught) });
    }
  },
};
function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function useConversationsBusy(ids: string[]) {
  return useSyncExternalStore(
    subscribe,
    () => ids.some((id) => states.get(id)?.busy),
    () => ids.some((id) => states.get(id)?.busy),
  );
}

export function useChatBusy(id: string) {
  const busy = useConversationsBusy([id]);
  useEffect(() => {
    if (!busy) return;
    // Keep a recovered/background response current after its chat view unmounts.
    const timer = window.setInterval(() => {
      if (!active.has(id)) void chatStore.load(id);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [id, busy]);
  return busy;
}

export function useChat(id: string, readOnly = false) {
  const state = useSyncExternalStore(
    subscribe,
    () => get(id),
    () => get(id),
  );
  useEffect(() => {
    void chatStore.load(id);
    const timer = window.setInterval(() => {
      if (
        !active.has(id) &&
        (get(id).busy || readOnly || get(id).followups.length || followupWatching.has(id))
      )
        void chatStore.load(id);
    }, 1000);
    const refresh = () => {
      if (!active.has(id)) void chatStore.load(id);
    };
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [id, readOnly]);
  return state;
}
