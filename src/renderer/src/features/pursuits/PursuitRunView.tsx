import { useState } from 'react';
import { Square } from 'lucide-react';
import type { Bot, ProviderSettings } from '../../../../shared/ai';
import type { NotificationSource } from '../../../../shared/notifications';
import type { PursuitRun } from '../../../../shared/pursuits';
import { chatService } from '../../services/chatService';
import { useAIActivity } from '../../services/aiActivityStore';
import { pursuitService } from '../../services/pursuitService';
import { errorText } from '../../utils/errors';
import { BotChat } from '../ai/BotChat';
import { MessageMarkdown } from '../ai/MessageMarkdown';
import { RetryResponseButton } from '../ai/RetryResponseButton';
import { useWorkspaceTime } from '../timezone/WorkspaceTimeContext';

export function PursuitRunView({
  run,
  bot,
  bots,
  providers,
  onBack,
  onRetried,
  onProviders,
  onBotChanged,
  onOpenBot,
  onOpenSource,
  onViewComputer,
}: {
  run: PursuitRun;
  bot?: Bot;
  bots: Bot[];
  providers: ProviderSettings[];
  onBack: () => void;
  onRetried: (run: PursuitRun) => void;
  onProviders: () => void;
  onBotChanged: (bot: Bot) => void;
  onOpenBot: (id: string) => Promise<void>;
  onOpenSource: (source: NotificationSource) => Promise<void>;
  onViewComputer: () => void;
}) {
  const { dateTime } = useWorkspaceTime();
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const activity = useAIActivity();
  const active = run.status === 'running';
  const queued = [...activity.queued, ...(activity.pursuitQueued || [])].some(
    (work) => work.conversationId === run.conversationId,
  );
  const status = active ? (queued ? 'Queued' : 'Running') : run.status;
  async function retry() {
    if (retrying) return;
    setRetrying(true);
    setError('');
    try {
      onRetried(await pursuitService.retry(run.pursuitId, run.id));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setRetrying(false);
    }
  }

  return (
    <BotChat
      bot={bot}
      bots={bots}
      providers={providers}
      conversation={{
        id: run.conversationId,
        kind: 'pursuit_run',
        workspaceId: run.snapshot.workspaceId,
        name: run.snapshot.name,
        description: run.snapshot.objective,
        ownerBotId: run.snapshot.ownerBotId,
        botIds: bot ? [bot.id] : [],
        createdAt: run.startedAt,
        updatedAt: run.finishedAt ?? run.startedAt,
      }}
      onProviders={onProviders}
      onBotChanged={onBotChanged}
      onOpenBot={onOpenBot}
      onViewComputer={onViewComputer}
      onOpenSource={onOpenSource}
      run={{
        id: run.id,
        active,
        onBack,
        error,
        controls: (
          <>
            <span className="status-label" title={dateTime(run.startedAt)}>
              {status}
            </span>
            {active && (
              <button
                className="button button--small"
                onClick={() => {
                  setError('');
                  void chatService
                    .stop('private:' + run.conversationId)
                    .catch((caught) => setError(errorText(caught)));
                }}
              >
                <Square size={13} /> Stop run
              </button>
            )}
            {bot && ['failed', 'interrupted', 'stopped'].includes(run.status) && (
              <RetryResponseButton
                className="button button--small"
                label={retrying ? 'Retrying…' : 'Retry run'}
                disabled={retrying}
                onRetry={() => void retry()}
              />
            )}
          </>
        ),
        outcome: (
          <>
            <div className="pursuit-run-summary">
              <h2>Run outcome</h2>
              <p>
                {status} · {run.trigger === 'schedule' ? 'Scheduled wake' : 'Requested run'} ·{' '}
                {dateTime(run.startedAt)}
              </p>
              {run.error && (
                <p className="ai-alert" role="status">
                  {run.error}
                </p>
              )}
              {run.summary ? (
                <MessageMarkdown text={run.summary} />
              ) : (
                <p>{active ? 'This run is still in progress.' : 'No outcome was recorded.'}</p>
              )}
            </div>
            <div className="pursuit-run-context">
              <h3>Run context</h3>
              <dl>
                <dt>Objective</dt>
                <dd>{run.snapshot.objective}</dd>
                <dt>Success criteria</dt>
                <dd>{run.snapshot.successCriteria}</dd>
              </dl>
            </div>
          </>
        ),
      }}
    />
  );
}
