import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Plus,
  Radio,
  Settings2,
  Trash2,
  ExternalLink,
} from 'lucide-react';
import type {
  ProviderInput,
  ProviderSettings,
  ChatGPTSignIn,
  ProviderModelsInput,
} from '../../../../shared/ai';
import {
  findProviderPreset,
  providerPresets,
  providerPresetInput,
  type ProviderPreset,
} from '../../../../shared/providerPresets';
import { providerService } from '../../services/providerService';
import { errorText } from '../../utils/errors';
import { Checkbox } from '../../components/ui/Checkbox';
import { Dropdown } from '../../components/ui/Dropdown';
import { ProviderModels } from './ProviderModels';

type View = 'list' | 'choose' | 'connection' | 'models';
const empty = () => providerPresetInput(providerPresets[0]);

export function ProvidersPanel({ onChanged }: { onChanged: () => void }) {
  const [providers, setProviders] = useState<ProviderSettings[]>([]);
  const [view, setView] = useState<View>('list');
  const [editing, setEditing] = useState<string | null>(null);
  const [presetId, setPresetId] = useState('openai');
  const [value, setValue] = useState<ProviderInput>(empty);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [pendingView, setPendingView] = useState<View | null>(null);
  const [signIn, setSignIn] = useState<ChatGPTSignIn | null>(null);
  const pendingSignIn = useRef<string | undefined>(undefined);
  const retrySignIn = useRef<string | undefined>(undefined);
  const saved = providers.find((provider) => provider.id === editing);
  const preset = providerPresets.find((preset) => preset.id === presetId);
  const connectionDirty = Boolean(
    saved &&
    (value.name !== saved.name ||
      value.baseUrl !== saved.baseUrl ||
      value.isDefault !== saved.isDefault ||
      value.apiKey ||
      value.clearKey),
  );
  const newConnectionDirty =
    editing === 'new' &&
    Boolean(
      value.apiKey?.trim() || value.name !== preset?.name || value.baseUrl !== preset?.baseUrl,
    );
  const canSave =
    !busy &&
    !signIn &&
    value.name.trim() &&
    (value.kind !== 'compatible' || value.baseUrl.trim()) &&
    (value.kind === 'chatgpt'
      ? saved?.account?.connected && saved.account.planEnabled
      : (value.kind === 'compatible' && !preset?.baseUrl) ||
        value.apiKey?.trim() ||
        saved?.hasKey) &&
    (!saved || connectionDirty);

  function accept(provider: ProviderSettings) {
    setProviders((current) => [
      ...current
        .filter((item) => item.id !== provider.id)
        .map((item) => (provider.isDefault ? { ...item, isDefault: false } : item)),
      provider,
    ]);
    setEditing(provider.id);
    setValue({ ...provider, apiKey: '' });
    onChanged();
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
          setNotice(result.message || 'ChatGPT connected. Configure its models to get started.');
          setView('models');
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
  function edit(provider: ProviderSettings, next: View = 'connection') {
    setEditing(provider.id);
    setValue({ ...provider, apiKey: '' });
    setPresetId(findProviderPreset(provider)?.id ?? provider.kind);
    setView(next);
    setError('');
    setNotice('');
    setRemoveId(null);
    setPendingView(null);
  }
  function choose(preset: ProviderPreset) {
    setPresetId(preset.id);
    setEditing('new');
    setValue(providerPresetInput(preset, providers.length === 0));
    setView('connection');
    setError('');
    setNotice('');
    setPendingView(null);
  }
  function navigate(next: View) {
    if (
      (view === 'connection' && connectionDirty) ||
      (view === 'connection' && newConnectionDirty)
    ) {
      setPendingView(next);
      return;
    }
    setView(next);
    setError('');
    setNotice('');
    setRemoveId(null);
    setPendingView(null);
  }
  async function save(next?: View) {
    setBusy(true);
    setActivity('save');
    setError('');
    setNotice('');
    try {
      const provider = await (editing === 'new'
        ? providerService.create(value)
        : providerService.update(editing!, value));
      accept(provider);
      setPendingView(null);
      setView(next ?? (editing === 'new' ? 'models' : 'connection'));
      setNotice(
        editing === 'new'
          ? 'Connection saved. Configure its models below.'
          : 'Connection changes saved.',
      );
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
      setActivity('');
    }
  }
  async function saveModels(input: ProviderModelsInput) {
    if (!saved) throw new Error('Save the connection before configuring models.');
    setBusy(true);
    setActivity('models');
    setNotice('');
    setError('');
    try {
      accept(await providerService.updateModels(saved.id, input));
      setNotice('Model settings saved.');
    } finally {
      setBusy(false);
      setActivity('');
    }
  }
  async function test(provider: ProviderSettings) {
    setBusy(true);
    setActivity('test');
    setNotice('');
    setError('');
    try {
      setNotice((await providerService.test(provider.id)).message);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
      setActivity('');
    }
  }
  async function remove() {
    if (!removeId) return;
    setBusy(true);
    setActivity('delete');
    setError('');
    setNotice('');
    try {
      await providerService.remove(removeId);
      setRemoveId(null);
      setEditing(null);
      setView('list');
      await refresh();
      onChanged();
      setNotice('Provider deleted.');
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
      setActivity('');
    }
  }
  async function connect() {
    setBusy(true);
    setActivity('auth');
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
      setActivity('');
    }
  }
  async function cancelSignIn() {
    if (!signIn) return;
    setBusy(true);
    try {
      await providerService.cancelChatGPT(signIn.id);
      pendingSignIn.current = undefined;
      setSignIn(null);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    if (!saved) return;
    setBusy(true);
    setActivity('auth');
    setError('');
    setNotice('');
    try {
      const result = await providerService.disconnectChatGPT(saved.id);
      const connections = await providerService.list();
      setProviders(connections);
      const updated = connections.find((provider) => provider.id === saved.id);
      if (updated) setValue({ ...updated, apiKey: '' });
      setNotice(result.message);
      onChanged();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
      setActivity('');
    }
  }
  function openUrl(url: string) {
    if (window.mukai)
      void window.mukai.openExternal(url).catch((error) => setError(errorText(error)));
    else window.open(url, '_blank', 'noopener,noreferrer');
  }
  function deleteConfirmation(id: string) {
    const provider = providers.find((provider) => provider.id === id);
    return (
      removeId === id && (
        <div className="delete-confirm" role="group" aria-label="Delete provider confirmation">
          <p>
            Delete {provider?.name} and its saved credentials?
            {provider?.isDefault
              ? ' Another saved provider will become the default, if available.'
              : ''}{' '}
            Bots assigned directly to this provider must be switched to another provider first.
          </p>
          <button
            type="button"
            className="button button--danger"
            disabled={busy}
            onClick={() => void remove()}
          >
            {activity === 'delete' ? 'Deleting…' : 'Delete provider'}
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => setRemoveId(null)}
          >
            Cancel
          </button>
        </div>
      )
    );
  }
  return (
    <div className="provider-panel" aria-busy={busy || loading}>
      {view !== 'list' && (
        <button
          type="button"
          className="text-button provider-back"
          disabled={busy || Boolean(signIn)}
          onClick={() => navigate('list')}
        >
          <ChevronLeft size={15} />
          All providers
        </button>
      )}
      <div className="settings-panel-heading provider-page-heading">
        <span className="settings-eyebrow">YOUR AI CONNECTIONS</span>
        <h3>
          {view === 'models'
            ? `${saved?.name ?? 'Provider'} models`
            : view === 'connection'
              ? saved
                ? saved.name
                : `Connect ${value.name}`
              : view === 'choose'
                ? 'Add a provider'
                : 'Providers'}
        </h3>
        <p>
          {view === 'models'
            ? 'Set model limits, capabilities, and the default your bots use.'
            : view === 'connection'
              ? 'Manage your connection and credentials.'
              : 'Connect ChatGPT or bring your own API key. Models and limits are ready for popular providers.'}
        </p>
        {view === 'list' && (
          <button
            className="button button--primary provider-heading-action"
            disabled={busy || loading}
            onClick={() => {
              setView('choose');
              setError('');
              setNotice('');
            }}
          >
            <Plus size={15} />
            Add provider
          </button>
        )}
        {view === 'models' && saved && (
          <button
            className="button provider-heading-action"
            disabled={busy}
            onClick={() => {
              setView('connection');
              setNotice('');
            }}
          >
            <Settings2 size={15} />
            Connection settings
          </button>
        )}
      </div>
      {error && (
        <div className="ai-alert" role="alert">
          {error}
          {loading === false && !providers.length && view === 'list' && (
            <button className="text-button" onClick={() => void refresh()}>
              Try again
            </button>
          )}
        </div>
      )}
      {notice && (
        <div className="ai-notice" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
      {pendingView && (
        <div className="provider-unsaved" role="group" aria-label="Unsaved connection changes">
          <p>Your connection has unsaved changes.</p>
          <div className="ai-form-actions">
            <button
              type="button"
              className="button button--primary"
              disabled={!canSave}
              onClick={() => void save(pendingView)}
            >
              Save and continue
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                if (saved) setValue({ ...saved, apiKey: '' });
                setView(pendingView);
                setPendingView(null);
                setError('');
                setNotice('');
              }}
            >
              Discard changes
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => setPendingView(null)}
            >
              Stay here
            </button>
          </div>
        </div>
      )}
      {view === 'models' && saved && (
        <ProviderModels key={saved.id} provider={saved} onSave={saveModels} disabled={busy} />
      )}
      {view === 'connection' && (
        <>
          <form
            className="ai-form provider-connection-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave) void save();
            }}
          >
            <div className="ai-form-grid">
              <label>
                Provider type
                <Dropdown
                  label="Provider type"
                  value={presetId}
                  disabled={busy || Boolean(signIn) || editing !== 'new'}
                  options={providerPresets.map((preset) => ({
                    value: preset.id,
                    label: preset.name,
                  }))}
                  onChange={(id) => choose(providerPresets.find((preset) => preset.id === id)!)}
                />
              </label>
              <label>
                Display name
                <input
                  required
                  maxLength={80}
                  value={value.name}
                  disabled={busy || Boolean(signIn)}
                  onChange={(event) => setValue({ ...value, name: event.target.value })}
                />
              </label>
            </div>
            {value.kind === 'compatible' && (
              <>
                {!!preset?.endpoints?.length && (
                  <label>
                    API endpoint
                    <Dropdown
                      label="API endpoint"
                      value={
                        preset.endpoints.some((endpoint) => endpoint.url === value.baseUrl)
                          ? value.baseUrl
                          : 'custom'
                      }
                      disabled={busy}
                      options={[
                        ...preset.endpoints.map((endpoint) => ({
                          value: endpoint.url,
                          label: endpoint.name,
                        })),
                        { value: 'custom', label: 'Custom endpoint' },
                      ]}
                      onChange={(url) =>
                        setValue({ ...value, baseUrl: url === 'custom' ? '' : url })
                      }
                    />
                  </label>
                )}
                <label>
                  Base URL
                  <input
                    required
                    type="url"
                    value={value.baseUrl}
                    disabled={busy}
                    placeholder="http://127.0.0.1:11434/v1"
                    spellCheck={false}
                    onChange={(event) => setValue({ ...value, baseUrl: event.target.value })}
                  />
                  <small>
                    {preset?.note ??
                      'Include the API prefix, usually /v1. Local HTTP and remote HTTPS endpoints are supported.'}
                  </small>
                </label>
              </>
            )}
            {preset?.docsUrl && (
              <button
                type="button"
                className="text-button provider-docs"
                onClick={() => openUrl(preset.docsUrl!)}
              >
                <ExternalLink size={14} />
                Provider documentation
              </button>
            )}
            {value.kind !== 'chatgpt' && (
              <label>
                API key {saved?.hasKey && <span className="key-saved">Key saved</span>}
                <input
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  maxLength={4096}
                  required={
                    (value.kind !== 'compatible' || Boolean(preset?.baseUrl)) && !saved?.hasKey
                  }
                  value={value.apiKey || ''}
                  disabled={busy}
                  placeholder={
                    saved?.hasKey
                      ? 'Leave blank to keep the saved key'
                      : value.kind === 'compatible' && !preset?.baseUrl
                        ? 'Optional for local models'
                        : 'Paste your provider API key'
                  }
                  onChange={(event) =>
                    setValue({ ...value, apiKey: event.target.value, clearKey: false })
                  }
                />
                <small>Encrypted on this device’s server. Saved keys are never shown.</small>
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
                        onClick={() => openUrl(signIn.url!)}
                      >
                        Open sign-in again
                      </button>
                    )}
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => void cancelSignIn()}
                    >
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
                <Checkbox
                  disabled={busy}
                  checked={Boolean(value.clearKey)}
                  onChange={(event) =>
                    setValue({ ...value, clearKey: event.target.checked, apiKey: '' })
                  }
                />
                Remove the saved key (only for endpoints without authentication)
              </label>
            )}
            <label className="ai-checkbox">
              <Checkbox
                disabled={busy || Boolean(signIn) || Boolean(saved?.isDefault)}
                checked={value.isDefault}
                onChange={(event) => setValue({ ...value, isDefault: event.target.checked })}
              />
              Use as the default provider
            </label>
            {!saved && value.kind !== 'chatgpt' && (
              <p className="ai-caption">
                {value.models?.length
                  ? `${value.models.length} models included with researched limits. You can customize them after saving.`
                  : 'Save the connection, then add the models you want to use.'}
              </p>
            )}
            {(saved || value.kind !== 'chatgpt') && (
              <div className="ai-form-actions provider-connection-actions">
                <button type="submit" className="button button--primary" disabled={!canSave}>
                  {activity === 'save' ? 'Saving…' : saved ? 'Save changes' : 'Save connection'}
                </button>
                {saved && (
                  <button
                    type="button"
                    className="button"
                    disabled={busy || Boolean(signIn)}
                    onClick={() => navigate('models')}
                  >
                    Configure models
                    <ChevronRight size={14} />
                  </button>
                )}
              </div>
            )}
          </form>
          {saved && (
            <div className="provider-connection-tools">
              <div className="provider-section-heading">
                <div>
                  <h4>Connection check</h4>
                  <p className="ai-caption">
                    Sends a short request using your saved model and your provider’s usage
                    allowance.
                  </p>
                </div>
                <button
                  type="button"
                  className="button"
                  disabled={
                    busy ||
                    Boolean(signIn) ||
                    connectionDirty ||
                    !saved.defaultModel ||
                    (saved.kind === 'chatgpt' && !saved.account?.planEnabled)
                  }
                  title={connectionDirty ? 'Save connection changes before testing' : undefined}
                  onClick={() => void test(saved)}
                >
                  <Radio size={14} />
                  {activity === 'test' ? 'Testing…' : 'Test connection'}
                </button>
              </div>
              <div className="provider-section-heading provider-danger-zone">
                <div>
                  <h4>Delete connection</h4>
                  <p className="ai-caption">Remove this provider and its saved credentials.</p>
                </div>
                <button
                  type="button"
                  className="button danger-text"
                  disabled={busy || Boolean(signIn)}
                  onClick={() => setRemoveId(saved.id)}
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              </div>
              {deleteConfirmation(saved.id)}
            </div>
          )}
        </>
      )}
      {(view === 'choose' || (view === 'list' && !loading && !providers.length && !error)) && (
        <div className="provider-catalog" aria-label="Provider presets">
          <div className="provider-section-heading">
            <div>
              <h4>Choose a provider</h4>
              <p className="ai-caption">
                Popular endpoints and model limits are filled in for you. Add your key to connect.
              </p>
            </div>
          </div>
          <div className="provider-preset-grid">
            {providerPresets.map((preset) => (
              <button
                key={preset.id}
                className="provider-preset"
                onClick={() => choose(preset)}
                aria-label={`Add ${preset.name}`}
              >
                <span className="provider-preset-heading">
                  <KeyRound size={16} />
                  <strong>{preset.name}</strong>
                  <ChevronRight size={15} />
                </span>
                <span>{preset.description}</span>
                <small>
                  {preset.models.length
                    ? `${preset.models.length} models included`
                    : preset.kind === 'chatgpt'
                      ? 'Account sign-in'
                      : preset.kind === 'compatible'
                        ? 'Custom configuration'
                        : 'API key connection'}
                </small>
              </button>
            ))}
          </div>
        </div>
      )}
      {view === 'list' &&
        (loading ? (
          <p className="ai-caption" role="status">
            Loading providers…
          </p>
        ) : (
          !!providers.length && (
            <div className="provider-list">
              {providers.map((provider) => (
                <div className="provider-card" key={provider.id}>
                  <div className="provider-card-heading">
                    <span className="provider-symbol">
                      <KeyRound size={18} />
                    </span>
                    <div className="provider-card-name">
                      <strong>{provider.name}</strong>
                      <small>
                        {provider.models?.length || (provider.defaultModel ? 1 : 0)} models ·{' '}
                        {provider.models?.find((model) => model.id === provider.defaultModel)
                          ?.name ||
                          provider.defaultModel ||
                          'No default model'}
                      </small>
                    </div>
                    {provider.isDefault && <span className="provider-default">Default</span>}
                  </div>
                  <p>
                    {provider.kind === 'chatgpt'
                      ? provider.account?.connected
                        ? provider.account.planEnabled
                          ? `Connected · ${provider.account.label}`
                          : 'Plan usage disabled'
                        : 'Disconnected'
                      : provider.hasKey
                        ? 'API key saved'
                        : 'No API key'}{' '}
                    · {provider.supportsImages ? 'Text & images' : 'Text only'}
                  </p>
                  <div className="ai-form-actions">
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => edit(provider, 'models')}
                    >
                      Configure models
                      <ChevronRight size={14} />
                    </button>
                    <button className="text-button" disabled={busy} onClick={() => edit(provider)}>
                      Connection settings
                    </button>
                    <button
                      className="text-button danger-text provider-delete"
                      disabled={busy}
                      aria-label={`Delete ${provider.name}`}
                      onClick={() => {
                        setRemoveId(provider.id);
                        setError('');
                      }}
                    >
                      <Trash2 size={14} />
                      Delete
                    </button>
                  </div>
                  {deleteConfirmation(provider.id)}
                </div>
              ))}
            </div>
          )
        ))}
      {view === 'list' && (
        <p className="ai-caption provider-privacy">
          Your credentials stay on this computer. Chat context and supported attachments are sent
          directly to your chosen provider.
        </p>
      )}
    </div>
  );
}
