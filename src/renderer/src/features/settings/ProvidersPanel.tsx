import { useEffect, useState } from 'react';
import { Check, ChevronLeft, KeyRound, Plus, Radio, Trash2 } from 'lucide-react';
import type { ProviderInput, ProviderSettings, ProviderKind } from '../../../../shared/ai';
import { providerService } from '../../services/providerService';
import { errorText } from '../../utils/errors';
import { Dropdown } from '../../components/ui/Dropdown';

const kinds: { id: ProviderKind; label: string; model: string }[] = [
  { id: 'openai', label: 'OpenAI', model: 'gpt-4.1-mini' },
  { id: 'anthropic', label: 'Anthropic', model: 'claude-sonnet-4-6' },
  { id: 'google', label: 'Google', model: 'gemini-2.5-flash' },
  { id: 'compatible', label: 'OpenAI-compatible / local', model: '' },
];
const empty = (): ProviderInput => ({
  name: 'OpenAI',
  kind: 'openai',
  baseUrl: '',
  defaultModel: 'gpt-4.1-mini',
  supportsImages: true,
  isDefault: false,
  apiKey: '',
});
export function ProvidersPanel({ onChanged }: { onChanged: () => void }) {
  const [providers, setProviders] = useState<ProviderSettings[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState<ProviderInput>(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [removeId, setRemoveId] = useState<string | null>(null);
  async function refresh() {
    try {
      setProviders(await providerService.list());
      setError('');
    } catch (error) {
      setError(errorText(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  function edit(provider?: ProviderSettings) {
    setEditing(provider?.id || 'new');
    setError('');
    setNotice('');
    setRemoveId(null);
    setValue(
      provider ? { ...provider, apiKey: '' } : { ...empty(), isDefault: providers.length === 0 },
    );
  }
  async function save(test = false) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await (editing === 'new'
        ? providerService.create(value)
        : providerService.update(editing!, value));
      setEditing(saved.id);
      setValue({ ...saved, apiKey: '' });
      await refresh();
      onChanged();
      if (test) {
        const result = await providerService.test(saved.id);
        setNotice(result.message);
      } else {
        setEditing(null);
        setNotice('Provider settings saved.');
      }
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function test(provider: ProviderSettings) {
    setBusy(true);
    setNotice('');
    setError('');
    try {
      setNotice((await providerService.test(provider.id)).message);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await providerService.remove(removeId!);
      setRemoveId(null);
      await refresh();
      onChanged();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const saved = providers.find((provider) => provider.id === editing);
  return (
    <div className="provider-panel">
      <div className="settings-section-header">
        <span className="settings-eyebrow">YOUR AI CONNECTIONS</span>
        <h3>Providers</h3>
        <p>Bring your own keys. Choose the model your bots use by default.</p>
      </div>
      {error && (
        <div className="ai-alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="ai-notice" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
      {editing ? (
        <form
          className="ai-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setError('');
            }}
          >
            <ChevronLeft size={15} />
            All providers
          </button>
          <label>
            Provider type
            <Dropdown
              label="Provider type"
              value={value.kind}
              disabled={busy || editing !== 'new'}
              onChange={(selected) => {
                const kind = kinds.find((kind) => kind.id === selected)!;
                setValue({
                  ...value,
                  kind: kind.id,
                  name: kind.label,
                  defaultModel: kind.model,
                  supportsImages: kind.id !== 'compatible',
                  apiKey: '',
                });
              }}
              options={kinds.map((kind) => ({ value: kind.id, label: kind.label }))}
            />
          </label>
          <label>
            Display name
            <input
              required
              maxLength={80}
              value={value.name}
              disabled={busy}
              onChange={(event) => setValue({ ...value, name: event.target.value })}
            />
          </label>
          {value.kind === 'compatible' && (
            <label>
              Base URL
              <input
                required
                type="url"
                placeholder="http://127.0.0.1:11434/v1"
                value={value.baseUrl}
                disabled={busy}
                onChange={(event) => setValue({ ...value, baseUrl: event.target.value })}
              />
              <small>
                Include the API prefix, usually /v1. Local HTTP and remote HTTPS endpoints are
                supported.
              </small>
            </label>
          )}
          <label>
            API key {saved?.hasKey && <span className="key-saved">•••••••• saved</span>}
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              maxLength={4096}
              required={value.kind !== 'compatible' && !saved?.hasKey}
              placeholder={
                saved?.hasKey
                  ? 'Leave blank to keep the saved key'
                  : value.kind === 'compatible'
                    ? 'Optional for local models'
                    : 'Paste your provider API key'
              }
              value={value.apiKey || ''}
              disabled={busy}
              onChange={(event) =>
                setValue({ ...value, apiKey: event.target.value, clearKey: false })
              }
            />
            <small>
              Encrypted on this device’s server. Saved keys are never returned to the interface.
            </small>
          </label>
          {value.kind === 'compatible' && saved?.hasKey && (
            <label className="ai-checkbox">
              <input
                type="checkbox"
                disabled={busy}
                checked={Boolean(value.clearKey)}
                onChange={(event) =>
                  setValue({ ...value, clearKey: event.target.checked, apiKey: '' })
                }
              />
              Remove the saved key (for endpoints without authentication)
            </label>
          )}
          <label>
            Default model
            <input
              required
              maxLength={150}
              placeholder="Enter an exact model ID"
              value={value.defaultModel}
              disabled={busy}
              onChange={(event) => setValue({ ...value, defaultModel: event.target.value })}
            />
            <small>Use a chat model available to your account or installed locally.</small>
          </label>
          <label className="ai-checkbox">
            <input
              type="checkbox"
              disabled={busy}
              checked={value.supportsImages}
              onChange={(event) => setValue({ ...value, supportsImages: event.target.checked })}
            />
            This model supports images
          </label>
          <label className="ai-checkbox">
            <input
              type="checkbox"
              disabled={busy || Boolean(saved?.isDefault)}
              checked={value.isDefault}
              onChange={(event) => setValue({ ...value, isDefault: event.target.checked })}
            />
            Use as the default provider
          </label>
          <p className="ai-caption">
            Connection tests send a short request and may incur a small provider charge.
          </p>
          <div className="ai-form-actions">
            <button type="submit" className="button button--primary" disabled={busy}>
              {busy ? 'Connecting…' : 'Save provider'}
            </button>
            <button
              type="button"
              className="button"
              disabled={
                busy ||
                !value.name.trim() ||
                !value.defaultModel.trim() ||
                (value.kind !== 'compatible' && !value.apiKey && !saved?.hasKey)
              }
              onClick={() => void save(true)}
            >
              Save & test
            </button>
          </div>
        </form>
      ) : (
        <>
          {loading ? (
            <p className="ai-caption">Loading providers…</p>
          ) : providers.length ? (
            <div className="provider-list">
              {providers.map((provider) => (
                <div className="provider-card" key={provider.id}>
                  <div className="provider-card-heading">
                    <span className="provider-symbol">
                      <KeyRound size={18} />
                    </span>
                    <div>
                      <strong>{provider.name}</strong>
                      <small>{provider.defaultModel}</small>
                    </div>
                    {provider.isDefault && <span className="provider-default">Default</span>}
                  </div>
                  <p>
                    {kinds.find((kind) => kind.id === provider.kind)?.label} ·{' '}
                    {provider.hasKey ? '••••••••' : 'No API key'} ·{' '}
                    {provider.supportsImages ? 'Text & images' : 'Text only'}
                  </p>
                  <div className="ai-form-actions">
                    <button className="button" disabled={busy} onClick={() => edit(provider)}>
                      Edit
                    </button>
                    <button className="button" disabled={busy} onClick={() => void test(provider)}>
                      <Radio size={14} />
                      Test connection
                    </button>
                    <button
                      className="icon-button provider-delete"
                      aria-label={`Remove ${provider.name}`}
                      disabled={busy}
                      onClick={() => setRemoveId(provider.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  {removeId === provider.id && (
                    <div className="delete-confirm">
                      <p>
                        Remove this provider? Bots using the default provider will use the next
                        available provider.
                      </p>
                      <button
                        className="button button--danger"
                        disabled={busy}
                        onClick={() => void remove()}
                      >
                        Remove provider
                      </button>
                      <button className="button" disabled={busy} onClick={() => setRemoveId(null)}>
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="provider-empty">
              <KeyRound size={28} />
              <h4>Give Scout a connection.</h4>
              <p>Add a provider to start your first real conversation.</p>
            </div>
          )}
          <button
            className="button button--primary"
            disabled={busy || loading}
            onClick={() => edit()}
          >
            <Plus size={15} />
            Add provider
          </button>
          <p className="ai-caption">
            Your keys stay on this computer. Chat context and supported attachments are sent
            directly to your chosen provider.
          </p>
        </>
      )}
    </div>
  );
}
