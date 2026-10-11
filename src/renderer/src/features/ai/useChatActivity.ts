import { useEffect, useMemo, useState } from 'react';
import type { Bot, ChatMessage, FileArtifact } from '../../../../shared/ai';
import type { ChatServerOutput } from '../../../../shared/chatActivity';
import { chatActivityService } from '../../services/chatActivityService';
import { artifactService } from '../../services/artifactService';
import { chatActivityData } from './chatActivityData';

export function useChatActivity(
  conversationId: string,
  messages: ChatMessage[],
  bots: Bot[],
  botId: string,
) {
  const [outputs, setOutputs] = useState<ChatServerOutput[]>([]);
  const [artifacts, setArtifacts] = useState<FileArtifact[]>([]);
  const [error, setError] = useState('');
  const revision = messages
    .filter((message) => message.role === 'assistant')
    .map((message) => `${message.id}:${message.status}`)
    .join('|');
  useEffect(() => {
    let alive = true,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      const results = await Promise.allSettled([
        chatActivityService.outputs(conversationId),
        artifactService.forConversation(conversationId),
      ]);
      if (alive) {
        if (results[0].status === 'fulfilled') setOutputs(results[0].value);
        if (results[1].status === 'fulfilled') setArtifacts(results[1].value);
        setError(
          results.some((result) => result.status === 'rejected')
            ? 'Some activity could not be refreshed. Retrying…'
            : '',
        );
      }
      pending = false;
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [conversationId, revision]);
  const data = useMemo(
    () => chatActivityData(messages, outputs, artifacts, bots),
    [messages, outputs, artifacts, bots],
  );
  const storageKey = `mukai.chat-activity.${conversationId}`;
  const [preference, setPreference] = useState<boolean | null>(() => {
    try {
      const value = localStorage.getItem(storageKey);
      return value === null ? null : value === 'open';
    } catch {
      return null;
    }
  });
  function setOpen(open: boolean) {
    setPreference(open);
    try {
      localStorage.setItem(storageKey, open ? 'open' : 'closed');
    } catch {
      /* Optional preference. */
    }
  }
  return {
    ...data,
    botId,
    conversationId,
    error,
    open: data.count > 0 && (preference ?? true),
    setOpen,
  };
}
