import { customRouteReturnTo } from '../../../../shared/routeAccess';
import { useEffect, useState, type ReactNode } from 'react';
import { Check, ArrowRight, ShieldCheck, Eye, EyeOff } from 'lucide-react';
import { Brand } from '../../components/ui/Brand';
import { initializeBrowserSession } from '../../services/browserSession';
import { authRequest, authChanged, type AuthStatus } from '../../services/ownerAuthService';
import { errorText } from '../../utils/errors';
import { ownerCredentialsSchema } from '../../../../shared/ownerAuth';

const steps = [
  ['Prove ownership', 'Use the code from your terminal.'],
  ['Create your login', 'A username and password, just for you.'],
  ['Open Mukai', 'Your workspace, wherever you are.'],
];
function PasswordField({
  label,
  value,
  onChange,
  creating,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  creating: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label>
      {label}
      <span className="auth-password">
        <input
          required
          type={visible ? 'text' : 'password'}
          autoComplete={creating ? 'new-password' : 'current-password'}
          minLength={creating ? 10 : 1}
          maxLength={256}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </span>
    </label>
  );
}

export function BrowserAuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [code, setCode] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get('mukai-setup') || '',
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const bypass = Boolean(window.mukai) || import.meta.env.DEV;
  useEffect(() => {
    if (status && !status.authenticated) document.getElementById('auth-title')?.focus();
  }, [status]);
  useEffect(() => {
    if (bypass) return;
    let disposed = false;
    if (new URLSearchParams(window.location.hash.slice(1)).has('mukai-setup'))
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    void (async () => {
      try {
        // Retain legacy local links for existing installations before owner setup.
        await initializeBrowserSession();
        if (!disposed) setStatus({ configured: false, authenticated: true, verified: false });
      } catch {
        try {
          const result = await authRequest<AuthStatus>('status');
          if (!disposed) {
            setStatus(result);
            setError('');
          }
        } catch (caught) {
          if (!disposed) setError(errorText(caught));
        }
      }
    })();
    const changed = () => {
      void authRequest<AuthStatus>('status')
        .then((result) => {
          if (!disposed) {
            setStatus(result);
            setPassword('');
            setConfirm('');
            setError('');
          }
        })
        .catch((caught) => {
          if (!disposed) {
            setStatus(null);
            setError(errorText(caught));
          }
        });
    };
    window.addEventListener(authChanged, changed);
    return () => {
      disposed = true;
      window.removeEventListener(authChanged, changed);
    };
  }, [bypass, retry]);
  useEffect(() => {
    if (bypass || !status?.authenticated) return;
    const target = customRouteReturnTo(
      new URLSearchParams(window.location.search).get('mukai-returnTo'),
    );
    if (target) window.location.replace(target);
  }, [bypass, status?.authenticated]);
  if (bypass || status?.authenticated) return children;
  const login = Boolean(status?.configured);
  const creating = !login && Boolean(status?.verified);
  const step = creating ? 1 : 0;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !status) return;
    setError('');
    setBusy(true);
    try {
      if (!login && !creating) {
        await authRequest('verify', { code });
        setCode('');
        setStatus({ configured: false, authenticated: false, verified: true });
      } else {
        if (creating) {
          const parsed = ownerCredentialsSchema.safeParse({ username, password });
          if (!parsed.success) throw new Error(parsed.error.issues[0].message);
        }
        if (creating && password !== confirm)
          throw new Error('The passwords don’t match. Try again.');
        await authRequest(creating ? 'setup' : 'login', { username, password });
        setPassword('');
        setConfirm('');
        setStatus({ configured: true, authenticated: true, verified: false });
      }
    } catch (caught) {
      setError(errorText(caught));
      // Another device may have finished setup, or this proof may have expired.
      try {
        setStatus(await authRequest<AuthStatus>('status'));
      } catch {
        /* Keep the form available. */
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-shell">
        <header className="auth-header">
          <Brand />
          <span>
            <ShieldCheck size={14} /> Your Mukai. Your access.
          </span>
        </header>
        <div className="auth-layout">
          <section className="auth-main" aria-labelledby="auth-title">
            <div className="auth-content">
              <span className="auth-eyebrow">
                {login ? 'WELCOME BACK' : `LET’S GET YOU CONNECTED · ${step + 1} OF 2`}
              </span>
              <h1 id="auth-title" tabIndex={-1}>
                {!status
                  ? 'Connecting to Mukai…'
                  : login
                    ? 'Welcome back.'
                    : creating
                      ? 'Make it yours.'
                      : 'Connect your Mukai.'}
              </h1>
              <p className="auth-description">
                {!status
                  ? 'Checking your connection.'
                  : login
                    ? 'Sign in to pick up where you left off.'
                    : creating
                      ? 'Create the login you’ll use to access this Mukai.'
                      : 'Enter the setup code shown in the terminal where you started Mukai.'}
              </p>
              {status && (
                <form className="ai-form auth-form" onSubmit={submit} aria-busy={busy}>
                  {!login && !creating ? (
                    <label>
                      Setup code
                      <input
                        className="auth-code"
                        name="setup-code"
                        type="text"
                        autoComplete="one-time-code"
                        autoCapitalize="none"
                        spellCheck={false}
                        required
                        maxLength={128}
                        value={code}
                        placeholder="Paste your setup code"
                        onChange={(event) => setCode(event.target.value)}
                        aria-describedby="auth-help"
                      />
                    </label>
                  ) : (
                    <>
                      <label>
                        Username
                        <input
                          name="username"
                          autoComplete="username"
                          autoCapitalize="none"
                          spellCheck={false}
                          required
                          minLength={creating ? 3 : 1}
                          maxLength={254}
                          value={username}
                          onChange={(event) => setUsername(event.target.value)}
                          aria-describedby={creating ? 'auth-username-help' : undefined}
                        />
                      </label>
                      {creating && (
                        <p id="auth-username-help" className="auth-field-help">
                          3–254 characters, without spaces. An email address works too.
                        </p>
                      )}
                      <PasswordField
                        label="Password"
                        value={password}
                        onChange={setPassword}
                        creating={creating}
                      />
                      {creating && (
                        <>
                          <p className="auth-field-help">
                            Use at least 10 characters. A memorable passphrase works well.
                          </p>
                          <PasswordField
                            label="Confirm password"
                            value={confirm}
                            onChange={setConfirm}
                            creating
                          />
                        </>
                      )}
                    </>
                  )}
                  {error && (
                    <p className="ai-alert" role="alert">
                      {error}
                    </p>
                  )}
                  <button className="button button--primary auth-submit" disabled={busy}>
                    {busy
                      ? 'One moment…'
                      : login
                        ? 'Sign in'
                        : creating
                          ? 'Create login & open Mukai'
                          : 'Continue'}
                    {!busy && <ArrowRight size={16} />}
                  </button>
                  <p id="auth-help" className="auth-help">
                    {login
                      ? 'Forgot your login? On the machine running Mukai, stop the server and run mukai auth-reset.'
                      : creating
                        ? 'This login belongs to your installation. No email or external account needed.'
                        : 'The code expires after 30 minutes. Restart the server to get a new one.'}
                  </p>
                  {creating && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        setStatus({ configured: false, authenticated: false, verified: false });
                        setPassword('');
                        setConfirm('');
                        setError('');
                      }}
                    >
                      Use another setup code
                    </button>
                  )}
                </form>
              )}
              {!status && error && (
                <>
                  <p role="alert" className="ai-alert">
                    {error}
                  </p>
                  <button className="button" onClick={() => setRetry((value) => value + 1)}>
                    Try again
                  </button>
                </>
              )}
            </div>
          </section>
          <aside className="auth-aside" aria-label={login ? 'About your login' : 'Setup progress'}>
            {login ? (
              <div className="auth-welcome">
                <span className="auth-mark">
                  <ShieldCheck size={24} />
                </span>
                <h2>
                  A familiar place.
                  <br />
                  From any browser.
                </h2>
                <p>Your workspaces, conversations and ideas are right where you left them.</p>
              </div>
            ) : (
              <ol className="auth-steps">
                {steps.map(([title, description], index) => (
                  <li
                    key={title}
                    className={index < step ? 'is-complete' : index === step ? 'is-current' : ''}
                    aria-current={index === step ? 'step' : undefined}
                  >
                    <span className="auth-step-number">
                      {index < step ? <Check size={16} /> : index + 1}
                    </span>
                    <div>
                      <strong>{title}</strong>
                      <p>{description}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <div className="auth-aside-footer">
              <ShieldCheck size={18} />
              <strong>Hosted by you.</strong>
              <p>Your login protects access to the Mukai running on your machine.</p>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
