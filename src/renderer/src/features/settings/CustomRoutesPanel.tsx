import { Globe } from 'lucide-react';
import { SettingsCard } from './SettingsCard';
import { SettingsHeading } from './SettingsHeading';
import { useEffect, useState } from 'react';
import { capabilityService } from '../../services/capabilityService';
import { errorText } from '../../utils/errors';

export function CustomRoutesPanel() {
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [localBaseUrl, setLocalBaseUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    void capabilityService
      .routeSettings()
      .then((settings) => {
        if (!active) return;
        setPublicBaseUrl(settings.publicBaseUrl);
        setLocalBaseUrl(settings.localBaseUrl);
      })
      .catch((error) => {
        if (active) setError(errorText(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function save() {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const settings = await capabilityService.saveRouteSettings(publicBaseUrl);
      setPublicBaseUrl(settings.publicBaseUrl);
      setNotice('Saved. Custom routes use this address immediately.');
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="provider-panel capability-panel">
      <SettingsHeading
        eyebrow="APP CONFIGURATION"
        title="Domain"
        description="Set the public address for custom routes across all workspaces."
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
        title="Public address"
        description="The base address used by your workspace routes."
        icon={<Globe size={18} />}
      >
        <form
          className="ai-form capability-form settings-card-body"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            Public base URL
            <input
              type="url"
              placeholder="https://your-domain.com"
              value={publicBaseUrl}
              disabled={loading || saving}
              onChange={(event) => {
                setPublicBaseUrl(event.target.value);
                setNotice('');
              }}
            />
          </label>
          <p className="ai-caption">
            Use an HTTPS address without a path. Leave blank to use the local server address. Route
            URLs append their path, for example{' '}
            <code>{publicBaseUrl.trim().replace(/\/$/, '') || localBaseUrl}/custom/events</code>.
            Your domain or tunnel must already forward requests to Mukai. Saving this address does
            not set up hosting or a tunnel.
            {localBaseUrl && (
              <>
                {' '}
                Local server: <code>{localBaseUrl}</code>.
              </>
            )}
          </p>
          <div className="ai-form-actions settings-card-actions">
            <button className="button button--primary" type="submit" disabled={loading || saving}>
              {loading ? 'Loading…' : saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </SettingsCard>
    </section>
  );
}
