import { expect, it } from 'vitest';
import { clearDeletedWorkspaceStorage } from './deletionStorage';
it('clears only deleted workspace preferences and conversation drafts', () => {
  const storage = new Map([
    ['mukai.workspace.v1.gone', 'data'],
    ['mukai.active-bot.gone', 'bot'],
    ['mukai.active-conversation.bot', 'chat'],
    ['mukai.draft.private:chat', 'draft'],
    ['mukai.draft.space:chat', 'draft'],
    ['mukai.draft.bot', 'legacy draft'],
    ['mukai.workspace.v1.keep', 'keep'],
    ['mukai.draft.private:other', 'keep'],
  ]);
  clearDeletedWorkspaceStorage(
    {
      removeItem: (key) => {
        storage.delete(key);
      },
    },
    'gone',
    { deleted: true, botIds: ['bot'], conversationIds: ['chat'] },
  );
  expect([...storage.keys()]).toEqual(['mukai.workspace.v1.keep', 'mukai.draft.private:other']);
});
it('also removes default workspace legacy preferences', () => {
  const keys: string[] = [];
  clearDeletedWorkspaceStorage(
    {
      removeItem: (key) => {
        keys.push(key);
      },
    },
    'default',
    { deleted: true, botIds: [], conversationIds: [] },
  );
  expect(keys).toEqual(['mukai.workspace.v1', 'mukai.active-bot.default', 'mukai.active-bot']);
});
