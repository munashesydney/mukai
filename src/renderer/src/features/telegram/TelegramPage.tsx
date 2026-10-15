import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCheck,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Unplug,
  UserRound,
  X,
} from 'lucide-react';
import type { TelegramAccessInput, TelegramStatus } from '../../../../shared/telegram';
import { telegramService } from '../../services/telegramService';
import { errorText } from '../../utils/errors';
import { TelegramWorkspaceAccess } from './TelegramWorkspaceAccess';
import { TelegramConnectionForm } from './TelegramConnectionForm';
import { TelegramPairing } from './TelegramPairing';
import { ExternalAnchor } from '../../components/ui/ExternalAnchor';
import { TelegramLogo } from '../../components/ui/TelegramLogo';

type Confirmation = 'disconnect' | 'revoke' | null;
const accessFrom = (status: TelegramStatus) =>
  status.workspaces
    .filter((item) => item.enabled)
    .map((item) => ({ workspaceId: item.id, botId: item.botId }));

export function TelegramPage() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [selection, setSelection] = useState<TelegramAccessInput['workspaces']>([]);
  const [editingAccess, setEditingAccess] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const mounted = useRef(true);
  const mutating = useRef(false);
  const generation = useRef(0);
  const initialized = useRef(false);
  const confirmationPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (confirmation) confirmationPanel.current?.focus();
  }, [confirmation]);

  const refresh = useCallback(async () => {
    if (mutating.current) return;
    const current = generation.current;
    try {
      const next = await telegramService.status();
      if (!mounted.current || current !== generation.current || mutating.current) return;
      setStatus(next);
      if (!initialized.current) {
        setSelection(accessFrom(next));
        initialized.current = true;
      }
      setLoadError('');
    } catch (caught) {
      if (mounted.current && current === generation.current) setLoadError(errorText(caught));
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    generation.current++;
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 3000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  async function act(name: string, action: () => Promise<TelegramStatus>, success?: string) {
    if (mutating.current) return;
    mutating.current = true;
    generation.current++;
    setBusy(name);
    setError('');
    setNotice('');
    try {
      const next = await action();
      if (!mounted.current) return;
      setStatus(next);
      if (!editingAccess || name === 'access') setSelection(accessFrom(next));
      setConfirmation(null);
      if (name === 'access') setEditingAccess(false);
      if (success) setNotice(success);
    } catch (caught) {
      if (mounted.current) setError(errorText(caught));
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy('');
    }
  }

  const step = !status?.configured ? 0 : !status.owner ? 1 : 2;
  const ready = Boolean(status?.owner && status.workspaces.some((item) => item.enabled));
  const settingUp = !ready;
  const pending = Boolean(busy);
  const botUrl =
    status?.bot?.username && /^[A-Za-z0-9_]+$/.test(status.bot.username)
      ? `https://t.me/${status.bot.username}`
      : null;
  const runtimeLabel = !status?.configured
    ? 'Not connected'
    : !status.enabled
      ? 'Paused'
      : status.runtime.state === 'polling'
        ? 'Connected'
        : status.runtime.state === 'error'
          ? 'Needs attention'
          : 'Connecting';

  return (
    <main className="conversation telegram-page" aria-label="Telegram">
      <header className="telegram-heading">
        <div>
          <span className="settings-eyebrow">YOUR BOTS, WITH YOU</span>
          <h1>
            Telegram{' '}
            <span
              className={`telegram-status ${status?.enabled && status.runtime.state === 'polling' ? 'is-online' : ''}`}
            >
              <i />
              {runtimeLabel}
            </span>
          </h1>
          <p>A direct line to your Mukai workspaces, wherever you are.</p>
        </div>
        {status?.configured && (
          <button
            className="button button--ghost"
            disabled={pending}
            onClick={() => void refresh()}
            aria-label="Refresh Telegram status"
          >
            <RefreshCw size={15} />
          </button>
        )}
      </header>
      <div className="telegram-content">
        {(error || loadError) && (
          <div className="ai-alert telegram-alert" role="alert">
            <span>{error || loadError}</span>
            <button
              className="text-button"
              onClick={() => {
                setError('');
                void refresh();
              }}
            >
              Retry
            </button>
          </div>
        )}
        {notice && (
          <div className="telegram-notice" role="status">
            <CheckCheck size={16} />
            {notice}
            <button aria-label="Dismiss message" onClick={() => setNotice('')}>
              <X size={14} />
            </button>
          </div>
        )}
        {!status ? (
          <div className="telegram-loading" role="status">
            <Loader2 className="telegram-spin" size={21} />
            Loading Telegram…
          </div>
        ) : (
          <>
            {settingUp && (
              <ol className="telegram-steps" aria-label="Telegram setup progress">
                {['Connect your bot', 'Pair your account', 'Choose workspaces'].map(
                  (label, index) => (
                    <li
                      key={label}
                      className={index === step ? 'is-current' : index < step ? 'is-complete' : ''}
                      aria-current={index === step ? 'step' : undefined}
                    >
                      <span>{index < step ? <Check size={14} /> : index + 1}</span>
                      <strong>{label}</strong>
                    </li>
                  ),
                )}
              </ol>
            )}
            {!status.configured ? (
              <TelegramConnectionForm
                onError={setError}
                pending={pending}
                connecting={busy === 'connect'}
                onConnect={(token) =>
                  void act(
                    'connect',
                    () => telegramService.connect(token),
                    'Bot connected. Next, pair your Telegram account.',
                  )
                }
              />
            ) : !status.owner ? (
              <TelegramPairing
                status={status}
                pending={pending}
                busy={busy}
                onPair={() => void act('pair', telegramService.pair)}
                onApprove={(userId) =>
                  void act(
                    'approve',
                    () => telegramService.approve(userId),
                    'Your Telegram account is paired. Choose which workspaces it can access.',
                  )
                }
                onResume={() => void act('resume', () => telegramService.state(true))}
                onError={setError}
              />
            ) : (
              <>
                {ready && (
                  <section className="telegram-card telegram-overview">
                    <span className="telegram-feature-icon">
                      <TelegramLogo size={22} />
                    </span>
                    <div>
                      <h2>
                        {status.enabled
                          ? 'Your bots are a message away'
                          : 'Your Telegram connection is paused'}
                      </h2>
                      <p>
                        {status.enabled
                          ? 'Open your bot and send /workspaces to start a conversation.'
                          : 'Resume when you’re ready to chat from Telegram.'}
                      </p>
                      <div className="telegram-identity">
                        <UserRound size={14} />
                        <span>
                          {status.owner.firstName}
                          {status.owner.username ? ` · @${status.owner.username}` : ''}
                        </span>
                        <span className="telegram-identity-id">ID {status.owner.id}</span>
                      </div>
                    </div>
                    <div className="telegram-actions">
                      {botUrl && (
                        <ExternalAnchor
                          className="button button--primary"
                          href={botUrl}
                          onError={setError}
                        >
                          Open @{status.bot?.username}
                          <ExternalLink size={14} />
                        </ExternalAnchor>
                      )}
                      <button
                        className="button button--secondary"
                        disabled={pending}
                        onClick={() =>
                          void act(
                            'state',
                            () => telegramService.state(!status.enabled),
                            status.enabled
                              ? 'Telegram connection paused.'
                              : 'Telegram connection resumed.',
                          )
                        }
                      >
                        {status.enabled ? <Pause size={14} /> : <Play size={14} />}
                        {status.enabled ? 'Pause' : 'Resume'}
                      </button>
                    </div>
                  </section>
                )}
                <section className="telegram-card telegram-access-card">
                  <div className="telegram-section-heading">
                    <div>
                      <h2>{ready ? 'Workspace access' : 'Choose what comes with you'}</h2>
                      <p>
                        Only enabled workspaces appear in <code>/workspaces</code>. Each gets its
                        own private conversation.
                      </p>
                      <p>
                        Bots can use their existing workspace tools. Mukai’s approval settings still
                        apply.
                      </p>
                    </div>
                    {ready && !editingAccess && (
                      <button
                        className="button button--secondary"
                        disabled={pending}
                        onClick={() => {
                          setSelection(accessFrom(status));
                          setEditingAccess(true);
                        }}
                      >
                        Edit access
                      </button>
                    )}
                  </div>
                  {!ready || editingAccess ? (
                    <>
                      <TelegramWorkspaceAccess
                        workspaces={status.workspaces}
                        selection={selection}
                        onChange={setSelection}
                        disabled={pending}
                      />
                      <div className="telegram-actions telegram-access-actions">
                        <button
                          className="button button--primary"
                          disabled={pending || (!ready && !selection.length)}
                          onClick={() =>
                            void act(
                              'access',
                              () => telegramService.access({ workspaces: selection }),
                              'Workspace access saved. Send /workspaces in Telegram to choose a workspace.',
                            )
                          }
                        >
                          <Check size={15} />
                          {busy === 'access' ? 'Saving…' : ready ? 'Save access' : 'Finish setup'}
                        </button>
                        {ready && (
                          <button
                            className="button button--ghost"
                            disabled={pending}
                            onClick={() => setEditingAccess(false)}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="telegram-access-summary">
                      {status.workspaces
                        .filter((item) => item.enabled)
                        .map((item) => (
                          <div key={item.id}>
                            <span className="telegram-workspace-initial">
                              {item.name[0]?.toUpperCase()}
                            </span>
                            <strong>{item.name}</strong>
                            <span>
                              {item.botId
                                ? item.bots.find((bot) => bot.id === item.botId)?.name ||
                                  'Bot unavailable'
                                : 'Main bot'}
                            </span>
                            <Check size={15} />
                          </div>
                        ))}
                    </div>
                  )}
                </section>
                {ready && (
                  <section className="telegram-usage">
                    <div>
                      <code>/workspaces</code>
                      <span>Choose or switch workspace</span>
                    </div>
                    <div>
                      <code>/new</code>
                      <span>Start a fresh conversation</span>
                    </div>
                    <div>
                      <code>/stop</code>
                      <span>Stop the current reply</span>
                    </div>
                  </section>
                )}
              </>
            )}
            {status.configured && (
              <>
                {status.runtime.error && (
                  <div className="ai-alert" role="alert">
                    {status.runtime.error}
                  </div>
                )}
                {status.queue.uncertain > 0 && (
                  <div className="telegram-callout">
                    <Send size={17} />
                    <p>
                      {status.queue.uncertain}{' '}
                      {status.queue.uncertain === 1 ? 'reply has' : 'replies have'} uncertain
                      delivery. Check your Telegram chat before sending the same request again.
                    </p>
                  </div>
                )}
                <div className="telegram-footer">
                  <p>
                    <ShieldCheck size={14} />
                    Private chats only. Mukai must be running and your computer awake.
                    {status.queue.pending > 0
                      ? ` ${status.queue.pending} message${status.queue.pending === 1 ? '' : 's'} pending.`
                      : ''}
                  </p>
                  <div>
                    {status.owner && (
                      <button
                        className="text-button"
                        disabled={pending}
                        onClick={() => setConfirmation('revoke')}
                      >
                        Revoke paired account
                      </button>
                    )}
                    <button
                      className="text-button"
                      disabled={pending}
                      onClick={() => setConfirmation('disconnect')}
                    >
                      <Unplug size={13} />
                      Disconnect bot
                    </button>
                  </div>
                </div>
                {confirmation && (
                  <section
                    className="telegram-confirm"
                    ref={confirmationPanel}
                    tabIndex={-1}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setConfirmation(null);
                    }}
                    role="alertdialog"
                    aria-modal="false"
                    aria-labelledby="telegram-confirm-title"
                  >
                    <h3 id="telegram-confirm-title">
                      {confirmation === 'disconnect'
                        ? 'Disconnect this bot?'
                        : 'Revoke this account’s access?'}
                    </h3>
                    <p>
                      {confirmation === 'disconnect'
                        ? 'This stops Telegram, removes the saved token, and revokes the paired account. Your Mukai conversations stay available.'
                        : 'The paired Telegram account will lose access immediately. Pair an account again to resume.'}
                    </p>
                    <div className="telegram-actions">
                      <button
                        className="button button--secondary"
                        disabled={pending}
                        onClick={() => setConfirmation(null)}
                      >
                        Keep connection
                      </button>
                      <button
                        className="button telegram-danger"
                        disabled={pending}
                        onClick={() =>
                          void act(
                            confirmation,
                            confirmation === 'disconnect'
                              ? telegramService.disconnect
                              : telegramService.revoke,
                            confirmation === 'disconnect'
                              ? 'Telegram bot disconnected.'
                              : 'Paired account access revoked.',
                          )
                        }
                      >
                        {pending
                          ? 'Updating…'
                          : confirmation === 'disconnect'
                            ? 'Disconnect bot'
                            : 'Revoke access'}
                      </button>
                    </div>
                  </section>
                )}
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
