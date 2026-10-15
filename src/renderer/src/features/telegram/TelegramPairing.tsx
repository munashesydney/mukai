import { useState } from 'react';
import { Copy, ExternalLink, Loader2, UserRound } from 'lucide-react';
import type { TelegramStatus } from '../../../../shared/telegram';
import { ExternalAnchor } from '../../components/ui/ExternalAnchor';
import { copyText } from '../../services/clipboardService';
import { TelegramHero } from './TelegramHero';

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
  const [copiedLink, setCopiedLink] = useState('');
  const [copiedCommand, setCopiedCommand] = useState('');
  const pairing = status.pairing;
  const expired = Boolean(pairing && Date.parse(pairing.expiresAt) <= Date.now());
  const pairingUrl =
    pairing?.url && /^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=[A-Za-z0-9_-]+$/.test(pairing.url)
      ? pairing.url
      : null;
  const needsLink = !pairing || expired || (!pairing.candidate && !pairingUrl && !pairing.code);
  return (
    <section className="telegram-pair-card telegram-stage">
      <TelegramHero title={pairing?.candidate && !expired ? 'Is this you?' : 'Pair your account'}>
        {pairing?.candidate && !expired ? (
          'Confirm the account you just opened in Telegram.'
        ) : (
          <>Open @{status.bot?.username} in Telegram. We’ll meet you back here.</>
        )}
      </TelegramHero>
      {needsLink ? (
        <div className="telegram-pair-start">
          {pairing && (
            <p className="telegram-note">
              {expired
                ? 'Your link expired. Let’s make a fresh one.'
                : 'Create a fresh pairing link to continue after restarting Mukai.'}
            </p>
          )}
          <button
            className="button button--primary telegram-primary"
            disabled={pending || !status.enabled}
            onClick={onPair}
          >
            {busy === 'pair' && <Loader2 size={17} className="telegram-spin" />}
            {busy === 'pair'
              ? 'Creating link…'
              : pairing
                ? 'Create a new pairing link'
                : 'Create pairing link'}
          </button>
          {!status.enabled && (
            <button className="text-button" disabled={pending} onClick={onResume}>
              Resume connection to pair
            </button>
          )}
          <p className="telegram-note">Only the account you approve here can connect.</p>
        </div>
      ) : pairing.candidate ? (
        <div className="telegram-candidate" aria-live="polite">
          <div className="telegram-account">
            <span className="telegram-avatar">
              <UserRound size={23} />
            </span>
            <div>
              <strong>{pairing.candidate.firstName}</strong>
              <span>
                {pairing.candidate.username ? '@' + pairing.candidate.username + ' · ' : ''}ID{' '}
                {pairing.candidate.id}
              </span>
            </div>
          </div>
          <button
            className="button button--primary telegram-primary"
            disabled={pending}
            onClick={() => onApprove(pairing.candidate!.id)}
          >
            {busy === 'approve' && <Loader2 size={17} className="telegram-spin" />}
            {busy === 'approve' ? 'Pairing…' : 'Yes, pair my account'}
          </button>
          <button className="text-button" disabled={pending} onClick={onPair}>
            That’s not me · reset link
          </button>
        </div>
      ) : (
        <div className="telegram-pairing">
          {pairingUrl && (
            <>
              <ExternalAnchor
                className="button button--primary telegram-primary"
                href={pairingUrl}
                onError={onError}
              >
                Open in Telegram <ExternalLink size={16} />
              </ExternalAnchor>
              <button
                className="text-button telegram-copy"
                onClick={() => {
                  void copyText(pairingUrl)
                    .then(() => setCopiedLink(pairingUrl))
                    .catch(() =>
                      onError('Could not copy the link. Open it in Telegram using the button.'),
                    );
                }}
              >
                <Copy size={14} /> {copiedLink === pairingUrl ? 'Copied' : 'Copy link'}
              </button>
            </>
          )}
          <div className="telegram-waiting" role="status">
            <span className="telegram-dot" />
            Waiting for you to tap Start in Telegram…
          </div>
          {pairing.code && (
            <div className="telegram-manual">
              <div className="telegram-or">
                <span>or</span>
              </div>
              <p>Send this to @{status.bot?.username}</p>
              <div className="telegram-command">
                <code>/start {pairing.code}</code>
                <button
                  className="text-button"
                  aria-label={
                    copiedCommand === pairing.code ? 'Command copied' : 'Copy pairing command'
                  }
                  onClick={() => {
                    void copyText('/start ' + pairing.code)
                      .then(() => setCopiedCommand(pairing.code!))
                      .catch(() =>
                        onError('Could not copy the command. Select and copy it manually.'),
                      );
                  }}
                >
                  <Copy size={15} />
                  {copiedCommand === pairing.code && <span>Copied</span>}
                </button>
              </div>
            </div>
          )}
          <div className="telegram-link-meta">
            <span>
              Expires at{' '}
              {new Date(pairing.expiresAt).toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
            <button className="text-button" disabled={pending} onClick={onPair}>
              Create a fresh link
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
