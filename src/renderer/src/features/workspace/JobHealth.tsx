import type { CapabilityRegistration } from '../../../../shared/customCapabilities';

export function JobHealth({
  health,
  compact = false,
}: {
  health: CapabilityRegistration['health'];
  compact?: boolean;
}) {
  if (!health) return null;
  const failed = health.consecutiveFailures > 0;
  return (
    <div className={`job-health ${failed ? 'has-failures' : ''}`}>
      <p>
        {health.lastRun
          ? `Last run: ${health.lastRun.status} · ${new Date(health.lastRun.startedAt).toLocaleString()}`
          : 'Execution: not run yet.'}
      </p>
      {failed && (
        <p>
          {health.consecutiveFailures} consecutive{' '}
          {health.consecutiveFailures === 1 ? 'failure' : 'failures'}
        </p>
      )}
      {health.lastError && (
        <p className="job-health-error">
          {compact && health.lastError.length > 240
            ? health.lastError.slice(0, 240) + '…'
            : health.lastError}
        </p>
      )}
    </div>
  );
}
