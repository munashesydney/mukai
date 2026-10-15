import { useState } from 'react';
import { Copy, ExternalLink, Loader2, ShieldCheck, UserRound } from 'lucide-react';
import type { TelegramStatus } from '../../../../shared/telegram';
import { ExternalAnchor } from '../../components/ui/ExternalAnchor';
import { copyText } from '../../services/clipboardService';
import { TelegramLogo } from '../../components/ui/TelegramLogo';

export function TelegramPairing({
  status,
  pending,
  busy,
  onPair,
  onApprove,
  onResume,
  onError,
}: {
  status: TelegramStatus;
  pending: boolean;
  busy: string;
  onPair: () => void;
  onApprove: (userId: number) => void;
  onResume: () => void;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const pairing = status.pairing;
  const expired = Boolean(pairing && Date.parse(pairing.expiresAt) <= Date.now());
  const pairingUrl =
    pairing?.url && /^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=[A-Za-z0-9_-]+$/.test(pairing.url)
      ? pairing.url
      : null;
  const needsPairingLink =
    !pairing || expired || (!pairing.candidate && !pairingUrl && !pairing.code);
  return (
    <section className="telegram-card telegram-pair-card">
      <span className="telegram-feature-icon">
        <ShieldCheck size={23} strokeWidth={1.6} />
      </span>
      <h2>Make it your private line</h2>
      <p>
        Your bot is <strong>@{status.bot?.username}</strong>. Pair your own Telegram account, then
        approve it here in Mukai.
      </p>
      {needsPairingLink ? (
        <>
          <div className="telegram-callout">
            <UserRound size={18} />
            <p>
              {expired
                ? 'This pairing link has expired. Create a fresh one to continue.'
                : pairing
                  ? 'Create a fresh pairing link to continue after restarting Mukai.'
                  : 'Create a one-time link, open it in Telegram, and tap Start. No workspace access is granted until you approve the account here.'}
            </p>
          </div>
          <button
            className="button button--primary"
            disabled={pending || !status.enabled}
            onClick={onPair}
          >
            {busy === 'pair' ? (
              <Loader2 size={15} className="telegram-spin" />
            ) : (
              <TelegramLogo size={15} />
            )}
            {pairing ? 'Create a new pairing link' : 'Create pairing link'}
          </button>
          {!status.enabled && (
            <button className="text-button" disabled={pending} onClick={onResume}>
              Resume connection to pair
            </button>
          )}
        </>
      ) : pairing.candidate ? (
        <div className="telegram-candidate" aria-live="polite">
          <span className="telegram-avatar">
            <UserRound size={23} />
          </span>
          <div>
            <h3>Is this you?</h3>
            <strong>{pairing.candidate.firstName}</strong>
            <p>
              {pairing.candidate.username ? `@${pairing.candidate.username} · ` : ''}
              Telegram ID <code>{pairing.candidate.id}</code>
            </p>
            <small>Approve only if this is the account you just used in Telegram.</small>
          </div>
          <div className="telegram-actions">
            <button
              className="button button--primary"
              disabled={pending}
              onClick={() => onApprove(pairing.candidate!.id)}
            >
              <ShieldCheck size={15} />
              {busy === 'approve' ? 'Approving…' : 'Yes, pair my account'}
            </button>
            <button className="button button--ghost" disabled={pending} onClick={onPair}>
              That’s not me · reset link
            </button>
          </div>
        </div>
      ) : (
        <div className="telegram-pairing">
          <div className="telegram-actions">
            {pairingUrl && (
              <ExternalAnchor
                className="button button--primary"
                href={pairingUrl}
                onError={onError}
              >
                Open in Telegram
                <ExternalLink size={14} />
              </ExternalAnchor>
            )}
            {pairingUrl && (
              <button
                className="button button--secondary"
                onClick={() => {
                  void copyText(pairingUrl)
                    .then(() => setCopied(true))
                    .catch(() =>
                      onError('Could not copy the link. Open it in Telegram using the button.'),
                    );
                }}
              >
                <Copy size={14} />
                {copied ? 'Copied' : 'Copy link'}
              </button>
            )}
          </div>
          {pairing.code && (
            <p className="telegram-code-help">
              Or send <code>/start {pairing.code}</code> to @{status.bot?.username}.
            </p>
          )}
          <div className="telegram-waiting" role="status">
            <Loader2 size={15} className="telegram-spin" />
            <span>Waiting for you to tap Start in Telegram…</span>
          </div>
          <small>
            Link expires at{' '}
            {new Date(pairing.expiresAt).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
            })}
            . Keep it private.
          </small>
          <button
            className="text-button"
            disabled={pending}
            onClick={() => {
              setCopied(false);
              onPair();
            }}
          >
            Create a fresh link
          </button>
        </div>
      )}
    </section>
  );
}
