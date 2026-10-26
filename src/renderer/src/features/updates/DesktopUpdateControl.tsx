import { Download, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useDesktopUpdate } from './useDesktopUpdate';
import { updateService } from '../../services/updateService';

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
      if (ready) await updateService.restartToUpdate();
      else await updateService.checkForUpdates();
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
  return control;
}
