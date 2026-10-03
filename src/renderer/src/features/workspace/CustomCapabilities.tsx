import { FileCode2, Webhook, ChevronRight } from 'lucide-react';
import { Dropdown } from '../../components/ui/Dropdown';
import { Sheet } from '../../components/ui/Sheet';
import { useCallback, useEffect, useState } from 'react';
import type { CapabilityRegistration } from '../../../../shared/customCapabilities';
import { capabilityService } from '../../services/capabilityService';
import { errorText } from '../../utils/errors';

export function CustomCapabilities({
  workspaceId,
  query,
  onSelect,
}: {
  workspaceId: string;
  query: string;
  onSelect: (id: string) => void;
}) {
  const [items, setItems] = useState<CapabilityRegistration[]>([]);
  const [registering, setRegistering] = useState(false);
  const [kind, setKind] = useState<'tool' | 'route'>('tool'),
    [modulePath, setModulePath] = useState('');
  const [exportName, setExportName] = useState('default');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const items = await capabilityService.list(workspaceId);
    setItems(items);
  }, [workspaceId]);
  useEffect(() => {
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
            <div className="tool-family-list">
              {visible
                .filter((item) => item.kind === section)
                .map((item) => (
                  <button
                    className="tool-family-card capability-open"
                    key={item.id}
                    onClick={() => onSelect(item.id)}
                  >
                    <div className="tool-family-icon">
                      {item.kind === 'tool' ? <FileCode2 size={23} /> : <Webhook size={23} />}
                    </div>
                    <div className="tool-family-body">
                      <h2 className="tool-family-name">{item.definition.name}</h2>
                      <p>
                        {item.kind === 'tool'
                          ? item.definition.description
                          : item.definition.method + ' ' + item.definition.path}
                      </p>
                      <span
                        className={`tool-availability ${item.status === 'ready' ? 'is-ready' : ''}`}
                      >
                        {item.status.replaceAll('_', ' ')}
                        {item.missingEnv.length ? ' · ' + item.missingEnv.join(', ') : ''}
                      </span>
                      {item.error && <p>{item.error}</p>}
                    </div>
                    <ChevronRight className="tool-family-arrow" size={18} />
                  </button>
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
      <button
        className="button button--primary capability-register"
        onClick={() => {
          setError('');
          setRegistering(true);
        }}
      >
        Register a saved module
      </button>
      {registering && (
        <Sheet title="Register a saved module" onClose={() => setRegistering(false)}>
          <div className="bot-editor-body capability-sheet-body">
            {error && (
              <div className="ai-alert" role="alert">
                {error}
              </div>
            )}
            <form
              className="ai-form capability-form"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  await capabilityService.manage(workspaceId, kind, 'register', {
                    modulePath,
                    exportName,
                  });
                  setModulePath('');
                  setRegistering(false);
                });
              }}
            >
              <label>
                Type
                <Dropdown
                  label="Module type"
                  value={kind}
                  onChange={(value) => setKind(value as 'tool' | 'route')}
                  options={[
                    { value: 'tool', label: 'Custom tool' },
                    { value: 'route', label: 'Route' },
                  ]}
                />
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
              <button className="button button--primary" disabled={busy}>
                Validate & register
              </button>
            </form>
          </div>
        </Sheet>
      )}
      <p className="ai-caption">
        Custom modules are trusted Node code with your OS account’s access. Declared environment
        values are scoped configuration; the runtime is not a security sandbox.
      </p>
    </div>
  );
}
