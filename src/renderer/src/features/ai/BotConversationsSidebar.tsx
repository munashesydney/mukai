import { useState } from 'react';
import { ChevronDown, ChevronRight, MessageCirclePlus, Hand } from 'lucide-react';
import { useApprovals } from './approvalStore';
import type { Bot } from '../../../../shared/ai';
import type { Conversation } from '../../../../shared/conversations';
import type { Location } from '../workspace/types';
import { Avatar } from '../../components/ui/Avatar';
import { IconButton } from '../../components/ui/IconButton';
import { errorText } from '../../utils/errors';

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
}: {
  bots: Bot[];
  conversations: Conversation[];
  location: Location;
  onSelect: (location: Location) => void;
  onCreate: (botId: string) => Promise<void>;
}) {
  const approvals = useApprovals();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const [creating, setCreating] = useState<string | null>(null),
    [error, setError] = useState('');
  async function create(botId: string) {
    if (creating) return;
    setCreating(botId);
    setError('');
    try {
      await onCreate(botId);
      setExpanded((previous) => ({ ...previous, [botId]: true }));
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
      {[...bots]
        .sort((a, b) => Number(b.isMain) - Number(a.isMain))
        .map((bot) => {
          const open = expanded[bot.id] ?? location.item === bot.id;
          const chats = conversations.filter((conversation) => conversation.ownerBotId === bot.id);
          const visibleCount = visibleCounts[bot.id] ?? INITIAL_CONVERSATION_COUNT;
          const visibleChats = chats.slice(0, visibleCount);
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
                    setExpanded((previous) => ({ ...previous, [bot.id]: !open }));
                  }}
                >
                  <span className="bot-conversation-toggle">
                    <Avatar person={bot.avatar} size="xs" />
                    {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </span>
                  <span>{bot.name}</span>
                </button>
                <IconButton
                  label={`New conversation with ${bot.name}`}
                  disabled={Boolean(creating)}
                  onClick={() => void create(bot.id)}
                >
                  <MessageCirclePlus size={17} />
                </IconButton>
              </div>
              {count > 0 && (
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
                  {visibleChats.map((chat) => (
                    <button
                      key={chat.id}
                      className={`sidebar-row bot-conversation-row ${location.item === bot.id && !location.view && location.conversationId === chat.id ? 'is-selected' : ''}`}
                      aria-current={
                        location.item === bot.id &&
                        !location.view &&
                        location.conversationId === chat.id
                          ? 'page'
                          : undefined
                      }
                      title={chat.name}
                      onClick={() =>
                        onSelect({ section: 'bots', item: bot.id, conversationId: chat.id })
                      }
                    >
                      <span>{chat.name}</span>
                      <time
                        dateTime={chat.updatedAt}
                        title={new Date(chat.updatedAt).toLocaleString()}
                      >
                        {age(chat.updatedAt)}
                      </time>
                    </button>
                  ))}
                  {chats.length > visibleCount && (
                    <button
                      className="bot-conversations-load-more"
                      onClick={() =>
                        setVisibleCounts((previous) => ({
                          ...previous,
                          [bot.id]: visibleCount + INITIAL_CONVERSATION_COUNT,
                        }))
                      }
                    >
                      Load {Math.min(INITIAL_CONVERSATION_COUNT, chats.length - visibleCount)} more
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
