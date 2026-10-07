import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, FileCode2, Webhook } from 'lucide-react';
import { capabilityService, type CapabilityDetail } from '../../services/capabilityService';
import { errorText } from '../../utils/errors';
import type { Bot } from '../../../../shared/ai';
import { ToolAssignments } from './ToolAssignments';
import { Dropdown } from '../../components/ui/Dropdown';
import {
  customToolPermissionLabels,
  customToolPermissionModes,
  type CustomToolPermissionMode,
} from '../../../../shared/customCapabilities';
export function CustomCapabilityPage({
  workspaceId,
  id,
  onBack,
  bots,
}: {
  workspaceId: string;
  id: string;
  onBack: () => void;
  bots: Bot[];
}) {
  const [tab, setTab] = useState('Overview');
  const [detail, setDetail] = useState<CapabilityDetail | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [output, setOutput] = useState(''),
    [testInput, setTestInput] = useState('{}');
  const refresh = useCallback(async () => {
    const next = await capabilityService.detail(workspaceId, id);
    setDetail(next);
    return next;
  }, [workspaceId, id]);
  useEffect(() => {
    setDetail(null);
    setOutput('');
    setError('');
    void refresh()
      .then((next) =>
        setTestInput(
          next.registration.kind === 'route'
            ? JSON.stringify(
                { headers: { 'content-type': 'application/json' }, rawBody: '{}' },
                null,
                2,
              )
            : '{}',
        ),
      )
      .catch((e) => setError(errorText(e)));
  }, [refresh]);
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function inspect() {
    await refresh();
  }
  return (
    <div className="tool-detail custom-tool-detail">
      <button className="tool-detail-back" onClick={onBack}>
        <ArrowLeft size={15} />
        All tools
      </button>
      {error && (
        <div className="ai-alert" role="alert">
          {error}
        </div>
      )}
      {detail && (
        <section className="capability-inspector">
          <div className="tool-detail-header">
            <div className="tool-family-icon">
              {detail.registration.kind === 'tool' ? (
                <FileCode2 size={23} />
              ) : (
                <Webhook size={23} />
              )}
            </div>
            <div>
              <h1>{detail.registration.definition.name}</h1>
              <span
                className={`tool-availability ${detail.registration.status === 'ready' ? 'is-ready' : ''}`}
              >
                {detail.registration.status.replaceAll('_', ' ')}
              </span>
            </div>
          </div>
          <p className="tool-detail-description">{detail.registration.definition.description}</p>
          <div className="ai-form-actions capability-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  capabilityService.manage(
                    workspaceId,
                    detail.registration.kind,
                    detail.registration.enabled ? 'disable' : 'enable',
                    { id },
                  ),
                )
              }
            >
              {detail.registration.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    await capabilityService.manage(
                      workspaceId,
                      detail.registration.kind,
                      'remove',
                      { id },
                    );
                    onBack();
                  } catch (e) {
                    setError(errorText(e));
                    setBusy(false);
                  }
                })()
              }
            >
              Delete
            </button>
          </div>
          <nav className="capability-tabs" aria-label="Custom tool sections">
            {['Overview', 'Code', 'Test', 'Runs'].map((name) => (
              <button
                key={name}
                className={`button ${tab === name ? 'button--primary' : ''}`}
                aria-pressed={tab === name}
                onClick={() => setTab(name)}
              >
                {name}
              </button>
            ))}
          </nav>
          <section hidden={tab !== 'Overview'} className="tool-detail-section">
            <h2>Registration</h2>
            <dl className="capability-metadata">
              <dt>Module</dt>
              <dd>{detail.registration.modulePath}</dd>
              <dt>Export</dt>
              <dd>{detail.registration.exportName}</dd>
              <dt>Version</dt>
              <dd title={detail.registration.version}>
                {detail.registration.version.slice(0, 12)}
              </dd>
              <dt>Owner</dt>
              <dd>{detail.registration.ownerBotId || 'You'}</dd>
              <dt>Environment</dt>
              <dd>{detail.registration.definition.requiredEnv?.join(', ') || 'None required'}</dd>
            </dl>
            {detail.registration.kind === 'tool' && (
              <label className="ai-form">
                Permission mode
                <Dropdown
                  label="Custom tool permission mode"
                  disabled={busy}
                  value={detail.registration.definition.permissionMode || 'user_approval'}
                  onChange={(value) =>
                    void perform(() =>
                      capabilityService.manage(workspaceId, 'tool', 'set_permission', {
                        id,
                        permissionMode: value as CustomToolPermissionMode,
                      }),
                    )
                  }
                  options={customToolPermissionModes.map((value) => ({
                    value,
                    label: customToolPermissionLabels[value],
                  }))}
                />
                <span className="ai-caption">
                  Auto approve runs immediately. Ask bot pauses for the bot’s decision. User
                  approval waits for you, including in Full access. Changing the mode cancels
                  pending bot confirmations.
                </span>
              </label>
            )}
            <ToolAssignments
              workspaceId={workspaceId}
              bots={bots}
              toolId={'custom:' + id}
              shared={detail.registration.kind === 'route'}
            />
            {detail.registration.kind === 'route' && (
              <div className="capability-url">
                <code>{detail.registration.url}</code>
                <button
                  className="button"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(detail.registration.url || '')
                      .catch(() => setError('Could not copy the URL.'))
                  }
                >
                  Copy URL
                </button>
                <p className="ai-caption">
                  External webhook providers need a reachable HTTPS address. Configure the public
                  base URL in Settings → Domain and forward only /custom/* to this server. Mukai
                  must remain running.
                </p>
              </div>
            )}
            {detail.registration.missingEnv.length > 0 && (
              <div className="ai-alert">
                Needs configuration: {detail.registration.missingEnv.join(', ')}
              </div>
            )}
            {detail.registration.error && (
              <div className="ai-alert">{detail.registration.error}</div>
            )}
          </section>
          <section hidden={tab !== 'Code'} className="tool-detail-section">
            <h2>Module</h2>
            <details>
              <summary>Definition</summary>
              <pre>{JSON.stringify(detail.registration.definition, null, 2)}</pre>
            </details>
            <details>
              <summary>Registered source</summary>
              <pre>{detail.source}</pre>
            </details>
            <p className="ai-caption">
              Edit the actual workspace file, then validate an update. A failed update preserves the
              working version.
            </p>
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await capabilityService.manage(workspaceId, detail.registration.kind, 'update', {
                    id: detail.registration.id,
                  });
                  await inspect();
                })
              }
            >
              Validate & update from file
            </button>
          </section>
          <section hidden={tab !== 'Test'} className="tool-detail-section ai-form">
            <h2>Test handler</h2>
            <p className="ai-caption">
              Tests execute real code and may cause external side effects.
              {detail.registration.kind === 'route'
                ? ' Supply headers and the exact rawBody string; the handler receives its UTF-8 bytes.'
                : ' Supply an input object matching the tool schema.'}
            </p>
            <label>
              Test input (JSON)
              <textarea
                value={testInput}
                onChange={(event) => setTestInput(event.target.value)}
                spellCheck={false}
              />
            </label>
            <button
              className="button button--primary"
              disabled={busy || detail.registration.status !== 'ready'}
              onClick={() =>
                void perform(async () => {
                  const result = await capabilityService.test(
                    workspaceId,
                    detail.registration.id,
                    JSON.parse(testInput),
                  );
                  setOutput(JSON.stringify(result, null, 2));
                  setDetail(await capabilityService.detail(workspaceId, detail.registration.id));
                })
              }
            >
              Run test
            </button>
            {output && <pre aria-label="Test result">{output}</pre>}
          </section>
          <section hidden={tab !== 'Runs'} className="tool-detail-section">
            <h2>Recent runs</h2>
            {detail.runs.length ? (
              <ul>
                {detail.runs.map((run) => (
                  <li key={run.id}>
                    {run.status} · {new Date(run.startedAt).toLocaleString()} ·{' '}
                    {run.durationMs ?? '—'} ms · {run.version.slice(0, 8)}
                    {run.error && <p>{run.error}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ai-caption">No runs yet.</p>
            )}
            {detail.jobs.length > 0 && (
              <>
                <h2>Background jobs</h2>
                <ul>
                  {detail.jobs.map((job) => (
                    <li key={job.id}>
                      {job.status} · {job.attempts} attempts{job.error && <p>{job.error}</p>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </section>
      )}
      {!detail && !error && <p className="ai-caption">Loading tool…</p>}
    </div>
  );
}
