import { useContext } from 'react';
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
  if (index < 0 && pursuitIndex < 0) return null;
  const running = index >= 0 ? state.running : state.pursuitRunning || [];
  const limit = index >= 0 ? state.limit : state.pursuitLimit;
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
      <Clock3 size={18} aria-hidden="true" />
      <div className="ai-queue-body">
        <strong>
          {index >= 0 ? 'Queued for AI' : 'Queued for a pursuit slot'}{' '}
          <span>· Position {(index >= 0 ? index : pursuitIndex) + 1}</span>
        </strong>
        <p>
          {running.length} of {limit} {index >= 0 ? 'AI' : 'pursuit'} slots in use across all
          workspaces. Your chat continues automatically when a slot is free.
        </p>
        {workspaces.size > 0 && (
          <div className="ai-queue-workspaces" aria-label="Workspaces with running AIs">
            {[...workspaces].map(([id, workspace]) => (
              <span key={id} title={[...workspace.kinds].join(', ')}>
                {workspace.name} <b>{workspace.count}</b>
              </span>
            ))}
          </div>
        )}
        <a
          href="#settings-limits"
          onClick={(event) => {
            event.preventDefault();
            openSettings();
          }}
        >
          Change limits in Settings <ArrowUpRight size={13} aria-hidden="true" />
        </a>
      </div>
    </aside>
  );
}
