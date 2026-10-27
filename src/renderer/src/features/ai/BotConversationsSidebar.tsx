import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, MessageCirclePlus, Hand } from 'lucide-react';
import { useApprovals } from './approvalStore';
import type { Bot } from '../../../../shared/ai';
import type { Conversation } from '../../../../shared/conversations';
import type { Location } from '../workspace/types';
import { Avatar } from '../../components/ui/Avatar';
import { IconButton } from '../../components/ui/IconButton';
import { errorText } from '../../utils/errors';
import { BotConversationStatus, ConversationStatus } from './ConversationStatus';
import {
  botConversationGroup,
  botsByRecentInteraction,
  visibleConversations,
} from './conversationSidebar';

import { MainBotBadge } from '../../components/ui/MainBotBadge';

const INITIAL_CONVERSATION_COUNT = 3;

function age(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return minutes < 1
    ? 'now'
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
}

export function BotConversationsSidebar({
  bots,
  conversations,
  location,
  onSelect,
  onCreate,
  expandedGroup,
  onToggleGroup,
}: {
  bots: Bot[];
  conversations: Conversation[];
  location: Location;
  onSelect: (location: Location) => void;
  onCreate: (botId: string) => Promise<void>;
  expandedGroup: string | null;
  onToggleGroup: (group: string) => void;
}) {
  const approvals = useApprovals();
  const selectedRow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [location.section, location.item, location.conversationId, location.view, expandedGroup]);
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const [creating, setCreating] = useState<string | null>(null),
    [error, setError] = useState('');
  async function create(botId: string) {
    if (creating) return;
    setCreating(botId);
    setError('');
    try {
      await onCreate(botId);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setCreating(null);
    }
  }
  return (
    <div className="bot-conversation-groups">
      {error && (
        <p className="ai-alert" role="alert">
          {error}
        </p>
      )}
      {botsByRecentInteraction(bots, conversations).map((bot) => {
        const open = expandedGroup === `bot:${bot.id}`;
        const activeConversationId =
          location.section === 'bots' && location.item === bot.id && !location.view
            ? location.conversationId
            : undefined;
        const chats = conversations
          .filter((conversation) => botConversationGroup(conversation) === bot.id)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const visibleCount = visibleCounts[bot.id] ?? INITIAL_CONVERSATION_COUNT;
        const visibleChats = visibleConversations(chats, visibleCount, activeConversationId);
        const count = approvals.pending.filter(
          (request) =>
            request.botId === bot.id ||
            request.blockedParents?.some((parent) => parent.botId === bot.id),
        ).length;
        return (
          <section className="bot-conversation-group" key={bot.id}>
            <div className="bot-conversation-heading">
              <button
                className="sidebar-row bot-row bot-conversation-parent"
                aria-expanded={open}
                onClick={() => {
                  onToggleGroup(`bot:${bot.id}`);
                }}
              >
                <span className="bot-conversation-toggle">
                  <Avatar person={bot.avatar} size="sm" />
                  {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </span>
                <span>{bot.name}</span>
              </button>
              {!open && <BotConversationStatus conversations={chats} />}
              <div className="bot-conversation-action">
                {!open && count > 0 && (
                  <span className="pending-approval-count" title={`${count} pending approvals`}>
                    {count}
                  </span>
                )}
                {bot.isMain && <MainBotBadge />}
                <IconButton
                  label={`New conversation with ${bot.name}`}
                  disabled={Boolean(creating)}
                  onClick={() => void create(bot.id)}
                >
                  <MessageCirclePlus size={17} />
                </IconButton>
              </div>
            </div>
            {open && count > 0 && (
              <button
                className={`bot-pending-approvals ${location.item === bot.id && location.view === 'pending-approvals' ? 'is-selected' : ''}`}
                aria-current={
                  location.item === bot.id && location.view === 'pending-approvals'
                    ? 'page'
                    : undefined
                }
                onClick={() =>
                  onSelect({ section: 'bots', item: bot.id, view: 'pending-approvals' })
                }
              >
                <Hand size={13} />
                <span>Pending Approvals</span>
                <span className="pending-approval-count">{count}</span>
              </button>
            )}
            {open && (
              <div className="bot-conversation-list">
                {visibleChats.map((chat) => {
                  const sender =
                    chat.kind === 'bot'
                      ? bots.find((participant) => participant.id === chat.botIds[0])
                      : undefined;
                  return (
                    <button
                      key={chat.id}
                      ref={
                        chat.kind === 'private' && activeConversationId === chat.id
                          ? selectedRow
                          : undefined
                      }
                      className={`sidebar-row bot-conversation-row ${chat.kind === 'private' && activeConversationId === chat.id ? 'is-selected' : ''}`}
                      aria-current={
                        chat.kind === 'private' && activeConversationId === chat.id
                          ? 'page'
                          : undefined
                      }
                      title={chat.name}
                      onClick={() =>
                        onSelect(
                          chat.kind === 'bot'
                            ? {
                                section: 'bots',
                                item: 'bot-conversations',
                                conversationId: chat.id,
                              }
                            : { section: 'bots', item: bot.id, conversationId: chat.id },
                        )
                      }
                    >
                      {sender && (
                        <span
                          className="bot-conversation-origin"
                          title={`Started by ${sender.name}`}
                          role="img"
                          aria-label={`Started by ${sender.name}`}
                        >
                          <Avatar person={sender.avatar} size="xs" />
                        </span>
                      )}
                      <span>{chat.name}</span>
                      <ConversationStatus
                        chatId={`${chat.kind === 'bot' ? 'space' : 'private'}:${chat.id}`}
                        updatedAt={chat.updatedAt}
                        isWorking={chat.isWorking}
                      >
                        {age(chat.updatedAt)}
                      </ConversationStatus>
                    </button>
                  );
                })}
                {chats.length > visibleChats.length && (
                  <button
                    className="bot-conversations-load-more"
                    onClick={() =>
                      setVisibleCounts((previous) => ({
                        ...previous,
                        [bot.id]: visibleCount + INITIAL_CONVERSATION_COUNT,
                      }))
                    }
                  >
                    Load {Math.min(INITIAL_CONVERSATION_COUNT, chats.length - visibleChats.length)}{' '}
                    more
                  </button>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
