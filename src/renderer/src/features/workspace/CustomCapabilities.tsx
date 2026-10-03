import { useCallback, useEffect, useState } from 'react';
import type { CapabilityRegistration } from '../../../../shared/customCapabilities';
import { capabilityService, type CapabilityDetail } from '../../services/capabilityService';
import { errorText } from '../../utils/errors';

export function CustomCapabilities({ workspaceId, query }: { workspaceId: string; query: string }) {
  const [items, setItems] = useState<CapabilityRegistration[]>([]),
    [detail, setDetail] = useState<CapabilityDetail | null>(null);
  const [kind, setKind] = useState<'tool' | 'route'>('tool'),
    [modulePath, setModulePath] = useState('');
  const [exportName, setExportName] = useState('default'),
    [testInput, setTestInput] = useState('{}');
  const [output, setOutput] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const items = await capabilityService.list(workspaceId);
    setItems(items);
    setDetail((previous) => {
      if (!previous) return null;
      const current = items.find((item) => item.id === previous.registration.id);
      return current ? { ...previous, registration: current } : null;
    });
  }, [workspaceId]);
  useEffect(() => {
    setDetail(null);
    setOutput('');
    setError('');
    setLoading(true);
    void refresh()
      .catch((error) => setError(errorText(error)))
      .finally(() => setLoading(false));
  }, [refresh]);
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function inspect(item: CapabilityRegistration) {
    const next = await capabilityService.detail(workspaceId, item.id);
    setDetail(next);
    setOutput('');
    setTestInput(
      item.kind === 'tool'
        ? '{}'
        : JSON.stringify(
            { headers: { 'content-type': 'application/json' }, rawBody: '{}' },
            null,
            2,
          ),
    );
  }
  const visible = items.filter((item) =>
    (item.definition.name + ' ' + item.modulePath + ' ' + (item.definition.path || ''))
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="custom-capabilities">
      {error && (
        <div className="ai-alert" role="alert">
          {error}
        </div>
      )}
      {(['tool', 'route'] as const).map((section) => (
        <section key={section} className="tool-detail-section">
          <div className="capability-heading">
            <h2>{section === 'tool' ? 'Custom tools' : 'Routes'}</h2>
            <button className="text-button" disabled={busy} onClick={() => void perform(refresh)}>
              Refresh
            </button>
          </div>
          {loading ? (
            <p className="ai-caption">Loading…</p>
          ) : (
            <div className="capability-list">
              {visible
                .filter((item) => item.kind === section)
                .map((item) => (
                  <article className="capability-card" key={item.id}>
                    <button
                      className="capability-open"
                      disabled={busy}
                      onClick={() => void perform(() => inspect(item))}
                    >
                      <strong>{item.definition.name}</strong>
                      <span>
                        {item.status.replaceAll('_', ' ')}
                        {item.missingEnv.length ? ' · ' + item.missingEnv.join(', ') : ''}
                      </span>
                      <small>
                        {item.kind === 'tool'
                          ? item.definition.description
                          : item.definition.method +
                            ' ' +
                            item.definition.path +
                            ' · ' +
                            item.definition.auth}
                      </small>
                      {item.error && <small>{item.error}</small>}
                    </button>
                    <div className="capability-actions">
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() =>
                          void perform(() =>
                            capabilityService.manage(
                              workspaceId,
                              item.kind,
                              item.enabled ? 'disable' : 'enable',
                              { id: item.id },
                            ),
                          )
                        }
                      >
                        {item.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await capabilityService.manage(workspaceId, item.kind, 'remove', {
                              id: item.id,
                            });
                            if (detail?.registration.id === item.id) setDetail(null);
                          })
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
            </div>
          )}
          {!loading && !visible.some((item) => item.kind === section) && (
            <p className="ai-caption">
              {section === 'tool' ? 'No custom tools yet.' : 'No routes yet.'}
            </p>
          )}
        </section>
      ))}
      <details className="capability-import">
        <summary>Register a saved module</summary>
        <form
          className="capability-form"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              await capabilityService.manage(workspaceId, kind, 'register', {
                modulePath,
                exportName,
              });
              setModulePath('');
            });
          }}
        >
          <label>
            Type
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as 'tool' | 'route')}
            >
              <option value="tool">Custom tool</option>
              <option value="route">Route</option>
            </select>
          </label>
          <label>
            Workspace module path
            <input
              value={modulePath}
              required
              placeholder="capabilities/revenue.ts"
              onChange={(event) => setModulePath(event.target.value)}
            />
          </label>
          <label>
            Export name
            <input
              value={exportName}
              required
              onChange={(event) => setExportName(event.target.value)}
            />
          </label>
          <button className="button" disabled={busy}>
            Validate & register
          </button>
        </form>
      </details>
      {detail && (
        <section className="capability-inspector">
          <div className="capability-heading">
            <h2>{detail.registration.definition.name}</h2>
            <button className="text-button" onClick={() => setDetail(null)}>
              Close
            </button>
          </div>
          <p>
            {detail.registration.modulePath} · Version {detail.registration.version} ·{' '}
            {detail.registration.status.replaceAll('_', ' ')}
          </p>
          <p>Owner: {detail.registration.ownerBotId || 'You'} · Available within this workspace.</p>
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
                External webhook providers need a reachable HTTPS address. Configure
                MUKAI_PUBLIC_BASE_URL and forward only /custom/* to this server. Mukai must remain
                running.
              </p>
            </div>
          )}
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
                await inspect(detail.registration);
              })
            }
          >
            Validate & update from file
          </button>
          <h3>Test handler</h3>
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
            className="button"
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
          <h3>Recent runs</h3>
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
              <h3>Background jobs</h3>
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
      )}
      <p className="ai-caption">
        Custom modules are trusted Node code with your OS account’s access. Declared environment
        values are scoped configuration; the runtime is not a security sandbox.
      </p>
    </div>
  );
}
