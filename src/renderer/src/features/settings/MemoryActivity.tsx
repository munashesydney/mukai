import { useState } from 'react';
import type { MemoryReviewRun, MemorySnapshot } from '../../../../shared/memory';
import { useWorkspaceTime } from '../timezone/WorkspaceTimeContext';
import { MemoryTabHeading } from './MemoryTabHeading';
import { MemoryPagination } from './MemoryPagination';
import { MemoryStatus } from './MemoryStatus';
import { captureStatus, reviewStatus } from './memoryWorkStatus';
import { memorySourceLabel, reviewMessages } from './memoryEvidence';

const pageSize = 10;

export function MemoryActivity({
  snapshot,
  busy,
  onRetry,
  onForget,
}: {
  snapshot: MemorySnapshot;
  busy: boolean;
  onRetry: (id: string) => void;
  onForget: (id: string) => void;
}) {
  const { dateTime: time } = useWorkspaceTime();
  const [filter, setFilter] = useState('all');
  const [requestedPage, setPage] = useState(1);
  const latestRun = new Map<string, MemoryReviewRun>();
  for (const run of snapshot.runs)
    if (!latestRun.has(run.episodeId)) latestRun.set(run.episodeId, run);
  const episodes = snapshot.episodes.map((episode) => {
    const run = latestRun.get(episode.id);
    const status =
      run && episode.status !== 'complete' ? reviewStatus(run) : captureStatus(episode);
    return { episode, run, status };
  });
  const needsAttention = episodes.filter(({ status }) => status === 'failed').length;
  const visible = episodes.filter(({ status }) => {
    if (filter === 'attention') return status === 'failed';
    if (filter === 'active')
      return ['queued', 'scheduled', 'retryQueued', 'running', 'retrying'].includes(status);
    return true;
  });
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(visible.length / pageSize)));

  return (
    <div className="memory-activity">
      <section>
        <MemoryTabHeading
          title="Captures"
          description="Statements saved by conversations, bot tools, and imports."
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
                <option value="all">All captures</option>
                <option value="active">In progress</option>
                <option value="attention">Needs attention ({needsAttention})</option>
              </select>
            </label>
          }
        />
        <div className="memory-processing">
          {visible.slice((page - 1) * pageSize, page * pageSize).map(({ episode, run, status }) => {
            const retryAt = run ? run.retryAt : episode.retryAt;
            const canRetry =
              episode.status === 'failed' && (run?.canRetry ?? true) && status !== 'retryQueued';
            const messages = reviewMessages(episode);
            const preview =
              messages.find((message) => message.role === 'user' && message.content)?.content ??
              messages.find((message) => message.content)?.content ??
              episode.content;
            return (
              <div className="memory-record-row memory-capture-row" key={episode.id}>
                <div>
                  <div className="memory-row-heading">
                    <strong>{memorySourceLabel[episode.sourceType]}</strong>
                  </div>
                  <small>
                    {time(episode.createdAt)}
                    {episode.attempts > 0 &&
                      ` · ${episode.attempts} ${episode.attempts === 1 ? 'attempt' : 'attempts'}`}
                    {status === 'scheduled' &&
                      retryAt != null &&
                      ` · Next attempt ${time(new Date(retryAt).toISOString())}`}
                  </small>
                  {episode.error && <p>{episode.error}</p>}
                  {!episode.error && preview && <p className="memory-capture-preview">{preview}</p>}
                </div>
                <div className="memory-row-actions">
                  <MemoryStatus status={status} />
                  {canRetry && (
                    <button
                      className="button button--secondary"
                      disabled={
                        busy ||
                        !snapshot.settings.enabled ||
                        (run && !snapshot.settings.automaticCapture)
                      }
                      onClick={() => onRetry(episode.id)}
                    >
                      Retry now
                    </button>
                  )}
                  <button
                    className="button button--ghost"
                    disabled={busy}
                    onClick={() => onForget(episode.id)}
                  >
                    Forget
                  </button>
                </div>
              </div>
            );
          })}
          {!visible.length && (
            <p className="memory-empty">
              {filter === 'attention'
                ? 'No captures need attention.'
                : filter === 'active'
                  ? 'No captures in progress.'
                  : 'Captures will appear here after memory reviews or bot saves.'}
            </p>
          )}
        </div>
        <MemoryPagination
          page={page}
          size={pageSize}
          total={visible.length}
          label="Captures"
          onPage={setPage}
        />
      </section>
    </div>
  );
}
