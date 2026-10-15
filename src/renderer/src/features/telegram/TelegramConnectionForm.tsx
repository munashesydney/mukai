import { useState } from 'react';
import { ChevronDown, ExternalLink, KeyRound, Loader2 } from 'lucide-react';
import { ExternalAnchor } from '../../components/ui/ExternalAnchor';
import { TelegramHero } from './TelegramHero';

export function TelegramConnectionForm({
  pending,
  connecting,
  onConnect,
  onError,
}: {
  pending: boolean;
  connecting: boolean;
  onConnect: (token: string) => void;
  onError: (message: string) => void;
}) {
  const [token, setToken] = useState('');
  return (
    <section className="telegram-connect telegram-stage">
      <TelegramHero title="Connect Telegram">
        Link your Telegram account to use your bots in Mukai.
      </TelegramHero>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = token.trim();
          if (!value || pending) return;
          setToken('');
          onConnect(value);
        }}
      >
        <label className="visually-hidden" htmlFor="telegram-token">
          Bot token
        </label>
        <div className="telegram-token-field">
          <KeyRound size={19} aria-hidden="true" />
          <input
            id="telegram-token"
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            placeholder="Paste bot token from @BotFather"
            aria-describedby="telegram-token-help"
            required
            disabled={pending}
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
        <span id="telegram-token-help" className="visually-hidden">
          Your token is stored encrypted and is never shown again.
        </span>
        <button
          type="submit"
          className="button button--primary telegram-primary"
          disabled={pending || !token.trim()}
        >
          {connecting && <Loader2 size={17} className="telegram-spin" />}
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
      </form>
      <details className="telegram-help telegram-guide">
        <summary>
          How to get a bot token? <ChevronDown size={14} />
        </summary>
        <ol>
          <li>
            Open{' '}
            <ExternalAnchor href="https://t.me/BotFather" onError={onError}>
              @BotFather <ExternalLink size={12} />
            </ExternalAnchor>{' '}
            in Telegram.
          </li>
          <li>
            Send <code>/newbot</code> and follow the prompts.
          </li>
          <li>Paste the token here. That’s it.</li>
        </ol>
      </details>
    </section>
  );
}
