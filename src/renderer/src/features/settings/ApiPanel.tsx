import { useEffect, useState } from 'react';
import { Cable, Copy, Eye, EyeOff } from 'lucide-react';
import { settingsService } from '../../services/settingsService';
import { copyText } from '../../services/clipboardService';
import { errorText } from '../../utils/errors';
import { SettingsCard } from './SettingsCard';
import { SettingsHeading } from './SettingsHeading';
import './ApiPanel.css';

export function ApiPanel() {
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void settingsService
      .apiBaseUrl()
      .then((url) => {
        if (active) setBaseUrl(url);
      })
      .catch((reason) => {
        if (active) setError(errorText(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await task();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  async function readToken() {
    const value = await settingsService.apiToken();
    if (!value.token) throw new Error('The API token is unavailable. Try again.');
    return value.token;
  }

  return (
    <section className="provider-panel api-settings-panel">
      <SettingsHeading
        eyebrow="APP CONFIGURATION"
        title="API"
        description="Connect your Mukai mobile app or another native client."
      />
      {error && (
        <div className="ai-alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="ai-notice" role="status">
          {notice}
        </p>
      )}
      <SettingsCard
        title="Connection details"
        description="Enter the Base URL and Mukai token on your other device."
        icon={<Cable size={18} />}
      >
        <div className="ai-form settings-card-body api-connection-fields">
          <div>
            <label htmlFor="mukai-api-base-url">Base URL</label>
            <div className="api-connection-row">
              <input id="mukai-api-base-url" value={baseUrl} readOnly spellCheck={false} />
              <button
                className="button button--secondary"
                disabled={!baseUrl || busy}
                onClick={() =>
                  void action(async () => {
                    await copyText(baseUrl);
                    setNotice('Base URL copied.');
                  })
                }
              >
                <Copy size={15} />
                Copy URL
              </button>
            </div>
            <p className="ai-caption">
              For another device, use an address that reaches this server. Localhost and 127.0.0.1
              only work on the machine running Mukai.
            </p>
          </div>
          <div>
            <label htmlFor="mukai-api-token">Mukai token</label>
            <div className="api-connection-row">
              <input
                id="mukai-api-token"
                type={token ? 'text' : 'password'}
                value={token || '••••••••••••••••••••••••••••••••'}
                readOnly
                autoComplete="off"
                spellCheck={false}
              />
              <button
                className="button button--secondary api-token-visibility"
                aria-label={token ? 'Hide token' : 'Reveal token'}
                disabled={busy}
                onClick={() => {
                  if (token) {
                    setToken('');
                    setNotice('');
                    return;
                  }
                  void action(async () => setToken(await readToken()));
                }}
              >
                {token ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
              <button
                className="button button--primary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await copyText(await readToken());
                    setNotice('Mukai token copied.');
                  })
                }
              >
                <Copy size={15} />
                Copy token
              </button>
            </div>
            <p className="ai-caption">This token grants access to your Mukai. Keep it private.</p>
          </div>
        </div>
      </SettingsCard>
    </section>
  );
}
