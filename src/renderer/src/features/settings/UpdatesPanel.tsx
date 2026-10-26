import { useState } from 'react';
import { Toggle } from '../../components/ui/Toggle';
import { DesktopUpdateControl } from '../updates/DesktopUpdateControl';
import { useDesktopUpdate } from '../updates/useDesktopUpdate';
import { SettingsHeading } from './SettingsHeading';
import './UpdatesPanel.css';
import { updateService } from '../../services/updateService';

export function UpdatesPanel() {
  const state = useDesktopUpdate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const available = state && state.status !== 'disabled';
  const ready = state?.status === 'ready';
  const title = !state
    ? 'Loading updater…'
    : state.status === 'disabled'
      ? 'Updates for installed releases'
      : ready
        ? 'Your next version is ready'
        : state.status === 'downloading'
          ? 'A new version is on its way'
          : state.status === 'checking'
            ? 'Checking for a new version'
            : state.status === 'installing'
              ? 'Restarting Mukai'
              : state.status === 'error'
                ? 'Could not check for updates'
                : state.message
                  ? 'You’re up to date'
                  : 'Keep Mukai up to date';
  const description = !state
    ? 'Getting your update settings.'
    : state.status === 'disabled'
      ? state.message
      : ready
        ? `Version ${state.version} is downloaded. Restart when you’re ready.`
        : state.status === 'downloading'
          ? `Downloading version ${state.version}… ${state.percent ?? 0}%`
          : state.status === 'checking'
            ? 'Looking for the latest published release.'
            : state.status === 'installing'
              ? 'Installing your downloaded update.'
              : state.status === 'error'
                ? state.message
                : 'Get the latest improvements. You choose when to restart.';

  const setAutomaticUpdates = async (enabled: boolean) => {
    setSaving(true);
    setError('');
    try {
      await updateService.setAutomaticUpdates(enabled);
    } catch {
      setError('Could not save your update preference. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsHeading
        eyebrow="ALWAYS MOVING FORWARD"
        title="Updates"
        description="New improvements, at your pace."
      />
      <div className="updates-panel-content">
        <section className="updates-release" aria-labelledby="updates-release-title">
          <div className="updates-release-main">
            <div className="updates-release-copy" role="status">
              <h4 id="updates-release-title">{title}</h4>
              <p>{description}</p>
            </div>
          </div>
          {state?.status === 'downloading' && (
            <progress
              className="updates-progress"
              max={100}
              value={state.percent ?? 0}
              aria-label="Update download"
            />
          )}
          {state && (
            <div className="updates-release-footer">
              <span>
                Installed version <strong>{state.currentVersion}</strong>
              </span>
              <DesktopUpdateControl settings />
            </div>
          )}
        </section>
        <section className="updates-preferences" aria-labelledby="updates-automatic-title">
          <div className="updates-preference-row">
            <div>
              <label id="updates-automatic-title" htmlFor="automatic-updates">
                Automatic updates
              </label>
              <p id="updates-automatic-description">
                Check for and download new versions in the background.
              </p>
            </div>
            <Toggle
              id="automatic-updates"
              aria-describedby="updates-automatic-description"
              checked={state?.automaticUpdates ?? true}
              disabled={!available || saving}
              onChange={(event) => void setAutomaticUpdates(event.target.checked)}
            />
          </div>
          <p className="updates-preference-note" role="status">
            {saving
              ? 'Saving…'
              : !available
                ? 'Updates are available in installed desktop and CLI releases.'
                : state.automaticUpdates
                  ? 'On for this installation. You’ll be prompted before restarting.'
                  : 'Off for this installation. You can still check for updates above.'}
          </p>
          {error && (
            <p className="updates-save-error" role="alert">
              {error}
            </p>
          )}
        </section>
        {ready && (
          <p className="updates-restart-note">
            Restarting stops running bots and tools. Your saved work stays on this device.
          </p>
        )}
        {!state?.automaticUpdates && state?.status === 'downloading' && (
          <p className="updates-restart-note">
            The current download will finish. Future background checks are off.
          </p>
        )}
      </div>
    </>
  );
}
