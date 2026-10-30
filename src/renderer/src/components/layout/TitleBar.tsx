import {
  ArrowLeft,
  ArrowRight,
  Search,
  Minus,
  Square,
  X,
  PanelLeft,
  Monitor,
  LogOut,
} from 'lucide-react';
import { Brand } from '../ui/Brand';
import { IconButton } from '../ui/IconButton';
import { useEffect, useState } from 'react';
import { getHealth } from '../../services/healthService';
import { signOut } from '../../services/ownerAuthService';
import { DesktopUpdateControl } from '../../features/updates/DesktopUpdateControl';

export function TitleBar({
  onSearch,
  onBack,
  onForward,
  canBack,
  canForward,
  onToggleSidebar,
  onComputer,
  computerOpen = false,
  workspaceName = 'Your workspace',
  disabled = false,
}: {
  onSearch: () => void;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
  onToggleSidebar: () => void;
  onComputer?: () => void;
  computerOpen?: boolean;
  workspaceName?: string;
  disabled?: boolean;
}) {
  const isMacDesktop = window.mukai?.platform === 'darwin';
  const [connection, setConnection] = useState('Connecting…');
  useEffect(() => {
    let disposed = false;
    let timer = 0;
    const check = async () => {
      let healthy = false;
      try {
        await getHealth();
        healthy = true;
      } catch {
        healthy = false;
      }
      if (disposed) return;
      setConnection(healthy ? 'All systems calm' : 'Server unavailable');
      // While the answer is bad, that is the one thing worth looking for again
      // soon; once it is good, a heartbeat is plenty. Both halves matter: a long
      // interval while unhealthy left the sidebar saying "Server unavailable" for
      // half a minute after approvals had come back, and a long interval while
      // healthy meant a backend that stopped was still reported calm — the two
      // status readouts contradicting each other was the original complaint.
      timer = window.setTimeout(() => void check(), healthy ? 10_000 : 2_000);
    };
    void check();
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      window.clearTimeout(timer);
      void check();
    };
    // A lost network is worth saying out loud the moment the browser notices,
    // without waiting for the next heartbeat; the recovery direction is left to
    // the probe, because "the browser has a network" is not the same claim as
    // "Mukai's server answers".
    const onOffline = (): void => {
      if (disposed) return;
      setConnection('Server unavailable');
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('offline', onOffline);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('offline', onOffline);
    };
  }, []);
  return (
    <header className={`title-bar${isMacDesktop ? ' title-bar-mac' : ''}`}>
      <div className="title-brand">
        <Brand />
      </div>
      <div className="history-controls">
        <IconButton label="Go back" onClick={onBack} disabled={!canBack}>
          <ArrowLeft size={17} />
        </IconButton>
        <IconButton label="Go forward" onClick={onForward} disabled={!canForward}>
          <ArrowRight size={17} />
        </IconButton>
        <IconButton
          label="Toggle sidebar"
          onClick={onToggleSidebar}
          disabled={computerOpen || disabled}
        >
          <PanelLeft size={16} />
        </IconButton>
      </div>
      <button className="workspace-search" onClick={onSearch} disabled={disabled}>
        <Search size={16} />
        <span>Search {workspaceName}</span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className="title-right">
        <DesktopUpdateControl />
        {onComputer && (
          <button
            className={`computer-toggle ${computerOpen ? 'is-active' : ''}`}
            aria-pressed={computerOpen}
            onClick={onComputer}
          >
            <Monitor size={15} />
            <span>{computerOpen ? 'Exit computer' : 'View computer'}</span>
          </button>
        )}
        <span
          className="workspace-state"
          role="status"
          title={
            connection === 'Server unavailable'
              ? window.mukai
                ? 'Mukai’s server is not answering. Restart the Mukai window — this page notices on its own.'
                : 'Mukai’s server is not answering. Start it with `mukai serve` — this page notices on its own.'
              : connection === 'Connecting…'
                ? 'Checking whether Mukai’s server answers.'
                : 'Mukai’s server is answering.'
          }
          aria-label={
            connection === 'Server unavailable'
              ? 'Mukai’s server is not answering. Start the backend and try again.'
              : connection
          }
        >
          <i /> {connection}
        </span>
        {window.mukai && !isMacDesktop && (
          <div className="window-controls">
            <button aria-label="Minimize window" onClick={() => window.mukai?.minimize()}>
              <Minus size={15} />
            </button>
            <button
              aria-label="Maximize or restore window"
              onClick={() => window.mukai?.toggleMaximize()}
            >
              <Square size={12} />
            </button>
            <button
              aria-label="Close window"
              className="window-close"
              onClick={() => window.mukai?.close()}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {!window.mukai && !import.meta.env.DEV && (
          <IconButton
            label="Sign out"
            onClick={() =>
              void signOut().catch(() =>
                window.alert('Could not sign out. Check your connection and try again.'),
              )
            }
          >
            <LogOut size={16} />
          </IconButton>
        )}
      </div>
    </header>
  );
}
