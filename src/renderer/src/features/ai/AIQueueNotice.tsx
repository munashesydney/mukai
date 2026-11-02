import { useContext, useEffect, useState } from 'react';
import { Clock3, ArrowUpRight } from 'lucide-react';
import { AIQueueSettings } from './aiQueueContext';
import { useAIActivity } from '../../services/aiActivityStore';
export function AIQueueNotice({ conversationId }: { conversationId: string }) {
  const state = useAIActivity();
  const openSettings = useContext(AIQueueSettings);
  const index = state.queued.findIndex((item) => item.conversationId === conversationId);
  const pursuitIndex = (state.pursuitQueued || []).findIndex(
    (item) => item.conversationId === conversationId,
  );
  const activeRetry = state.running.find(
    (item) => item.conversationId === conversationId && item.memoryRetry,
  );
  const work = index >= 0 ? state.queued[index] : activeRetry;
  const pressure = work?.memoryPressure;
  const retry = work?.memoryRetry;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!pressure?.cooldownUntil || index < 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pressure?.cooldownUntil, index]);
  const seconds = pressure?.cooldownUntil
    ? Math.max(0, Math.ceil((Date.parse(pressure.cooldownUntil) - now) / 1000))
    : 0;
  if (index < 0 && pursuitIndex < 0 && !activeRetry) return null;
  const running = index >= 0 || activeRetry ? state.running : state.pursuitRunning || [];
  const limit = index >= 0 || activeRetry ? state.limit : state.pursuitLimit;
  const workspaces = new Map<string, { name: string; count: number; kinds: Set<string> }>();
  for (const item of running) {
    const key = item.workspaceId || item.workspaceName;
    const group = workspaces.get(key) || {
      name: item.workspaceName,
      count: 0,
      kinds: new Set<string>(),
    };
    group.count++;
    group.kinds.add(item.kind);
    workspaces.set(key, group);
  }
  return (
    <aside className="ai-queue-notice" role="status" aria-live="polite">
      <Clock3 size={15} aria-hidden="true" />
      <div className="ai-queue-body">
        <div className="ai-queue-heading">
          <strong>
            {activeRetry
              ? retry?.phase === 'compaction'
                ? 'Trying a smaller context'
                : 'Retrying after memory rejection'
              : pressure
                ? 'Waiting for memory recovery'
                : index >= 0
                  ? 'Queued'
                  : 'Pursuit queued'}
          </strong>
          <span>
            {pressure || retry ? (
              <>
                {seconds > 0
                  ? `Retry in ${seconds}s`
                  : index >= 0
                    ? 'Waiting for a slot'
                    : retry?.phase === 'compaction'
                      ? 'Saved progress preserved'
                      : 'Recovery in progress'}
                {retry && retry.phase !== 'compaction'
                  ? ` · Retry ${retry.attempt}/${retry.maxAttempts}`
                  : ''}
              </>
            ) : (
              <>
                #{(index >= 0 ? index : pursuitIndex) + 1} · {running.length}/{limit} slots busy
              </>
            )}
          </span>
          <a
            href="#settings-limits"
            aria-label="Change limits in Settings"
            onClick={(event) => {
              event.preventDefault();
              openSettings();
            }}
          >
            Limits <ArrowUpRight size={12} aria-hidden="true" />
          </a>
        </div>
        {pressure && (
          <p>
            {pressure.providerName} temporarily allows {pressure.effectiveLimit}{' '}
            {pressure.effectiveLimit === 1 ? 'AI' : 'AIs'}; your saved maximum is{' '}
            {pressure.configuredLimit}. Capacity restores after successful requests.
          </p>
        )}
        <p>
          {workspaces.size > 0 && (
            <>
              Running:{' '}
              <span className="ai-queue-workspaces" aria-label="Workspaces with running AIs">
                {[...workspaces].map(([id, workspace], index) => (
                  <span key={id} title={[...workspace.kinds].join(', ')}>
                    {index > 0 ? ', ' : ''}
                    {workspace.name}
                    {workspace.count > 1 ? ` (${workspace.count})` : ''}
                  </span>
                ))}
              </span>
              .{' '}
            </>
          )}
          {activeRetry ? 'Continuing from saved results.' : 'Resumes automatically.'}
        </p>
      </div>
    </aside>
  );
}
