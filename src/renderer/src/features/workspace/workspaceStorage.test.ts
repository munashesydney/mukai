import { describe, expect, it } from 'vitest';
import { initialMessages, initialPursuits, initialSpaces } from './data';
import { loadWorkspace } from './workspaceStorage';

const savedWorkspace = {
  messages: initialMessages,
  spaces: [...initialSpaces, { id: 'saved-space', name: 'saved-space', description: 'Keep this.' }],
  pursuits: [
    {
      id: 'saved-pursuit',
      name: 'My pursuit',
      description: 'Keep this too.',
      progress: 42,
      paused: true,
      bot: 'scout',
    },
  ],
  bookmarks: ['home-1'],
  reactions: ['home-2'],
};
const storage = (value: unknown) => ({ getItem: () => JSON.stringify(value) });

describe('workspace storage compatibility', () => {
  it('migrates prior assignments without discarding the saved workspace', () => {
    const { bot, ...pursuit } = savedWorkspace.pursuits[0];
    const workspace = loadWorkspace(
      storage({ ...savedWorkspace, pursuits: [{ ...pursuit, agent: bot }] }),
    );
    expect(workspace).toEqual(savedWorkspace);
    expect(workspace.pursuits[0]).not.toHaveProperty('agent');
  });

  it('loads the current bot schema without changing saved data', () => {
    expect(loadWorkspace(storage(savedWorkspace))).toEqual(savedWorkspace);
  });

  it('still rejects invalid assignments after migration', () => {
    const workspace = loadWorkspace(
      storage({ ...savedWorkspace, pursuits: [{ ...savedWorkspace.pursuits[0], bot: 'unknown' }] }),
    );
    expect(workspace.spaces).toEqual(initialSpaces);
    expect(workspace.pursuits).toEqual(initialPursuits);
  });
});
