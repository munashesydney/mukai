import { useState } from 'react';
import {
  MessageCircle,
  MessageSquarePlus,
  Check,
  X,
  ArrowUpRight,
  ChevronRight,
} from 'lucide-react';
import type { Conversation } from '../../../../shared/conversations';
import type { useNotifications } from './useNotifications';
import { notificationService } from '../../services/notificationService';
import { MessageMarkdown } from '../ai/MessageMarkdown';
import { errorText } from '../../utils/errors';

function notificationPreview(message: string) {
  return message
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function NotificationsPage({
  workspaceId,
  inbox,
  onOpen,
}: {
  workspaceId: string;
  inbox: ReturnType<typeof useNotifications>;
  onOpen: (conversation: Conversation) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  async function act(id: string, action: 'read' | 'dismiss' | 'continue') {
    if (pending) return;
    setPending(id);
    setError('');
    try {
      if (action === 'continue') onOpen(await notificationService.continue(workspaceId, id));
      else await notificationService.mark(workspaceId, id, action);
      inbox.refresh();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(null);
    }
  }
  return (
    <main className="conversation notifications-page">
      <header className="notifications-heading">
        <div>
          <span className="settings-eyebrow">BOT UPDATES</span>
          <h1>
            Updates<span>{inbox.unread || inbox.total}</span>
          </h1>
          <p>Findings and news from your bots’ autonomous work.</p>
        </div>
      </header>
      <div className="notifications-content">
        {(error || inbox.error) && (
          <p className="ai-alert" role="alert">
            {error || inbox.error}{' '}
            <button className="text-button" onClick={inbox.refresh}>
              Retry
            </button>
          </p>
        )}
        {!inbox.items.length && (
          <div className="notifications-empty">
            <MessageCircle size={28} />
            <h2>{inbox.loading ? 'Loading updates…' : 'You’re all caught up'}</h2>
            <p>Meaningful bot updates will appear here.</p>
          </div>
        )}
        <div className="notification-list">
          {inbox.items.map((item) => (
            <article
              key={item.id}
              className={`notification-card ${item.readAt ? '' : 'is-unread'} ${expandedId === item.id ? 'is-expanded' : ''}`}
            >
              <button
                className="notification-card-summary"
                aria-expanded={expandedId === item.id}
                onClick={() => setExpandedId((current) => (current === item.id ? null : item.id))}
              >
                <span className="notification-card-icon">
                  <MessageCircle size={16} />
                </span>
                <div className="notification-meta">
                  <strong>{item.botName}</strong>
                  <span className="notification-type">
                    {item.sourceKind === 'pursuit_run' ? 'Pursuit update' : 'Bot update'}
                  </span>
                  <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
                </div>
                <span className="notification-card-title">{item.title}</span>
                <span className="notification-card-preview">
                  {notificationPreview(item.message)}
                </span>
                <ChevronRight size={16} className="notification-card-arrow" />
              </button>
              {expandedId === item.id && (
                <div className="notification-card-details">
                  <div className="notification-message">
                    <MessageMarkdown text={item.message} />
                  </div>
                  <footer>
                    <button
                      className="notification-chat"
                      disabled={Boolean(pending)}
                      onClick={() => void act(item.id, 'continue')}
                    >
                      <MessageSquarePlus size={15} />
                      {item.conversationId ? 'Open conversation' : 'Continue in chat'}
                      <ArrowUpRight size={14} />
                    </button>
                    <div>
                      {!item.readAt && (
                        <button
                          className="notification-action"
                          disabled={Boolean(pending)}
                          onClick={() => void act(item.id, 'read')}
                        >
                          <Check size={15} />
                          Mark read
                        </button>
                      )}
                      <button
                        className="notification-action"
                        disabled={Boolean(pending)}
                        onClick={() => void act(item.id, 'dismiss')}
                      >
                        <X size={15} />
                        Dismiss
                      </button>
                    </div>
                  </footer>
                </div>
              )}
            </article>
          ))}
        </div>
        {inbox.items.length < inbox.total && (
          <button className="button" onClick={inbox.loadMore}>
            Load more updates
          </button>
        )}
      </div>
    </main>
  );
}
