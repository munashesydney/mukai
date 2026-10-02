import { useEffect, useState } from 'react';
import { ArrowLeft, Square } from 'lucide-react';
import type { Bot, ChatMessage } from '../../../../shared/ai';
import type { FileChangeSummary } from '../../../../shared/fileChanges';
import type { PursuitRun } from '../../../../shared/pursuits';
import { chatService } from '../../services/chatService';
import { conversationService } from '../../services/conversationService';
import { Avatar } from '../../components/ui/Avatar';
import { ResponseActivity } from '../ai/ResponseActivity';
import { MessageMarkdown } from '../ai/MessageMarkdown';
import { FileChanges } from '../ai/FileChanges';
import { DiffDrawer } from '../ai/DiffDrawer';
import { ArtifactsView } from '../ai/ArtifactsView';
import { MessageActions } from '../chat/MessageActions';
import { errorText } from '../../utils/errors';
import { BrowserToggle } from '../browser/BrowserToggle';
export function PursuitRunView({
  run,
  bot,
  onBack,
}: {
  run: PursuitRun;
  bot?: Bot;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]),
    [error, setError] = useState(''),
    [tab, setTab] = useState('Messages');
  const [review, setReview] = useState<{ changes: FileChangeSummary[]; selectedId: string } | null>(
    null,
  );
  useEffect(() => {
    let alive = true,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const values = await chatService.history('space:' + run.conversationId);
        if (alive) {
          setMessages(values);
          setError('');
        }
      } catch (caught) {
        if (alive) setError(errorText(caught));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = run.status === 'running' ? window.setInterval(() => void load(), 1500) : null;
    return () => {
      alive = false;
      if (timer) window.clearInterval(timer);
    };
  }, [run.conversationId, run.status]);
  async function save(message: ChatMessage) {
    try {
      const saved = await conversationService.save(run.conversationId, message.id, !message.saved);
      setMessages((prev) => prev.map((item) => (item.id === saved.id ? saved : item)));
    } catch (caught) {
      setError(errorText(caught));
    }
  }
  return (
    <>
      <header className="pursuit-header">
        <button className="text-button" onClick={onBack}>
          <ArrowLeft size={16} /> All runs
        </button>
        <div className="pursuit-title">
          <h1>{run.snapshot.name}</h1>
          <span className="status-label">{run.status === 'running' ? 'Running' : run.status}</span>
          <BrowserToggle />
        </div>
        <p>
          {run.trigger === 'schedule' ? 'Scheduled wake' : 'Requested run'} ·{' '}
          {new Date(run.startedAt).toLocaleString()}
        </p>
        {run.status === 'running' && (
          <button
            className="button button--small"
            onClick={() =>
              void chatService
                .stop('space:' + run.conversationId)
                .catch((caught) => setError(errorText(caught)))
            }
          >
            <Square size={13} /> Stop run
          </button>
        )}
        <div className="conversation-tabs" role="tablist" aria-label="Run views">
          {['Messages', 'Artifacts'].map((name) => (
            <button
              key={name}
              role="tab"
              aria-selected={tab === name}
              className={tab === name ? 'is-active' : ''}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </header>
      {error && (
        <p role="alert" className="ai-alert">
          {error}
        </p>
      )}
      {tab === 'Artifacts' ? (
        <ArtifactsView
          conversationId={run.conversationId}
          attachments={messages.flatMap((m) => m.attachments)}
        />
      ) : (
        <div className="ai-message-feed" role="log" aria-label="Pursuit run messages">
          <details className="pursuit-run-context">
            <summary>Run context</summary>
            <dl>
              <dt>Objective</dt>
              <dd>{run.snapshot.objective}</dd>
              <dt>Success criteria</dt>
              <dd>{run.snapshot.successCriteria}</dd>
            </dl>
            {messages
              .filter((m) => m.role === 'user')
              .map((m) => (
                <pre key={m.id}>{m.content}</pre>
              ))}
          </details>
          {messages
            .filter((m) => m.role === 'assistant')
            .map((message) => (
              <article className="ai-message" key={message.id}>
                <Avatar person={bot?.avatar || 'scout'} size="sm" />
                <div className="ai-message-body">
                  <div className="ai-message-meta">
                    <strong>{message.authorName || bot?.name || 'Owner'}</strong>
                    <span className="bot-badge">BOT</span>
                  </div>
                  <ResponseActivity message={message} />
                  <FileChanges
                    message={message}
                    onReview={(changes, selectedId) => setReview({ changes, selectedId })}
                  />
                  {message.error && <p className="ai-response-status">{message.error}</p>}
                  <MessageActions
                    text={message.content}
                    saved={Boolean(message.saved)}
                    onSave={() => void save(message)}
                  />
                </div>
              </article>
            ))}
          {!messages.some((m) => m.role === 'assistant') && (
            <p className="ai-caption">
              {run.status === 'running'
                ? 'Starting this run…'
                : run.error || 'No response was generated.'}
            </p>
          )}
          {run.error && (
            <p role="status" className="ai-alert">
              {run.error}
            </p>
          )}
          {run.status !== 'running' && run.summary && (
            <div className="pursuit-run-summary">
              <span className="context-section-label">RUN OUTCOME</span>
              <MessageMarkdown text={run.summary} />
            </div>
          )}
        </div>
      )}
      {review && (
        <DiffDrawer
          {...review}
          onSelect={(selectedId) => setReview({ ...review, selectedId })}
          onClose={() => setReview(null)}
        />
      )}
    </>
  );
}
