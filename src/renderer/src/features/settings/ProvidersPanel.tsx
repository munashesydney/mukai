import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, KeyRound, Plus, Radio, Trash2 } from 'lucide-react';
import type { ProviderInput, ProviderSettings, ProviderKind } from '../../../../shared/ai';
import { providerService } from '../../services/providerService';
import { errorText } from '../../utils/errors';
import { Dropdown } from '../../components/ui/Dropdown';
import { ChatGPTModelSelect } from '../../components/ChatGPTModelSelect';
import type { ChatGPTSignIn } from '../../../../shared/ai';

const kinds: { id: ProviderKind; label: string; model: string }[] = [
  { id: 'openai', label: 'OpenAI', model: 'gpt-4.1-mini' },
  { id: 'chatgpt', label: 'ChatGPT subscription', model: '' },
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
  contextWindowTokens: null,
  maxOutputTokens: 8192,
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
  const [signIn, setSignIn] = useState<ChatGPTSignIn | null>(null);
  const pendingSignIn = useRef<string | undefined>(undefined);
  const retrySignIn = useRef<string | undefined>(undefined);
  useEffect(
    () => () => {
      if (pendingSignIn.current)
        void providerService.cancelChatGPT(pendingSignIn.current).catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (!signIn || signIn.status !== 'pending') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await providerService.chatGPTStatus(signIn!.id);
        if (!alive) return;
        if (result.status === 'pending') {
          timer = setTimeout(() => void poll(), 1500);
          return;
        }
        if (result.status === 'complete') {
          const connections = await providerService.list();
          if (!alive) return;
          setProviders(connections);
          const provider = connections.find((item) => item.id === result.providerId);
          if (provider) {
            setEditing(provider.id);
            setValue({ ...provider, apiKey: '' });
            setError('');
            setRemoveId(null);
          }
          setNotice(result.message || 'ChatGPT connected.');
          onChanged();
        } else {
          retrySignIn.current = result.id;
          setError(result.message || 'ChatGPT sign-in was cancelled.');
        }
        pendingSignIn.current = undefined;
        setSignIn(null);
      } catch (error) {
        if (alive) {
          setError(errorText(error));
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [signIn, onChanged]);
  async function connect() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const attempt = await providerService.beginChatGPT(
        editing === 'new' ? undefined : editing || undefined,
        Boolean(saved && !saved.account?.planEnabled),
        retrySignIn.current,
      );
      retrySignIn.current = undefined;
      pendingSignIn.current = attempt.id;
      setSignIn(attempt);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function cancelSignIn() {
    if (!signIn) return;
    await providerService.cancelChatGPT(signIn.id).catch((error) => setError(errorText(error)));
    pendingSignIn.current = undefined;
    setSignIn(null);
  }
  async function disconnect() {
    if (!saved) return;
    setBusy(true);
    setError('');
    try {
      setNotice((await providerService.disconnectChatGPT(saved.id)).message);
      await refresh();
      onChanged();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
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
    if (!value.contextWindowTokens) {
      setError('Enter this model’s context-window size in tokens.');
      return;
    }
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
      const result = await providerService.remove(removeId!);
      setNotice(result.message || 'Provider removed.');
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
        <p>Connect ChatGPT or bring your own keys. Choose the model your bots use by default.</p>
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
            disabled={busy || Boolean(signIn)}
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
              disabled={busy || Boolean(signIn) || editing !== 'new'}
              onChange={(selected) => {
                const kind = kinds.find((kind) => kind.id === selected)!;
                setValue({
                  ...value,
                  kind: kind.id,
                  name: kind.label,
                  defaultModel: kind.model,
                  contextWindowTokens: null,
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
          {value.kind !== 'chatgpt' && (
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
          )}
          {value.kind === 'chatgpt' && (
            <div className="chatgpt-connection">
              {saved?.account && (
                <p>
                  {saved.account.label} ·{' '}
                  {saved.account.connected
                    ? saved.account.planEnabled
                      ? 'Plan usage enabled'
                      : 'Plan usage disabled'
                    : 'Disconnected'}
                </p>
              )}
              <p className="ai-caption">
                Eligible Plus and Pro accounts can authorize Mukai to use their ChatGPT plan.
                Requests share your plan and app limits.
              </p>
              {signIn ? (
                <>
                  <p role="status">
                    Finish signing in in your browser. This attempt expires after five minutes.
                  </p>
                  {signIn.url && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        if (window.mukai) void window.mukai.openExternal(signIn.url!);
                        else window.open(signIn.url!, '_blank', 'noopener,noreferrer');
                      }}
                    >
                      Open sign-in again
                    </button>
                  )}
                  <button type="button" className="button" onClick={() => void cancelSignIn()}>
                    Cancel sign-in
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button button--primary"
                  disabled={busy}
                  onClick={() => void connect()}
                >
                  {saved?.account?.connected
                    ? saved.account.planEnabled
                      ? 'Reconnect ChatGPT'
                      : 'Enable ChatGPT plan usage'
                    : 'Continue with ChatGPT'}
                </button>
              )}
              {saved?.account?.connected && !signIn && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  Disconnect ChatGPT
                </button>
              )}
            </div>
          )}
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
            {value.kind === 'chatgpt' ? (
              saved?.account?.connected && saved.account.planEnabled ? (
                <ChatGPTModelSelect
                  providerId={saved.id}
                  value={value.defaultModel}
                  disabled={busy || Boolean(signIn)}
                  onChange={(id, model) =>
                    setValue({
                      ...value,
                      defaultModel: id,
                      contextWindowTokens: model?.contextWindowTokens ?? null,
                      supportsImages: model?.supportsImages ?? false,
                    })
                  }
                />
              ) : (
                <small>Connect an account and enable plan usage to choose a model.</small>
              )
            ) : (
              <input
                required
                maxLength={150}
                placeholder="Enter an exact model ID"
                value={value.defaultModel}
                disabled={busy}
                onChange={(event) =>
                  setValue({
                    ...value,
                    defaultModel: event.target.value,
                    contextWindowTokens: null,
                  })
                }
              />
            )}
            {value.kind !== 'chatgpt' && (
              <small>Use a chat model available to your account or installed locally.</small>
            )}
          </label>
          <div className="ai-form-grid">
            <label>
              Context window (tokens)
              <input
                type="number"
                required
                min={4096}
                max={10000000}
                step={1}
                disabled={busy}
                value={value.contextWindowTokens ?? ''}
                placeholder="e.g. 128000"
                onChange={(event) =>
                  setValue({
                    ...value,
                    contextWindowTokens: event.target.value ? Number(event.target.value) : null,
                  })
                }
              />
              <small>
                Use the capacity documented for this exact model. Mukai uses it for automatic
                compaction.
              </small>
            </label>
            <label>
              {value.kind === 'chatgpt' ? 'Output reserve (tokens)' : 'Maximum output (tokens)'}
              <input
                type="number"
                required
                min={256}
                max={262144}
                step={1}
                disabled={busy}
                value={value.maxOutputTokens ?? 8192}
                onChange={(event) =>
                  setValue({ ...value, maxOutputTokens: Number(event.target.value) })
                }
              />
              <small>
                {value.kind === 'chatgpt'
                  ? 'Used for local context budgeting; ChatGPT does not accept an output-token cap. '
                  : ''}
                Per generation, including reasoning where the provider counts it. Mukai reserves up
                to an eighth of the context for output, and adjusts it to available room.
              </small>
            </label>
          </div>
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
            Connection tests send a short request and use your selected provider’s usage allowance.
          </p>
          <div className="ai-form-actions">
            <button
              type="submit"
              className="button button--primary"
              disabled={
                busy ||
                Boolean(signIn) ||
                (value.kind === 'chatgpt' &&
                  (!saved?.account?.connected || !saved.account.planEnabled || !value.defaultModel))
              }
            >
              {busy ? 'Connecting…' : 'Save provider'}
            </button>
            <button
              type="button"
              className="button"
              disabled={
                busy ||
                Boolean(signIn) ||
                !value.name.trim() ||
                !value.defaultModel.trim() ||
                (value.kind === 'chatgpt'
                  ? !saved?.account?.connected || !saved.account.planEnabled
                  : value.kind !== 'compatible' && !value.apiKey && !saved?.hasKey)
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
                    {provider.kind === 'chatgpt'
                      ? provider.account?.label
                      : provider.hasKey
                        ? '••••••••'
                        : 'No API key'}{' '}
                    · {provider.supportsImages ? 'Text & images' : 'Text only'}
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
            Your credentials stay on this computer. Chat context and supported attachments are sent
            directly to your chosen provider.
          </p>
        </>
      )}
    </div>
  );
}
