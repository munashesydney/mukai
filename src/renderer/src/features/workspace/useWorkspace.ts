import { useCallback, useEffect, useState } from 'react';
import { initialMessages, initialPursuits, initialSpaces } from './data';
import type { Location, Message, Pursuit, Space } from './types';

interface StoredWorkspace {
  messages: Record<string, Message[]>;
  spaces: Space[];
  pursuits: Pursuit[];
  bookmarks: string[];
  reactions: string[];
}
const storageKey = 'mukai.workspace.v1';
const defaults: StoredWorkspace = {
  messages: initialMessages,
  spaces: initialSpaces,
  pursuits: initialPursuits,
  bookmarks: [],
  reactions: [],
};
function loadWorkspace(): StoredWorkspace {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (!value || typeof value !== 'object') return defaults;
    const state = value as Partial<StoredWorkspace>;
    const people = new Set(['atlas', 'nova', 'scout', 'munashe']);
    const isStringArray = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((v) => typeof v === 'string');
    if (
      !state.messages ||
      Array.isArray(state.messages) ||
      typeof state.messages !== 'object' ||
      !Object.values(state.messages).every(
        (list) =>
          Array.isArray(list) &&
          list.every(
            (m) =>
              m &&
              typeof m.id === 'string' &&
              typeof m.text === 'string' &&
              typeof m.time === 'string' &&
              people.has(m.author) &&
              (!m.card || ['pursuit', 'draft'].includes(m.card)) &&
              (!m.attachment || typeof m.attachment === 'string'),
          ),
      ) ||
      !Array.isArray(state.spaces) ||
      !state.spaces.every(
        (s) =>
          s &&
          typeof s.id === 'string' &&
          typeof s.name === 'string' &&
          typeof s.description === 'string',
      ) ||
      !Array.isArray(state.pursuits) ||
      !state.pursuits.every(
        (p) =>
          p &&
          typeof p.id === 'string' &&
          typeof p.name === 'string' &&
          typeof p.description === 'string' &&
          ['atlas', 'nova', 'scout'].includes(p.agent) &&
          typeof p.progress === 'number' &&
          p.progress >= 0 &&
          p.progress <= 100,
      ) ||
      !isStringArray(state.bookmarks) ||
      !isStringArray(state.reactions)
    )
      return defaults;
    return state as StoredWorkspace;
  } catch {
    return defaults;
  }
}

export function useWorkspace() {
  const [state, setState] = useState(loadWorkspace);
  const [storageFailed, setStorageFailed] = useState(false);
  const [history, setHistory] = useState<{ entries: Location[]; index: number }>({
    entries: [{ section: 'spaces', item: 'ai-telegram-copier' }],
    index: 0,
  });
  const location = history.entries[history.index];
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
      setStorageFailed(false);
    } catch {
      setStorageFailed(true);
    }
  }, [state]);
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
  const createSpace = (name: string, description: string) => {
    const id = `${
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'space'
    }-${crypto.randomUUID().slice(0, 6)}`;
    setState((previous) => ({
      ...previous,
      spaces: [
        ...previous.spaces,
        {
          id,
          name: name.toLowerCase().replace(/\s+/g, '-'),
          description: description || 'A new space for your next idea.',
        },
      ],
    }));
    navigate({ section: 'spaces', item: id });
  };
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
          agent: 'atlas',
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
    createSpace,
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
