import { formatTimestamp } from '../../../../shared/timeZone';
import { useWorkspaceTime } from '../timezone/WorkspaceTimeContext';
import { useState } from 'react';
import { TriangleAlert, X, ArrowUpRight } from 'lucide-react';
import type { ChatFailure } from '../../../../shared/failures';
import type { useFailures } from './useFailures';
import { failureService } from '../../services/failureService';
import { errorText } from '../../utils/errors';

export function FailedPage({
  inbox,
  onOpen,
}: {
  inbox: ReturnType<typeof useFailures>;
  onOpen: (failure: ChatFailure) => void;
}) {
  const { zoneFor } = useWorkspaceTime();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  async function clear(id?: string) {
    if (pending) return;
    setPending(id || 'all');
    setError('');
    try {
      if (id) await failureService.dismiss(id);
      else await failureService.dismissAll();
      inbox.refresh();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setPending(null);
    }
  }
  return (
    <main className="conversation notifications-page failed-page">
      <header className="notifications-heading">
        <div>
          <span className="settings-eyebrow">ALL WORKSPACES</span>
          <div className="notifications-title">
            <h1>
              Failed<span>{inbox.total}</span>
            </h1>
          </div>
          <p>Chats that stopped unexpectedly. Open a chat to review saved progress and retry.</p>
          <p className="ai-caption">Clearing a notice keeps its chat and saved work.</p>
        </div>
        {inbox.total > 0 && (
          <button
            className="button button--ghost notifications-dismiss-all"
            disabled={Boolean(pending) || inbox.loading}
            onClick={() => void clear()}
          >
            <X size={15} />
            {pending === 'all' ? 'Clearing…' : 'Clear all'}
          </button>
        )}
      </header>
      <div className={`notifications-content ${inbox.items.length ? '' : 'is-empty'}`}>
        {(error || inbox.error) && (
          <p className="ai-alert" role="alert">
            {error || inbox.error}{' '}
            <button className="text-button" onClick={inbox.refresh}>
              Try again
            </button>
          </p>
        )}
        {!inbox.items.length && (
          <div className="notifications-empty">
            <TriangleAlert size={28} />
            <h2>{inbox.loading ? 'Loading failures…' : 'No failed chats'}</h2>
            <p>Unexpectedly stopped chats from all workspaces appear here.</p>
          </div>
        )}
        <div className="notification-list">
          {inbox.items.map((item) => (
            <article className="notification-card failure-notice" key={item.id}>
              <button
                className="notification-card-summary"
                onClick={() => onOpen(item)}
                aria-label={`Open ${item.conversation.kind === 'pursuit_run' ? 'run' : 'chat'}: ${item.conversation.name} in ${item.workspaceName}`}
              >
                <span className="notification-card-icon">
                  <TriangleAlert size={16} />
                </span>
                <span className="notification-meta">
                  <strong>{item.workspaceName}</strong>
                  <span className="notification-type">
                    {item.botName} · {item.runId ? 'Pursuit run' : 'Chat'}
                  </span>
                  <time dateTime={item.failedAt}>
                    {formatTimestamp(item.failedAt, zoneFor(item.workspaceId), {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                      timeZoneName: 'short',
                    })}
                  </time>
                </span>
                <span className="notification-card-title">{item.conversation.name}</span>
                <span className="notification-card-preview">{item.error}</span>
                <ArrowUpRight size={16} className="notification-card-arrow" />
              </button>
              <button
                className="notification-action failure-clear"
                disabled={Boolean(pending)}
                aria-label={`Clear failure: ${item.conversation.name}`}
                onClick={() => void clear(item.id)}
              >
                <X size={15} />
                Clear
              </button>
            </article>
          ))}
        </div>
        {inbox.items.length < inbox.total && (
          <button className="button" onClick={inbox.loadMore}>
            Load more failures
          </button>
        )}
      </div>
    </main>
  );
}
