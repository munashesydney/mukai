import { SettingsHeading } from './SettingsHeading';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { Sheet } from '../../components/ui/Sheet';
import { useCallback, useEffect, useState } from 'react';
import { capabilityService } from '../../services/capabilityService';
import type { EnvironmentVariable } from '../../../../shared/customCapabilities';
import { parseDotEnv } from '../../../../shared/dotEnv';
import { errorText } from '../../utils/errors';

export function EnvironmentPanel({ workspaceId }: { workspaceId: string }) {
  const [editor, setEditor] = useState<'variable' | 'import' | null>(null);
  const [variables, setVariables] = useState<EnvironmentVariable[]>([]);
  const [name, setName] = useState(''),
    [value, setValue] = useState(''),
    [block, setBlock] = useState('');
  const [preview, setPreview] = useState<{ name: string; value: string }[]>([]);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(
    async () => setVariables(await capabilityService.environment(workspaceId)),
    [workspaceId],
  );
  useEffect(() => {
    setName('');
    setValue('');
    setBlock('');
    setPreview([]);
    void refresh().catch((error) => setError(errorText(error)));
  }, [refresh]);
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh();
      setEditor(null);
      setNotice('Saved. Subsequent calls use the current configuration.');
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="provider-panel capability-panel">
      <SettingsHeading
        eyebrow="WORKSPACE CONFIGURATION"
        title="Environment Variables"
        description="Private configuration for this workspace’s custom tools and routes. Values are encrypted and never returned to bots."
        actions={
          <>
            <button
              className="button button--primary"
              onClick={() => {
                setName('');
                setValue('');
                setError('');
                setEditor('variable');
              }}
            >
              <Plus size={15} />
              Add variable
            </button>
            <button
              className="button"
              onClick={() => {
                setError('');
                setEditor('import');
              }}
            >
              Import .env
            </button>
          </>
        }
      />
      {error && (
        <div className="ai-alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="ai-notice" role="status">
          {notice}
        </p>
      )}
      {editor === 'variable' && (
        <Sheet title="Environment variable" onClose={() => setEditor(null)}>
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
                  await capabilityService.saveEnvironment(workspaceId, [{ name, value }]);
                  setName('');
                  setValue('');
                });
              }}
            >
              <label>
                Variable name
                <input
                  required
                  pattern="[A-Za-z_][A-Za-z0-9_]*"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="REVENUE_API_KEY"
                  autoComplete="off"
                />
              </label>
              <label>
                New value
                <input
                  type="password"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <button className="button button--primary" disabled={busy}>
                Save variable
              </button>
            </form>
          </div>
        </Sheet>
      )}
      {editor === 'import' && (
        <Sheet title="Import environment variables" onClose={() => setEditor(null)}>
          <div className="bot-editor-body capability-sheet-body">
            {error && (
              <div className="ai-alert" role="alert">
                {error}
              </div>
            )}
            <div className="capability-import ai-form">
              <label>
                Environment block
                <textarea
                  aria-label="Environment block"
                  value={block}
                  onChange={(event) => {
                    setBlock(event.target.value);
                    setPreview([]);
                  }}
                  spellCheck={false}
                />
              </label>
              <p className="ai-caption">
                This field contains the values you paste. Stored values stay masked.
              </p>
              <button
                className="button"
                disabled={busy}
                onClick={() => {
                  try {
                    setPreview(parseDotEnv(block));
                    setError('');
                  } catch (error) {
                    setError(errorText(error));
                  }
                }}
              >
                Preview import
              </button>
              {preview.length > 0 && (
                <>
                  <p className="ai-caption">
                    {preview.map((item) => item.name).join(', ')} · {preview.length} variables.
                    Existing names will be replaced.
                  </p>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await capabilityService.saveEnvironment(workspaceId, preview);
                        setBlock('');
                        setPreview([]);
                      })
                    }
                  >
                    Save {preview.length} variables
                  </button>
                </>
              )}
            </div>
          </div>
        </Sheet>
      )}
      <div className="provider-list">
        {variables.map((variable) => (
          <article key={variable.name} className="provider-card">
            <div className="provider-card-heading">
              <span className="provider-symbol">
                <KeyRound size={18} />
              </span>
              <div>
                <strong>{variable.name}</strong>
                <p>{variable.configured ? '•••••••• · Configured' : 'Needs configuration'}</p>
                <small>Used by: {variable.usedBy.join(', ') || 'No registrations yet'}</small>
              </div>
            </div>
            <div className="ai-form-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => {
                  setName(variable.name);
                  setValue('');
                  setError('');
                  setEditor('variable');
                }}
              >
                Edit
              </button>
              <button
                className="text-button danger-text"
                disabled={busy}
                onClick={() =>
                  void perform(() =>
                    capabilityService.removeEnvironment(workspaceId, variable.name),
                  )
                }
              >
                <Trash2 size={14} aria-hidden="true" />
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
      {!variables.length && (
        <p className="provider-empty">
          No variables yet. A module’s requiredEnv names will appear here too.
        </p>
      )}
    </section>
  );
}
