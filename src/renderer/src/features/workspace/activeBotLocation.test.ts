import { expect, it } from 'vitest';
import { loadActiveBotLocation } from './activeBotLocation';

const storage = (entries: Record<string, string>) => ({
  getItem: (key: string) => entries[key] ?? null,
});

it('restores the exact saved private conversation', () => {
  expect(
    loadActiveBotLocation(
      'work',
      storage({
        'mukai.active-bot.work': 'ada',
        'mukai.active-conversation.ada': 'older-chat',
      }),
    ),
  ).toEqual({ section: 'bots', item: 'ada', conversationId: 'older-chat' });
});

it('restores each workspace’s own bot pair conversation', () => {
  const saved = storage({
    'mukai.active-bot.one': 'bot-conversations',
    'mukai.active-bot.two': 'bot-conversations',
    'mukai.active-pair-conversation.one': 'pair-one',
    'mukai.active-pair-conversation.two': 'pair-two',
    'mukai.active-conversation.bot-conversations': 'old-global-pair',
  });
  expect(loadActiveBotLocation('one', saved)).toEqual({
    section: 'bots',
    item: 'bot-conversations',
    conversationId: 'pair-one',
  });
  expect(loadActiveBotLocation('two', saved)).toEqual({
    section: 'bots',
    item: 'bot-conversations',
    conversationId: 'pair-two',
  });
});

it('recovers bot pair selections saved before workspace-scoped pair preferences', () => {
  expect(
    loadActiveBotLocation(
      'work',
      storage({
        'mukai.active-bot.work': 'bot-conversations',
        'mukai.active-conversation.bot-conversations': 'last-pair',
      }),
    ),
  ).toEqual({ section: 'bots', item: 'bot-conversations', conversationId: 'last-pair' });
});

it('supports the legacy default bot preference without using it for other workspaces', () => {
  const saved = storage({ 'mukai.active-bot': 'ada', 'mukai.active-conversation.ada': 'chat' });
  expect(loadActiveBotLocation('default', saved)).toEqual({
    section: 'bots',
    item: 'ada',
    conversationId: 'chat',
  });
  expect(loadActiveBotLocation('other', saved)).toEqual({ section: 'bots', item: 'scout' });
});

it('avoids an empty pair view when its saved conversation is missing or storage is unavailable', () => {
  expect(
    loadActiveBotLocation('work', storage({ 'mukai.active-bot.work': 'bot-conversations' })),
  ).toEqual({ section: 'bots', item: 'scout' });
  expect(
    loadActiveBotLocation('work', {
      getItem: () => {
        throw new Error('Storage unavailable');
      },
    }),
  ).toEqual({ section: 'bots', item: 'scout' });
});
