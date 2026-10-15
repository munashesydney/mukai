import { useState } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronRight } from 'lucide-react';
import type { MemoryReviewRun } from '../../../../shared/memory';
import { MessageMarkdown } from '../ai/MessageMarkdown';

export function MemoryRuns({
  runs,
  onRetry,
  disabled = false,
}: {
  runs: MemoryReviewRun[];
  onRetry: (id: string) => void;
  disabled?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = runs.find((run) => run.id === selectedId);
  const time = (value: string) => new Date(value).toLocaleString();
  const kind = (value: string) =>
    ({ private: 'Chat', space: 'Space', pursuit_run: 'Pursuit run' })[value] ||
    value.replaceAll('_', ' ');
  if (selected)
    return (
      <section className="memory-run-detail">
        <button className="text-button" onClick={() => setSelectedId(null)}>
          <ArrowLeft size={16} /> All runs
        </button>
        <div className="pursuit-section-heading">
          <h2>{selected.conversationName || 'Conversation review'}</h2>
          <span className="status-label">{selected.status}</span>
        </div>
        <p className="memory-run-meta">
          {time(selected.startedAt)} · {selected.ownerId ? 'Private' : 'Workspace'} ·{' '}
          {kind(selected.kind)} · {selected.messageIds.length}{' '}
          {selected.messageIds.length === 1 ? 'message' : 'messages'}
        </p>
        {selected.error && (
          <div className="ai-alert" role="alert">
            {selected.error}
          </div>
        )}
        {selected.status === 'failed' && (
          <button
            className="button button--small"
            disabled={disabled}
            onClick={() => onRetry(selected.id)}
          >
            Retry review
          </button>
        )}
        <div className="memory-run-summary">
          <h4>Decision summary</h4>
          <MessageMarkdown text={selected.summary || 'Reviewing this exchange…'} />
          <small>
            A concise explanation of the review decision. Operations below are performed by the
            internal memory worker.
          </small>
        </div>
        <div className="memory-run-operations">
          <h4>Operations</h4>
          {selected.activity.map((activity) => (
            <details
              className={`response-tool response-tool--${activity.status}`}
              key={activity.id}
            >
              <summary>
                <ChevronRight size={14} className="memory-operation-chevron" />
                <span>
                  {activity.tool === 'memory' ? `memory · ${activity.action}` : 'Review exchange'}
                </span>
                <span className="memory-run-meta">
                  {activity.status} · {activity.path}
                </span>
              </summary>
              <pre>{activity.summary}</pre>
            </details>
          ))}
        </div>
      </section>
    );
  return (
    <section className="pursuit-runs">
      <div className="pursuit-section-heading">
        <h2>Memory runs</h2>
        <span>{runs.length} recent</span>
      </div>
      <p className="memory-run-meta">
        Conversations are reviewed after one minute of inactivity, once bot responses finish.
      </p>
      {runs.length ? (
        runs.map((run) => (
          <button className="pursuit-run-row" key={run.id} onClick={() => setSelectedId(run.id)}>
            <span className={`pursuit-run-dot ${run.status === 'running' ? 'is-running' : ''}`} />
            <div>
              <strong>{run.conversationName || 'Conversation review'}</strong>
              <small>
                {time(run.startedAt)} · {run.ownerId ? 'Private' : 'Workspace'} · {kind(run.kind)}
              </small>
              <p>{run.summary || run.error || 'Reviewing this exchange…'}</p>
            </div>
            <span className="pursuit-run-status">{run.status}</span>
            <ArrowUpRight size={16} />
          </button>
        ))
      ) : (
        <p className="ai-caption">No runs yet.</p>
      )}
    </section>
  );
}
