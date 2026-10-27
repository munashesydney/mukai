import { useCallback, useEffect, useState } from 'react';
import type { Location, Message } from './types';
import { loadWorkspace, workspaceStorageKey } from './workspaceStorage';
import { activePairConversationKey, loadActiveBotLocation } from './activeBotLocation';
export function useWorkspace(workspaceId = 'default') {
  const storageKey =
    workspaceId === 'default' ? workspaceStorageKey : `${workspaceStorageKey}.${workspaceId}`;
  const [state, setState] = useState(() =>
    loadWorkspace(undefined, storageKey, workspaceId !== 'default'),
  );
  const [storageFailed, setStorageFailed] = useState(false);
  const [history, setHistory] = useState<{ entries: Location[]; index: number }>(() => ({
    entries: [loadActiveBotLocation(workspaceId)],
    index: 0,
  }));
  const location = history.entries[history.index];
  useEffect(() => {
    if (
      location.section === 'bots' &&
      location.item !== 'hierarchy' &&
      (location.item !== 'bot-conversations' || location.conversationId)
    ) {
      try {
        localStorage.setItem(`mukai.active-bot.${workspaceId}`, location.item);
        if (location.conversationId)
          localStorage.setItem(
            location.item === 'bot-conversations'
              ? activePairConversationKey(workspaceId)
              : `mukai.active-conversation.${location.item}`,
            location.conversationId,
          );
      } catch {
        /* Chat data is persisted by the server. */
      }
    }
  }, [location, workspaceId]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
      setStorageFailed(false);
    } catch {
      setStorageFailed(true);
    }
  }, [state, storageKey]);
  const navigate = useCallback((next: Location) => {
    setHistory((previous) => {
      const current = previous.entries[previous.index];
      if (
        current.section === next.section &&
        current.item === next.item &&
        current.conversationId === next.conversationId &&
        current.view === next.view &&
        current.runId === next.runId
      )
        return previous;
      const entries = [...previous.entries.slice(0, previous.index + 1), next];
      return { entries, index: entries.length - 1 };
    });
  }, []);
  const replace = useCallback((next: Location) => {
    setHistory((previous) => ({
      ...previous,
      entries: previous.entries.map((entry, index) => (index === previous.index ? next : entry)),
    }));
  }, []);
  const sendMessage = (text: string, attachment?: string) => {
    const message: Message = {
      id: crypto.randomUUID(),
      author: 'munashe',
      text: text || 'Shared a file',
      time: new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(
        new Date(),
      ),
      attachment,
    };
    setState((previous) => ({
      ...previous,
      messages: {
        ...previous.messages,
        [location.item]: [...(previous.messages[location.item] ?? []), message],
      },
    }));
  };
  const toggle = (key: 'bookmarks' | 'reactions', id: string) =>
    setState((previous) => ({
      ...previous,
      [key]: previous[key].includes(id)
        ? previous[key].filter((value) => value !== id)
        : [...previous[key], id],
    }));
  return {
    ...state,
    location,
    navigate,
    replace,
    sendMessage,
    storageFailed,
    toggleBookmark: (id: string) => toggle('bookmarks', id),
    toggleReaction: (id: string) => toggle('reactions', id),
    canBack: history.index > 0,
    canForward: history.index < history.entries.length - 1,
    back: () => setHistory((p) => ({ ...p, index: Math.max(0, p.index - 1) })),
    forward: () =>
      setHistory((p) => ({ ...p, index: Math.min(p.entries.length - 1, p.index + 1) })),
  };
}
