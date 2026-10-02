import { initialMessages, initialPursuits, initialSpaces } from './data';
import type { Message, Pursuit, Space } from './types';

interface StoredWorkspace {
  messages: Record<string, Message[]>;
  spaces: Space[];
  pursuits: Pursuit[];
  bookmarks: string[];
  reactions: string[];
}
export const workspaceStorageKey = 'mukai.workspace.v1';
const defaults: StoredWorkspace = {
  messages: initialMessages,
  spaces: initialSpaces,
  pursuits: initialPursuits,
  bookmarks: [],
  reactions: [],
};
export function loadWorkspace(storage?: Pick<Storage, 'getItem'>): StoredWorkspace {
  try {
    const value: unknown = JSON.parse(
      (storage ?? localStorage).getItem(workspaceStorageKey) ?? 'null',
    );
    if (!value || typeof value !== 'object') return defaults;
    const state = value as Partial<StoredWorkspace>;
    if (Array.isArray(state.pursuits)) {
      state.pursuits = state.pursuits.map((item) => {
        if (!item || typeof item !== 'object') return item;
        // Preserve saved assignments from the previous workspace schema.
        const { agent: previousBot, ...pursuit } = item as Pursuit & { agent?: Pursuit['bot'] };
        return { ...pursuit, bot: pursuit.bot ?? previousBot } as Pursuit;
      });
    }
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
          ['atlas', 'nova', 'scout'].includes(p.bot) &&
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
