import { Download, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useDesktopUpdate } from './useDesktopUpdate';

export function DesktopUpdateControl({ settings = false }: { settings?: boolean }) {
  const state = useDesktopUpdate();
  const [error, setError] = useState('');
  if (!state || (!settings && (state.status === 'disabled' || state.status === 'idle')))
    return null;
  const busy = ['checking', 'downloading', 'installing'].includes(state.status);
  const ready = state.status === 'ready';
  const label =
    state.status === 'checking'
      ? 'Checking for updates…'
      : state.status === 'downloading'
        ? `Downloading update… ${state.percent ?? 0}%`
        : state.status === 'installing'
          ? 'Restarting Mukai…'
          : ready
            ? 'Restart to update'
            : state.status === 'error'
              ? 'Update failed — Retry'
              : 'Check for updates';
  const action = async () => {
    setError('');
    try {
      if (ready) await window.mukai!.restartToUpdate();
      else await window.mukai!.checkForUpdates();
    } catch {
      setError('Could not contact the updater. Try again.');
    }
  };
  const control = (
    <div className="desktop-update" aria-live="polite" aria-atomic="true">
      <button
        className={settings ? 'button' : 'desktop-update-button'}
        disabled={busy || state.status === 'disabled'}
        title={error || state.message || (state.version ? `Mukai ${state.version}` : label)}
        onClick={() => void action()}
      >
        {busy ? <RefreshCw size={13} className="update-spinner" /> : <Download size={13} />}
        <span>{label}</span>
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
  if (!settings) return control;
  return (
    <section className="settings-card desktop-update-settings">
      <h4>Mukai updates</h4>
      <p>Installed version {state.currentVersion}</p>
      <p>
        {state.status === 'disabled'
          ? state.message
          : state.status === 'idle'
            ? state.message || 'Mukai checks for updates automatically. You choose when to restart.'
            : state.status === 'ready'
              ? `Version ${state.version} is ready. Restarting stops running bots and tools.`
              : state.status === 'error'
                ? state.message
                : label}
      </p>
      {control}
    </section>
  );
}
