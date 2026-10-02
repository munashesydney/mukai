import { useEffect, useState } from 'react';
import { Check, Clock3, LoaderCircle } from 'lucide-react';
import { pursuitStatusLabels, scheduledStatus, type Pursuit } from '../../../../shared/pursuits';
export function WakeCountdown({ pursuit }: { pursuit: Pursuit }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const scheduled = scheduledStatus(pursuit.status);
  const remaining =
    scheduled && pursuit.nextRunAt
      ? Math.max(0, Math.ceil((Date.parse(pursuit.nextRunAt) - now) / 1000))
      : null;
  const progress =
    remaining === null ? 0 : 1 - Math.min(1, remaining / (pursuit.intervalMinutes * 60));
  return (
    <div className={`pursuit-wake ${pursuit.currentRunId ? 'is-running' : ''}`}>
      <div
        className="pursuit-wake-dial"
        style={{
          background: `conic-gradient(var(--theme-accent) ${progress * 360}deg, var(--line) 0deg)`,
        }}
        aria-hidden="true"
      >
        <span>
          {pursuit.currentRunId ? (
            <LoaderCircle className="is-spinning" size={24} />
          ) : pursuit.status === 'completed' ? (
            <Check size={24} />
          ) : (
            <Clock3 size={24} />
          )}
        </span>
      </div>
      <div>
        <span className="context-section-label">
          {pursuit.currentRunId ? 'RUN IN PROGRESS' : scheduled ? 'NEXT WAKE' : 'PURSUIT STATUS'}
        </span>
        <div
          className="pursuit-countdown"
          aria-label={
            pursuit.currentRunId
              ? 'Running now'
              : remaining === null
                ? pursuitStatusLabels[pursuit.status]
                : `Next wake in ${remaining} seconds`
          }
        >
          {pursuit.currentRunId ? (
            'Working on it'
          ) : remaining === null ? (
            scheduled ? (
              'No wake scheduled'
            ) : (
              pursuitStatusLabels[pursuit.status]
            )
          ) : remaining === 0 ? (
            'Waking shortly'
          ) : (
            <>
              {String(Math.floor(remaining / 3600)).padStart(2, '0')}
              <span>:</span>
              {String(Math.floor((remaining % 3600) / 60)).padStart(2, '0')}
              <span>:</span>
              {String(remaining % 60).padStart(2, '0')}
            </>
          )}
        </div>
        <p>
          {scheduled && pursuit.nextRunAt && !pursuit.currentRunId
            ? new Date(pursuit.nextRunAt).toLocaleString()
            : pursuit.currentRunId
              ? 'The owner is working toward the objective.'
              : pursuit.status === 'completed'
                ? 'No further runs scheduled.'
                : pursuit.status === 'paused'
                  ? 'Scheduled wakes are paused.'
                  : pursuit.status === 'blocked'
                    ? 'Resolve the obstacle before resuming.'
                    : pursuit.status === 'waiting_for_you'
                      ? 'Your input is needed before work can continue.'
                      : 'Waiting for the next scheduled wake.'}
        </p>
      </div>
    </div>
  );
}
