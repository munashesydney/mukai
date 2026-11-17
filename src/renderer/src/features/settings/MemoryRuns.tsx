import { useWorkspaceTime } from '../timezone/WorkspaceTimeContext';
import { useState } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronRight } from 'lucide-react';
import type { MemoryReviewRun } from '../../../../shared/memory';
import { MessageMarkdown } from '../ai/MessageMarkdown';
import { MemoryTabHeading } from './MemoryTabHeading';
import { MemoryPagination } from './MemoryPagination';
import { MemoryStatus } from './MemoryStatus';
import { reviewStatus } from './memoryWorkStatus';

const pageSize = 10;

export function MemoryRuns({
  runs,
  onRetry,
  disabled = false,
}: {
  runs: MemoryReviewRun[];
  onRetry: (id: string) => void;
  disabled?: boolean;
}) {
  const { dateTime: time } = useWorkspaceTime();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [followRetry, setFollowRetry] = useState(false);
  const [filter, setFilter] = useState('all');
  const [requestedPage, setPage] = useState(1);
  const opened = runs.find((run) => run.id === selectedId);
  const latest = opened && runs.find((run) => run.conversationId === opened.conversationId);
  const selected = followRetry ? latest : opened;
  const selectedStatus = selected && reviewStatus(selected);
  const needsAttention = runs.filter((run) => reviewStatus(run) === 'failed').length;
  const visible = runs.filter((run) => {
    const status = reviewStatus(run);
    if (filter === 'attention') return status === 'failed';
    if (filter === 'active')
      return ['running', 'retrying', 'scheduled', 'retryQueued'].includes(status);
    return true;
  });
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(visible.length / pageSize)));

  const kind = (value: string) =>
    ({ private: 'Chat', space: 'Space', pursuit_run: 'Pursuit run' })[value] ||
    value.replaceAll('_', ' ');
  if (selected && selectedStatus)
    return (
      <section className="memory-run-detail">
        <button
          className="text-button"
          onClick={() => {
            setSelectedId(null);
            setFollowRetry(false);
          }}
        >
          <ArrowLeft size={16} /> All runs
        </button>
        <MemoryTabHeading
          title={selected.conversationName || 'Conversation review'}
          description={`${time(selected.startedAt)} · ${kind(selected.kind)} · ${selected.messageIds.length} messages`}
          actions={<MemoryStatus status={selectedStatus} />}
        />
        {selectedStatus === 'scheduled' && selected.retryAt != null && (
          <p className="memory-run-meta">
            Next attempt {time(new Date(selected.retryAt).toISOString())}
          </p>
        )}
        {selected.error && <p className="memory-run-meta">{selected.error}</p>}
        {latest && latest.id !== selected.id && (
          <button className="text-button" onClick={() => setSelectedId(latest.id)}>
            View latest attempt <ArrowUpRight size={14} />
          </button>
        )}
        {selected.canRetry && selectedStatus !== 'retryQueued' && (
          <button
            className="button button--small"
            disabled={disabled}
            onClick={() => {
              setFollowRetry(true);
              onRetry(selected.id);
            }}
          >
            Retry now
          </button>
        )}
        <div className="memory-run-summary">
          <h4>Decision summary</h4>
          <MessageMarkdown
            text={selected.summary || selected.error || 'Reviewing this exchange…'}
          />
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
    <section className="memory-reviews">
      <MemoryTabHeading
        title="Reviews"
        description="Conversation reviews begin after one minute of inactivity, once replies finish."
        actions={
          <label className="memory-filter-control">
            <span>Show</span>
            <select
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="all">Recent runs</option>
              <option value="active">In progress</option>
              <option value="attention">Needs attention ({needsAttention})</option>
            </select>
          </label>
        }
      />
      <div className="memory-record-list">
        {visible.length ? (
          visible.slice((page - 1) * pageSize, page * pageSize).map((run) => (
            <button
              className="memory-record-row pursuit-run-row"
              key={run.id}
              onClick={() => setSelectedId(run.id)}
            >
              <div>
                <strong>{run.conversationName || 'Conversation review'}</strong>
                <small>
                  {time(run.startedAt)} · {kind(run.kind)}
                </small>
                <p>{run.summary || run.error || 'Reviewing this exchange…'}</p>
              </div>
              <MemoryStatus status={reviewStatus(run)} />
              <ArrowUpRight size={16} />
            </button>
          ))
        ) : (
          <p className="memory-empty">
            {filter === 'attention'
              ? 'No reviews need attention.'
              : filter === 'active'
                ? 'No reviews in progress.'
                : 'Conversation reviews will appear here after a chat has been idle.'}
          </p>
        )}
      </div>
      <MemoryPagination
        page={page}
        size={pageSize}
        total={visible.length}
        label="Reviews"
        onPage={setPage}
      />
    </section>
  );
}
