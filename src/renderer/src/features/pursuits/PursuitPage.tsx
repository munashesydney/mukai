import { useWorkspaceTime } from '../timezone/WorkspaceTimeContext';
import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  ChevronDown,
  Clock3,
  MoreHorizontal,
  Pause,
  Play,
  Target,
  Trash2,
} from 'lucide-react';
import { ConfirmationModal } from '../../components/ui/ConfirmationModal';
import { PopupMenu } from '../../components/ui/PopupMenu';
import type { Bot, ProviderSettings } from '../../../../shared/ai';
import type { NotificationSource } from '../../../../shared/notifications';
import {
  pursuitStatusLabels,
  scheduledStatus,
  type PursuitDetail,
  type PursuitRun,
} from '../../../../shared/pursuits';
import { pursuitService } from '../../services/pursuitService';
import { startPoll } from '../../services/poll';
import { errorText } from '../../utils/errors';
import { Avatar } from '../../components/ui/Avatar';
import { WakeCountdown } from './WakeCountdown';
import { PursuitRunView } from './PursuitRunView';
import { PursuitRuns } from './PursuitRuns';
import { PursuitWorkpad } from './PursuitWorkpad';
import { MessageMarkdown } from '../ai/MessageMarkdown';
import { BrowserToggle } from '../browser/BrowserToggle';
export function PursuitPage({
  id,
  bots,
  onOwner,
  onDeleted,
  runId,
  detail,
  detailError,
  refresh,
  onRun,
  providers,
  onProviders,
  onBotChanged,
  onOpenBot,
  onOpenSource,
  onViewComputer,
}: {
  id: string;
  bots: Bot[];
  onOwner: (id: string) => void;
  onDeleted: () => void;
  runId?: string;
  detail?: PursuitDetail;
  detailError?: string;
  refresh: (id: string) => Promise<PursuitDetail>;
  onRun: (runId?: string) => void;
  providers: ProviderSettings[];
  onProviders: () => void;
  onBotChanged: (bot: Bot) => void;
  onOpenBot: (id: string) => Promise<void>;
  onOpenSource: (source: NotificationSource) => Promise<void>;
  onViewComputer: () => void;
}) {
  const { dateTime } = useWorkspaceTime();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState(runId ? 'Runs' : 'Overview');
  const [olderRun, setOlderRun] = useState<PursuitRun | null>(null);
  const [deleting, setDeleting] = useState(false);
  const knownRun = Boolean(detail?.runs.some((run) => run.id === runId));
  useEffect(() => {
    if (!runId || knownRun) return;
    let alive = true;
    const poll = startPoll(
      async () => {
        try {
          const value = await pursuitService.runDetail(id, runId);
          if (alive) {
            setOlderRun(value);
            setError('');
          }
        } catch (caught) {
          if (alive) setError(errorText(caught));
        }
      },
      { interval: 2000, maxInterval: 8000 },
    );
    return () => {
      alive = false;
      poll.stop();
    };
  }, [id, runId, knownRun]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh(id);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await pursuitService.remove(id);
      onDeleted();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }
  if (!detail)
    return (
      <main className="conversation ai-main-state">
        <p role={error || detailError ? 'alert' : 'status'}>
          {error || detailError || 'Loading pursuit…'}
        </p>
      </main>
    );
  const { pursuit: p, runs } = detail,
    owner = bots.find((b) => b.id === p.ownerBotId),
    run = runs.find((item) => item.id === runId) || (olderRun?.id === runId ? olderRun : undefined);
  const scheduledFrom = runs.reduce(
    (latest, item) =>
      item.finishedAt && Date.parse(item.finishedAt) > Date.parse(latest)
        ? item.finishedAt
        : latest,
    p.createdAt,
  );
  if (run)
    return (
      <PursuitRunView
        key={run.id}
        run={run}
        bot={bots.find((item) => item.id === run.snapshot.ownerBotId)}
        bots={bots}
        providers={providers}
        onProviders={onProviders}
        onBotChanged={onBotChanged}
        onOpenBot={onOpenBot}
        onOpenSource={onOpenSource}
        onViewComputer={onViewComputer}
        onBack={() => onRun()}
        onRetried={(resumed) => {
          setOlderRun(resumed);
          void refresh(id).catch((caught) => setError(errorText(caught)));
        }}
      />
    );
  if (runId)
    return (
      <main className="conversation ai-main-state">
        <p role={error ? 'alert' : 'status'}>{error || 'Loading run…'}</p>
        <button className="text-button" onClick={() => onRun()}>
          All runs
        </button>
      </main>
    );
  return (
    <main className="conversation pursuit-page">
      <header className="pursuit-header">
        <div className="pursuit-title">
          <span className="heading-space">
            <Target size={24} />
          </span>
          <h1>{p.name}</h1>
          <span className={`pursuit-state pursuit-state--${p.status}`}>
            {pursuitStatusLabels[p.status]}
          </span>
          <BrowserToggle />
          <PopupMenu
            label="Pursuit actions"
            title="Pursuit actions"
            trigger={<MoreHorizontal size={20} />}
            buttonClassName="icon-button"
            disabled={busy}
            width={240}
          >
            {(close) => (
              <button
                type="button"
                role="menuitem"
                className="danger-text"
                disabled={Boolean(p.currentRunId)}
                title={
                  p.currentRunId
                    ? 'Pause and wait for the current run to stop before deleting'
                    : undefined
                }
                onClick={() => {
                  close();
                  setError('');
                  setDeleting(true);
                }}
              >
                <Trash2 size={15} /> Delete pursuit
              </button>
            )}
          </PopupMenu>
        </div>
        <div className="pursuit-owner">
          {owner ? (
            <button className="text-button" onClick={() => onOwner(owner.id)}>
              <Avatar person={owner.avatar} size="xs" />
              {owner.name}
              <ArrowUpRight size={13} />
            </button>
          ) : (
            <span>Owning bot unavailable</span>
          )}
          <span>Owns this pursuit</span>
        </div>
        <div className="conversation-tabs" role="tablist" aria-label="Pursuit views">
          {['Overview', 'Workpad', 'Runs'].map((name) => (
            <button
              key={name}
              role="tab"
              aria-selected={tab === name}
              className={tab === name ? 'is-active' : ''}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </header>
      {error && (
        <p className="ai-alert" role="alert">
          {error}
        </p>
      )}
      <div className="pursuit-content">
        {tab === 'Workpad' ? (
          <PursuitWorkpad id={id} bots={bots} runs={runs} onRun={onRun} />
        ) : tab === 'Runs' ? (
          <PursuitRuns runs={runs} onSelect={onRun} />
        ) : (
          <>
            <section className="pursuit-runtime">
              <WakeCountdown pursuit={p} scheduledFrom={scheduledFrom} />
              {p.status !== 'completed' && (
                <div className="pursuit-controls">
                  <button
                    className="button"
                    disabled={busy || !owner}
                    onClick={() =>
                      void action(() =>
                        pursuitService.status(id, scheduledStatus(p.status) ? 'paused' : 'active'),
                      )
                    }
                  >
                    {scheduledStatus(p.status) ? <Pause size={15} /> : <Play size={15} />}{' '}
                    {scheduledStatus(p.status) ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    className="button button--primary"
                    disabled={
                      busy || !scheduledStatus(p.status) || Boolean(p.currentRunId) || !owner
                    }
                    onClick={() => void action(() => pursuitService.run(id))}
                  >
                    <Play size={15} /> Run now
                  </button>
                </div>
              )}
              {p.nextRunReason && (
                <details className="pursuit-runtime-details">
                  <summary>
                    <ChevronDown size={15} />
                    {p.status === 'completed' ? 'Completion details' : 'Status details'}
                  </summary>
                  <MessageMarkdown text={p.nextRunReason} />
                </details>
              )}
            </section>
            <div className="pursuit-objective-grid">
              <section className="pursuit-info-card">
                <span className="context-section-label">OBJECTIVE</span>
                <p>{p.objective}</p>
              </section>
              <section className="pursuit-info-card">
                <span className="context-section-label">SUCCESS CRITERIA</span>
                <p>{p.successCriteria}</p>
              </section>
            </div>
            {scheduledStatus(p.status) && p.nextRunInstructions && !p.currentRunId && (
              <section className="pursuit-info-card pursuit-next-instructions">
                <span className="context-section-label">NEXT RUN INSTRUCTIONS</span>
                <MessageMarkdown text={p.nextRunInstructions} />
              </section>
            )}
            <div className="pursuit-policy">
              <Clock3 size={16} />
              <span>The owner chooses when to run next</span>
              {p.deadline && <time dateTime={p.deadline}>Deadline · {dateTime(p.deadline)}</time>}
            </div>
          </>
        )}
      </div>
      {deleting && (
        <ConfirmationModal
          title={`Delete ${p.name}?`}
          confirmLabel="Delete pursuit"
          busy={busy}
          error={error}
          onClose={() => {
            setDeleting(false);
            setError('');
          }}
          onConfirm={() => void remove()}
        >
          <p>This permanently deletes this pursuit, its Workpad, and all run chats and history.</p>
        </ConfirmationModal>
      )}
    </main>
  );
}
