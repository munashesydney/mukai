import { ArrowUpRight } from 'lucide-react';
import type { PursuitRun } from '../../../../shared/pursuits';

export function PursuitRuns({
  runs,
  onSelect,
}: {
  runs: PursuitRun[];
  onSelect: (id: string) => void;
}) {
  return (
    <section className="pursuit-runs">
      <div className="pursuit-section-heading">
        <h2>Runs</h2>
        <span>{runs.length} recent</span>
      </div>
      {runs.length ? (
        runs.map((item, index) => (
          <button className="pursuit-run-row" key={item.id} onClick={() => onSelect(item.id)}>
            <span className={`pursuit-run-dot ${item.status === 'running' ? 'is-running' : ''}`} />
            <div>
              <strong>
                {item.status === 'running' ? 'Working now' : `Run ${runs.length - index}`}
              </strong>
              <small>
                {new Date(item.startedAt).toLocaleString()} ·{' '}
                {item.trigger === 'schedule' ? 'Scheduled' : 'Requested'}
              </small>
              <p>
                {item.summary ||
                  item.error ||
                  (item.status === 'running'
                    ? 'The owner is working toward the objective.'
                    : 'No outcome was recorded.')}
              </p>
            </div>
            <span className="pursuit-run-status">{item.status}</span>
            <ArrowUpRight size={16} />
          </button>
        ))
      ) : (
        <div className="pursuit-empty-runs">
          <p>No runs yet.</p>
          <small>Scheduled runs will appear here when the owner wakes.</small>
        </div>
      )}
    </section>
  );
}
