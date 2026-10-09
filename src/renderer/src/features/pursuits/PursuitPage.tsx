import { useEffect, useState } from 'react';
import { ArrowUpRight, ChevronDown, Clock3, Pause, Play, Target } from 'lucide-react';
import type { Bot } from '../../../../shared/ai';
import {
  pursuitStatusLabels,
  scheduledStatus,
  type PursuitDetail,
  type PursuitRun,
} from '../../../../shared/pursuits';
import { pursuitService } from '../../services/pursuitService';
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
  runId,
}: {
  id: string;
  bots: Bot[];
  onOwner: (id: string) => void;
  runId?: string;
}) {
  const [detail, setDetail] = useState<PursuitDetail | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState('Overview'),
    [selectedRun, setSelectedRun] = useState<string | null>(runId || null);
  const [olderRun, setOlderRun] = useState<PursuitRun | null>(null);
  const knownRun = Boolean(detail?.runs.some((run) => run.id === selectedRun));
  useEffect(() => {
    if (!selectedRun || knownRun) return;
    let alive = true;
    void pursuitService
      .runDetail(id, selectedRun)
      .then((value) => {
        if (alive) {
          setOlderRun(value);
          setError('');
        }
      })
      .catch((caught) => {
        if (alive) setError(errorText(caught));
      });
    return () => {
      alive = false;
    };
  }, [id, selectedRun, knownRun]);
  useEffect(() => {
    let alive = true,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await pursuitService.detail(id);
        if (alive) {
          setDetail(value);
          setError('');
        }
      } catch (caught) {
        if (alive) setError(errorText(caught));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [id]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      setDetail(await pursuitService.detail(id));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }
  if (!detail)
    return (
      <main className="conversation ai-main-state">
        <p role={error ? 'alert' : undefined}>{error || 'Loading pursuit…'}</p>
      </main>
    );
  const { pursuit: p, runs } = detail,
    owner = bots.find((b) => b.id === p.ownerBotId),
    run =
      runs.find((item) => item.id === selectedRun) ||
      (olderRun?.id === selectedRun ? olderRun : undefined);
  const scheduledFrom = runs.reduce(
    (latest, item) =>
      item.finishedAt && Date.parse(item.finishedAt) > Date.parse(latest)
        ? item.finishedAt
        : latest,
    p.createdAt,
  );
  if (run)
    return (
      <main className="conversation pursuit-page">
        <PursuitRunView key={run.id} run={run} bot={owner} onBack={() => setSelectedRun(null)} />
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
          <PursuitWorkpad id={id} bots={bots} runs={runs} onRun={setSelectedRun} />
        ) : tab === 'Runs' ? (
          <PursuitRuns runs={runs} onSelect={setSelectedRun} />
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
              {p.deadline && (
                <time dateTime={p.deadline}>
                  Deadline · {new Date(p.deadline).toLocaleString()}
                </time>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
