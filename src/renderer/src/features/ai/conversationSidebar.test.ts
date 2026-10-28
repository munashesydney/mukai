import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Conversation } from '../../../../shared/conversations';
import type { Bot } from '../../../../shared/ai';
import { BotPairConversationsSidebar } from './BotPairConversationsSidebar';
import { WorkspaceSidebar } from '../../components/layout/WorkspaceSidebar';
import { BotConversationStatus, ConversationStatus } from './ConversationStatus';
import {
  botConversationGroup,
  botsByRecentInteraction,
  visibleConversations,
  activeConversationGroup,
} from './conversationSidebar';

vi.mock('./approvalStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./approvalStore')>()),
  useApprovals: () => ({ pending: [] }),
}));

const chat = (id: string, isWorking = false): Conversation => ({
  id,
  workspaceId: 'workspace',
  kind: 'bot',
  name: `Task ${id}`,
  description: '',
  botIds: ['caller', 'receiver'],
  ownerBotId: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  isWorking,
});

describe('Background conversation activity', () => {
  it('shows server-reported work without opening or loading the conversation', () => {
    expect(
      renderToStaticMarkup(
        createElement(BotConversationStatus, { conversations: [chat('1', true)] }),
      ),
    ).toContain('AI is working');
    expect(
      renderToStaticMarkup(createElement(BotConversationStatus, { conversations: [chat('1')] })),
    ).toBe('');
    expect(
      renderToStaticMarkup(
        createElement(ConversationStatus, {
          chatId: 'space:1',
          isWorking: true,
          updatedAt: chat('1').updatedAt,
          children: 'now',
        }),
      ),
    ).not.toContain('<time');
  });

  it('keeps collapsed groups closed and moves activity to individual chats when expanded', () => {
    const conversations = [chat('1', true), chat('2', true)];
    const bots = [
      { id: 'caller', name: 'Caller', avatar: 'nova' },
      { id: 'receiver', name: 'Receiver', avatar: 'nova' },
    ] as Bot[];
    const render = (conversationId?: string) =>
      renderToStaticMarkup(
        createElement(BotPairConversationsSidebar, {
          bots,
          conversations,
          location: { section: 'bots', item: 'bot-conversations', conversationId },
          expandedGroup: conversationId ? 'pair:caller/receiver' : null,
          onToggleGroup: () => {},
          onSelect: () => {},
          loading: false,
          error: '',
          onRefresh: () => {},
        }),
      );
    const collapsed = render();
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed.match(/AI is working/g)).toHaveLength(1);
    expect(collapsed).not.toContain('Task 1');
    const expanded = render('1');
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded.match(/AI is working/g)).toHaveLength(2);
    expect(expanded).toContain('Task 1');
    expect(expanded).toContain('Task 2');
  });

  it('expands and highlights a linked pair conversation beyond the initial three rows', () => {
    const markup = renderToStaticMarkup(
      createElement(BotPairConversationsSidebar, {
        bots: [
          { id: 'caller', name: 'Caller', avatar: 'nova' },
          { id: 'receiver', name: 'Receiver', avatar: 'nova' },
        ] as Bot[],
        conversations: ['1', '2', '3', '4', '5'].map((id) => chat(id)),
        location: { section: 'bots', item: 'bot-conversations', conversationId: '5' },
        expandedGroup: 'pair:caller/receiver',
        onToggleGroup: () => {},
        onSelect: () => {},
        loading: false,
        error: '',
        onRefresh: () => {},
      }),
    );
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('is-selected" aria-current="page" title="Task 5"');
    expect(markup).not.toContain('title="Task 4"');
  });

  it('keeps older working conversations visible and attributes delegation to its receiver', () => {
    const values = [chat('1'), chat('2'), chat('3'), chat('4', true), chat('5')];
    expect(visibleConversations(values, 3).map((value) => value.id)).toEqual(['1', '2', '3', '4']);
    expect(botConversationGroup(chat('4', true))).toBe('receiver');
    expect(botConversationGroup({ ...chat('1'), kind: 'private', ownerBotId: 'owner' })).toBe(
      'owner',
    );
  });
});

it('expands only the active branch and highlights a pair conversation only once', () => {
  const bots = [
    { id: 'caller', name: 'Caller', avatar: 'nova' },
    { id: 'receiver', name: 'Receiver', avatar: 'nova' },
    { id: 'other', name: 'Other', avatar: 'nova' },
  ] as Bot[];
  const pair = chat('pair');
  const otherPair = { ...chat('other-pair'), botIds: ['caller', 'other'] };
  const privateChat = { ...chat('private'), kind: 'private' as const, ownerBotId: 'receiver' };
  const render = (location: import('../workspace/types').Location) =>
    renderToStaticMarkup(
      createElement(WorkspaceSidebar, {
        location,
        bots,
        spaces: [],
        pursuits: [],
        workspaces: [],
        botConversations: [privateChat],
        botPairConversations: [pair, otherPair],
        botPairLoading: false,
        botPairError: '',
        collapsed: false,
        onSelect() {},
        onDialog() {},
        onSettings() {},
        onRefreshBotPairs() {},
        onCreateConversation: async () => {},
        onWorkspace() {},
        onCreateWorkspace() {},
      }),
    );
  const pairMarkup = render({
    section: 'bots',
    item: 'bot-conversations',
    conversationId: pair.id,
  });
  expect(pairMarkup.match(/is-selected/g)).toHaveLength(1);
  expect(pairMarkup).not.toMatch(/bot-row bot-conversation-parent" aria-expanded="true"/);
  expect(pairMarkup).toContain('aria-label="Caller/Receiver" aria-expanded="true"');
  expect(pairMarkup).toContain('aria-label="Caller/Other" aria-expanded="false"');
  const privateMarkup = render({
    section: 'bots',
    item: 'receiver',
    conversationId: privateChat.id,
  });
  expect(privateMarkup.match(/is-selected/g)).toHaveLength(1);
  expect(
    privateMarkup.match(/bot-row bot-conversation-parent" aria-expanded="true"/g),
  ).toHaveLength(1);
  expect(privateMarkup).not.toContain('bot-pair-conversation-groups');
  expect(activeConversationGroup({ section: 'bots', item: 'hierarchy' }, [pair])).toBeNull();
});

it('orders bots by their latest conversation interaction without pinning the main bot', () => {
  const bots = [
    { id: 'main', isMain: true },
    { id: 'child', isMain: false },
    { id: 'idle', isMain: false },
  ] as Bot[];
  const conversations = [
    {
      ...chat('old'),
      kind: 'private' as const,
      ownerBotId: 'main',
      updatedAt: '2026-10-01T00:00:00Z',
    },
    {
      ...chat('new'),
      kind: 'private' as const,
      ownerBotId: 'child',
      updatedAt: '2026-10-02T00:00:00Z',
    },
  ];
  expect(botsByRecentInteraction(bots, conversations).map((bot) => bot.id)).toEqual([
    'child',
    'main',
    'idle',
  ]);
  conversations.push({ ...conversations[0], id: 'latest', updatedAt: '2026-10-03T00:00:00Z' });
  expect(botsByRecentInteraction(bots, conversations).map((bot) => bot.id)).toEqual([
    'main',
    'child',
    'idle',
  ]);
  expect(bots.map((bot) => bot.id)).toEqual(['main', 'child', 'idle']);
});
