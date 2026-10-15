import { ConfirmationModal } from '../../components/ui/ConfirmationModal';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import type { TelegramAccessInput, TelegramStatus } from '../../../../shared/telegram';
import { telegramService } from '../../services/telegramService';
import { errorText } from '../../utils/errors';
import { TelegramWorkspaceAccess } from './TelegramWorkspaceAccess';
import { TelegramConnectionForm } from './TelegramConnectionForm';
import { TelegramPairing } from './TelegramPairing';
import { TelegramConnected } from './TelegramConnected';
import { TelegramHero } from './TelegramHero';

type Confirmation = 'disconnect' | 'revoke' | null;
const accessFrom = (status: TelegramStatus) =>
  status.workspaces
    .filter((item) => item.enabled)
    .map((item) => ({ workspaceId: item.id, botId: item.botId }));

export function TelegramPage() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [selection, setSelection] = useState<TelegramAccessInput['workspaces']>([]);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const mounted = useRef(true);
  const mutating = useRef(false);
  const generation = useRef(0);
  const initialized = useRef(false);

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

  async function act(name: string, action: () => Promise<TelegramStatus>) {
    if (mutating.current) return;
    mutating.current = true;
    generation.current++;
    setBusy(name);
    setError('');
    try {
      const next = await action();
      if (!mounted.current) return;
      setStatus(next);
      if (name !== 'state') setSelection(accessFrom(next));
      setConfirmation(null);
    } catch (caught) {
      if (mounted.current) setError(errorText(caught));
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy('');
    }
  }

  const ready = Boolean(status?.owner && status.workspaces.some((item) => item.enabled));
  const pending = Boolean(busy);
  const botUrl =
    status?.bot?.username && /^[A-Za-z0-9_]+$/.test(status.bot.username)
      ? 'https://t.me/' + status.bot.username
      : null;
  const stage = !status?.configured
    ? 'connect'
    : !status.owner
      ? 'pair'
      : !ready
        ? 'workspaces'
        : 'connected';
  const runtimeLabel = !status?.enabled
    ? 'Paused'
    : status.runtime.state === 'polling'
      ? 'Connected'
      : status.runtime.state === 'error'
        ? 'Needs attention'
        : 'Connecting';

  return (
    <main className="conversation telegram-page" aria-label="Telegram">
      <div className={'telegram-content telegram-content--' + stage}>
        {(error || loadError) && (
          <div className="telegram-alert" role="alert">
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
        {!status ? (
          <div className="telegram-loading" role="status">
            <Loader2 className="telegram-spin" size={22} />
            <span>Loading Telegram…</span>
          </div>
        ) : (
          <>
            {!status.configured ? (
              <TelegramConnectionForm
                pending={pending}
                connecting={busy === 'connect'}
                onError={setError}
                onConnect={(token) => void act('connect', () => telegramService.connect(token))}
              />
            ) : !status.owner ? (
              <TelegramPairing
                status={status}
                pending={pending}
                busy={busy}
                onPair={() => void act('pair', telegramService.pair)}
                onApprove={(userId) => void act('approve', () => telegramService.approve(userId))}
                onResume={() => void act('resume', () => telegramService.state(true))}
                onError={setError}
              />
            ) : !ready ? (
              <section className="telegram-access-card telegram-stage">
                <TelegramHero title="Choose your workspaces">
                  Pick what you’d like to use in Telegram.
                </TelegramHero>
                <TelegramWorkspaceAccess
                  workspaces={status.workspaces}
                  selection={selection}
                  onChange={setSelection}
                  disabled={pending}
                />
                <p className="telegram-note telegram-access-note">
                  Your bots keep their usual tools and approval settings.
                </p>
                <button
                  className="button button--primary telegram-primary"
                  disabled={pending || (!ready && !selection.length)}
                  onClick={() =>
                    void act('access', () => telegramService.access({ workspaces: selection }))
                  }
                >
                  {busy === 'access' && <Loader2 size={17} className="telegram-spin" />}
                  {busy === 'access' ? 'Saving…' : 'Finish setup'}
                </button>
              </section>
            ) : (
              <TelegramConnected
                status={status}
                botUrl={botUrl}
                pending={pending}
                onError={setError}
                onToggle={() => void act('state', () => telegramService.state(!status.enabled))}
                onAccess={(workspaces) =>
                  void act('access', () => telegramService.access({ workspaces }))
                }
              />
            )}
            {status.configured && (
              <footer className="telegram-footer">
                {status.runtime.error && (
                  <div className="telegram-alert" role="alert">
                    {status.runtime.error}
                  </div>
                )}
                {status.queue.uncertain > 0 && (
                  <div className="telegram-alert" role="status">
                    Some replies have uncertain delivery. Check Telegram before sending the same
                    request again.
                  </div>
                )}
                <p className="telegram-note">
                  Private to your account. Mukai needs to stay running.
                  {status.queue.pending > 0
                    ? ' ' + status.queue.pending + ' messages pending.'
                    : ''}
                </p>
                <details className="telegram-settings">
                  <summary>
                    Connection settings <ChevronDown size={13} />
                  </summary>
                  <div className="telegram-settings-status">
                    <span
                      className={
                        status.enabled && status.runtime.state === 'polling'
                          ? 'telegram-dot'
                          : 'telegram-dot is-paused'
                      }
                    />
                    {runtimeLabel}
                    <span>@{status.bot?.username}</span>
                    <button
                      className="text-button telegram-refresh"
                      disabled={pending}
                      onClick={() => void refresh()}
                    >
                      Refresh
                    </button>
                  </div>
                  {status.owner && (
                    <p className="telegram-settings-account">
                      {status.owner.firstName} · Telegram ID {status.owner.id}
                    </p>
                  )}
                  <div className="telegram-settings-actions">
                    {status.owner && (
                      <button
                        className="text-button"
                        disabled={pending}
                        onClick={() => {
                          setError('');
                          setConfirmation('revoke');
                        }}
                      >
                        Revoke paired account
                      </button>
                    )}
                    <button
                      className="text-button"
                      disabled={pending}
                      onClick={() => {
                        setError('');
                        setConfirmation('disconnect');
                      }}
                    >
                      Disconnect bot
                    </button>
                  </div>
                </details>
                {confirmation && (
                  <ConfirmationModal
                    title={
                      confirmation === 'disconnect'
                        ? 'Disconnect this bot?'
                        : 'Revoke this account’s access?'
                    }
                    confirmLabel={
                      confirmation === 'disconnect' ? 'Disconnect bot' : 'Revoke access'
                    }
                    busy={pending}
                    error={error}
                    onClose={() => {
                      setConfirmation(null);
                      setError('');
                    }}
                    onConfirm={() =>
                      void act(
                        confirmation,
                        confirmation === 'disconnect'
                          ? telegramService.disconnect
                          : telegramService.revoke,
                      )
                    }
                  >
                    <p>
                      {confirmation === 'disconnect'
                        ? 'The saved token and paired account will be removed. Your Mukai conversations stay available.'
                        : 'This account will lose access immediately. You can pair an account again anytime.'}
                    </p>
                  </ConfirmationModal>
                )}
              </footer>
            )}
          </>
        )}
      </div>
    </main>
  );
}
