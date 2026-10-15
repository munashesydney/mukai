import { useState } from 'react';
import { ArrowRight, ExternalLink, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { ExternalAnchor } from '../../components/ui/ExternalAnchor';
import { TelegramLogo } from '../../components/ui/TelegramLogo';

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
    <div className="telegram-setup-grid">
      <section className="telegram-card telegram-connect">
        <span className="telegram-feature-icon">
          <TelegramLogo size={23} />
        </span>
        <h2>Meet your bots in Telegram</h2>
        <p>
          Bring a conversation along. Pick a workspace, send a message, and let your bot take it
          from there.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = token.trim();
            if (!value) return;
            setToken('');
            onConnect(value);
          }}
        >
          <label htmlFor="telegram-token">Bot token</label>
          <div className="telegram-token-field">
            <KeyRound size={16} />
            <input
              id="telegram-token"
              type="password"
              value={token}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              placeholder="Paste the token from BotFather"
              aria-describedby="telegram-token-help"
              required
              disabled={pending}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
          <small id="telegram-token-help">
            Stored encrypted on this Mukai installation. Your token is never shown again.
          </small>
          <button
            type="submit"
            className="button button--primary"
            disabled={pending || !token.trim()}
          >
            {connecting ? (
              <>
                <Loader2 size={15} className="telegram-spin" />
                Connecting…
              </>
            ) : (
              <>
                Connect bot
                <ArrowRight size={15} />
              </>
            )}
          </button>
        </form>
      </section>
      <aside className="telegram-guide">
        <span className="settings-eyebrow">A QUICK FIRST STEP</span>
        <h3>Create a Telegram bot</h3>
        <ol>
          <li>
            <span>1</span>
            <p>
              Open{' '}
              <ExternalAnchor href="https://t.me/BotFather" onError={onError}>
                @BotFather <ExternalLink size={11} />
              </ExternalAnchor>
              , Telegram’s official bot manager.
            </p>
          </li>
          <li>
            <span>2</span>
            <p>
              Send <code>/newbot</code> and choose a name and username for your bot.
            </p>
          </li>
          <li>
            <span>3</span>
            <p>Copy the bot token and paste it here.</p>
          </li>
        </ol>
        <div className="telegram-trust">
          <ShieldCheck size={18} />
          <p>Only the Telegram account you explicitly approve can reach your enabled workspaces.</p>
        </div>
      </aside>
    </div>
  );
}
