import { useState } from 'react';
import type { PursuitRun } from '../../../../shared/pursuits';
import { WorkingIndicator } from '../../components/ui/WorkingIndicator';
import { useWorkspaceTime } from '../timezone/WorkspaceTimeContext';

const pageSize = 3;

export function PursuitSidebarRuns({
  runs,
  runCount,
  selectedId,
  onSelect,
}: {
  runs: PursuitRun[];
  runCount: number;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const [count, setCount] = useState(pageSize);
  const { date, dateTime } = useWorkspaceTime();
  if (!runs.length) return null;
  const visible = runs
    .map((run, index) => ({ run, index }))
    .filter(({ run, index }) => index < count || run.id === selectedId || run.status === 'running');
  const remaining = runs.length - visible.length;
  return (
    <div className="bot-conversation-list pursuit-sidebar-runs" aria-label="Pursuit runs">
      {visible.map(({ run, index }) => {
        const selected = run.id === selectedId;
        return (
          <button
            type="button"
            key={run.id}
            className={`sidebar-row bot-conversation-row${selected ? ' is-selected' : ''}`}
            aria-current={selected ? 'page' : undefined}
            title={`${dateTime(run.startedAt)} · ${run.status}`}
            onClick={() => onSelect(run.id)}
          >
            <span>Run {runCount - index}</span>
            {run.status === 'running' ? (
              <WorkingIndicator />
            ) : (
              <time dateTime={run.startedAt}>{date(run.startedAt)}</time>
            )}
          </button>
        );
      })}
      {remaining > 0 && (
        <button
          type="button"
          className="bot-conversations-load-more"
          onClick={() => setCount((previous) => previous + pageSize)}
        >
          Load {Math.min(pageSize, remaining)} more
        </button>
      )}
    </div>
  );
}
