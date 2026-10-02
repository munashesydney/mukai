import { useCallback, useEffect, useState } from 'react';
import type { Location, Message } from './types';
import { loadWorkspace, workspaceStorageKey } from './workspaceStorage';
export function useWorkspace(workspaceId = 'default') {
  const storageKey =
    workspaceId === 'default' ? workspaceStorageKey : `${workspaceStorageKey}.${workspaceId}`;
  const [state, setState] = useState(() =>
    loadWorkspace(undefined, storageKey, workspaceId !== 'default'),
  );
  const [storageFailed, setStorageFailed] = useState(false);
  const [history, setHistory] = useState<{ entries: Location[]; index: number }>({
    entries: [
      {
        section: 'bots',
        item: (() => {
          try {
            return (
              localStorage.getItem(`mukai.active-bot.${workspaceId}`) ||
              (workspaceId === 'default' ? localStorage.getItem('mukai.active-bot') : null) ||
              'scout'
            );
          } catch {
            return 'scout';
          }
        })(),
      },
    ],
    index: 0,
  });
  const location = history.entries[history.index];
  useEffect(() => {
    if (location.section === 'bots') {
      try {
        localStorage.setItem(`mukai.active-bot.${workspaceId}`, location.item);
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
      if (current.section === next.section && current.item === next.item) return previous;
      const entries = [...previous.entries.slice(0, previous.index + 1), next];
      return { entries, index: entries.length - 1 };
    });
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
  const createPursuit = (name: string, description: string) => {
    const id = crypto.randomUUID();
    setState((previous) => ({
      ...previous,
      pursuits: [
        ...previous.pursuits,
        {
          id,
          name,
          description: description || 'One small step at a time.',
          bot: 'atlas',
          progress: 0,
        },
      ],
    }));
    navigate({ section: 'pursuits', item: id });
  };
  const togglePaused = (id: string) =>
    setState((previous) => ({
      ...previous,
      pursuits: previous.pursuits.map((p) => (p.id === id ? { ...p, paused: !p.paused } : p)),
    }));
  return {
    ...state,
    location,
    navigate,
    sendMessage,
    storageFailed,
    createPursuit,
    togglePaused,
    toggleBookmark: (id: string) => toggle('bookmarks', id),
    toggleReaction: (id: string) => toggle('reactions', id),
    canBack: history.index > 0,
    canForward: history.index < history.entries.length - 1,
    back: () => setHistory((p) => ({ ...p, index: Math.max(0, p.index - 1) })),
    forward: () =>
      setHistory((p) => ({ ...p, index: Math.min(p.entries.length - 1, p.index + 1) })),
  };
}
