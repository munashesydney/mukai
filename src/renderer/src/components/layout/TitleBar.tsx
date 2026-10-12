import { ArrowLeft, ArrowRight, Search, Minus, Square, X, PanelLeft, Monitor } from 'lucide-react';
import { Brand } from '../ui/Brand';
import { IconButton } from '../ui/IconButton';
import { useEffect, useState } from 'react';
import { getHealth } from '../../services/healthService';

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
  const [connection, setConnection] = useState('Connecting…');
  useEffect(() => {
    let disposed = false;
    const check = async () => {
      try {
        await getHealth();
        if (!disposed) setConnection('All systems calm');
      } catch {
        if (!disposed) setConnection('Server unavailable');
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 30000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);
  return (
    <header className="title-bar">
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
        <span className="workspace-state">
          <i /> {connection}
        </span>
        {window.mukai && (
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
      </div>
    </header>
  );
}
