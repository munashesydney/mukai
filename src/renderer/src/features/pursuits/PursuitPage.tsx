import { useEffect, useState } from 'react';
import { ArrowUpRight, Clock3, Pause, Play, Target } from 'lucide-react';
import type { Bot } from '../../../../shared/ai';
import {
  pursuitStatusLabels,
  scheduledStatus,
  type PursuitDetail,
} from '../../../../shared/pursuits';
import { pursuitService } from '../../services/pursuitService';
import { errorText } from '../../utils/errors';
import { Avatar } from '../../components/ui/Avatar';
import { WakeCountdown } from './WakeCountdown';
import { PursuitRunView } from './PursuitRunView';
export function PursuitPage({
  id,
  bots,
  onOwner,
}: {
  id: string;
  bots: Bot[];
  onOwner: (id: string) => void;
}) {
  const [detail, setDetail] = useState<PursuitDetail | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState('Overview'),
    [selectedRun, setSelectedRun] = useState<string | null>(null);
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
    run = runs.find((item) => item.id === selectedRun);
  if (run)
    return (
      <main className="conversation">
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
          {['Overview', 'Notebook & plan'].map((name) => (
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
        {tab === 'Notebook & plan' ? (
          <section className="pursuit-notebook">
            <span className="preview-badge">Preview · sample notebook</span>
            <h2>Working notebook & plan</h2>
            <p>
              This tab is a preview. Run outcomes are saved separately and carried into the next
              run.
            </p>
            <div className="pursuit-note">
              <h3>Findings & decisions</h3>
              <p>
                Start with the smallest verifiable step. Record evidence before changing direction.
              </p>
            </div>
            <div className="pursuit-note">
              <h3>Next steps</h3>
              <ol>
                <li>Review the objective and success criteria.</li>
                <li>Check available tools and workspace context.</li>
                <li>Work, verify the result, and report the next step.</li>
              </ol>
            </div>
          </section>
        ) : (
          <>
            <section className="pursuit-runtime">
              <WakeCountdown pursuit={p} />
              <div className="pursuit-controls">
                <button
                  className="button"
                  disabled={busy || !owner || p.status === 'completed'}
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
                  disabled={busy || !scheduledStatus(p.status) || Boolean(p.currentRunId) || !owner}
                  onClick={() => void action(() => pursuitService.run(id))}
                >
                  <Play size={15} /> Run now
                </button>
              </div>
              <p className="pursuit-wake-reason">{p.nextRunReason}</p>
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
            <div className="pursuit-policy">
              <Clock3 size={16} />
              <span>
                Every {p.intervalMinutes} minute{p.intervalMinutes !== 1 ? 's' : ''} · Scheduled
                wakes
              </span>
              {p.deadline && (
                <time dateTime={p.deadline}>
                  Deadline · {new Date(p.deadline).toLocaleString()}
                </time>
              )}
            </div>
            <section className="pursuit-runs">
              <div className="pursuit-section-heading">
                <h2>Runs</h2>
                <span>{runs.length} recent</span>
              </div>
              {runs.length ? (
                runs.map((item, index) => (
                  <button
                    className="pursuit-run-row"
                    key={item.id}
                    onClick={() => setSelectedRun(item.id)}
                  >
                    <span
                      className={`pursuit-run-dot ${item.status === 'running' ? 'is-running' : ''}`}
                    />
                    <div>
                      <strong>
                        {item.status === 'running' ? 'Working now' : `Run ${runs.length - index}`}
                      </strong>
                      <small>
                        {new Date(item.startedAt).toLocaleString()} ·{' '}
                        {item.trigger === 'schedule' ? 'Scheduled' : 'Requested'}
                      </small>
                      <p>
                        {item.summary || item.error || 'The owner is working toward the objective.'}
                      </p>
                    </div>
                    <span className="pursuit-run-status">{item.status}</span>
                    <ArrowUpRight size={16} />
                  </button>
                ))
              ) : (
                <div className="pursuit-empty-runs">
                  <p>No runs yet.</p>
                  <small>The owner will wake on schedule. You can also run it now.</small>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
