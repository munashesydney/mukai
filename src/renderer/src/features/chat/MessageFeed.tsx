import { useEffect, useRef } from 'react';
import { Bookmark, SmilePlus, Check, FileText } from 'lucide-react';
import { Avatar } from '../../components/ui/Avatar';
import { IconButton } from '../../components/ui/IconButton';
import { agents } from '../workspace/data';
import type { Message, DialogKind } from '../workspace/types';
import { MessageCard } from './MessageCard';

export function MessageFeed({
  messages,
  onDialog,
  onPursuit,
  bookmarks,
  onBookmark,
  reactions,
  onReact,
}: {
  messages: Message[];
  onDialog: (dialog: DialogKind) => void;
  onPursuit: () => void;
  bookmarks: string[];
  onBookmark: (id: string) => void;
  reactions: string[];
  onReact: (id: string) => void;
}) {
  const feed = useRef<HTMLDivElement>(null);
  const previousCount = useRef(messages.length);
  useEffect(() => {
    if (messages.length > previousCount.current)
      feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' });
    previousCount.current = messages.length;
  }, [messages]);
  return (
    <div
      className="message-feed"
      ref={feed}
      role="log"
      aria-label="Conversation"
      aria-live="polite"
    >
      <div className="date-divider">
        <span /> <span>Today, October 1</span>
        <span />
      </div>
      <div className="messages">
        {messages.map((message) => {
          const agent = agents.find((agent) => agent.id === message.author);
          const saved = bookmarks.includes(message.id);
          const reacted = reactions.includes(message.id);
          return (
            <article className="message" key={message.id}>
              <Avatar person={message.author} />
              <div className="message-content">
                <div className="message-meta">
                  <strong>{agent?.name ?? 'Munashe'}</strong>
                  {agent && <span className={`agent-tag agent-tag--${agent.color}`}>AGENT</span>}
                  <time>{message.time}</time>
                  {saved && <Bookmark size={12} className="saved-indicator" />}
                </div>
                <p>{message.text}</p>
                {message.card && (
                  <MessageCard
                    kind={message.card}
                    onOpen={message.card === 'pursuit' ? onPursuit : () => onDialog('draft')}
                  />
                )}
                {message.attachment && (
                  <div className="attachment-card">
                    <FileText size={18} />
                    <span>{message.attachment}</span>
                    <span className="local-badge">Local preview</span>
                  </div>
                )}
                {(message.reaction || reacted) && (
                  <button
                    className={`reaction-pill ${reacted ? 'is-reacted' : ''}`}
                    onClick={() => onReact(message.id)}
                    aria-label="React with rocket"
                    aria-pressed={reacted}
                  >
                    {message.reaction ?? '🚀'}{' '}
                    <span>{message.reaction ? (reacted ? 2 : 1) : 1}</span>
                  </button>
                )}
              </div>
              <div className="message-actions">
                <IconButton
                  label={saved ? 'Unsave message' : 'Save message'}
                  onClick={() => onBookmark(message.id)}
                >
                  {saved ? <Check size={15} /> : <Bookmark size={15} />}
                </IconButton>
                <IconButton label="React to message" onClick={() => onReact(message.id)}>
                  <SmilePlus size={15} />
                </IconButton>
              </div>
            </article>
          );
        })}
      </div>
      {messages.length === 0 && (
        <div className="empty-conversation">
          <span>✳</span>
          <h3>A fresh start.</h3>
          <p>Share an idea, ask a question, or just say hello.</p>
        </div>
      )}
      <div className="conversation-end">
        <span />
        <small>You’re all caught up</small>
        <span />
      </div>
    </div>
  );
}
