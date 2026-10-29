import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Clipboard, Monitor, RefreshCw, MousePointer2 } from 'lucide-react';
import type RFB from '@novnc/novnc';
import type { ComputerStatus } from '../../../../shared/computer';
import { computerService } from '../../services/computerService';
import { copyText, readClipboardText } from '../../services/clipboardService';
import { startPoll } from '../../services/poll';
import { bindComputerClipboard } from './computerClipboard';
import { ComputerClipboardPanel } from './ComputerClipboardPanel';

export function ComputerPanel({
  workspaceId,
  open,
  onClose,
}: {
  workspaceId: string;
  open: boolean;
  onClose(): void;
}) {
  const target = useRef<HTMLDivElement>(null);
  const client = useRef<RFB | null>(null);
  const clipboard = useRef<ReturnType<typeof bindComputerClipboard> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [interactive, setInteractive] = useState(true);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [remoteClipboard, setRemoteClipboard] = useState<string | null>(null);
  const [clipboardMessage, setClipboardMessage] = useState('');
  useEffect(() => {
    if (!open) return;
    const container = target.current;
    let alive = true;
    let rfb: RFB | null = null;
    let resizeTimer: number | undefined;
    const resize = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      // Request the settled panel size after layout transitions and window resizes.
      resizeTimer = window.setTimeout(() => {
        if (rfb && alive) rfb.resizeSession = true;
      }, 160);
    });
    if (container) resize.observe(container);
    const controller = new AbortController();
    let checking = false;
    let previous: string | undefined;
    setState('connecting');
    setError('');
    setStatus(null);
    setClipboardOpen(false);
    setRemoteClipboard(null);
    setClipboardMessage('');
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const value = await computerService.status(workspaceId, controller.signal);
        if (!alive) return;
        const snapshot = JSON.stringify(value);
        const changed = snapshot !== previous;
        previous = snapshot;
        if (changed) setStatus(value);
        return changed;
      } catch {
        /* Connection errors are reported by the viewer request. */
      } finally {
        checking = false;
      }
    };
    const poll = startPoll(() => check(), { interval: 1500, maxInterval: 6000 });
    void (async () => {
      try {
        const [session, { default: Viewer }] = await Promise.all([
          computerService.view(workspaceId, controller.signal),
          import('@novnc/novnc'),
        ]);
        if (!alive || !container) return;
        rfb = new Viewer(container, session.url, {
          shared: true,
          credentials: { password: session.password, username: '', target: '' },
        });
        client.current = rfb;
        clipboard.current = bindComputerClipboard(container, rfb, {
          read: readClipboardText,
          write: copyText,
          remote: setRemoteClipboard,
          message: setClipboardMessage,
          mac: window.mukai?.platform === 'darwin' || /Mac|iPhone|iPad/.test(navigator.platform),
        });
        rfb.scaleViewport = true;
        rfb.resizeSession = true;
        rfb.background = 'transparent';
        rfb.showDotCursor = true;
        rfb.addEventListener('connect', () => {
          if (alive) setState('connected');
        });
        rfb.addEventListener('disconnect', () => {
          if (alive) {
            setState('disconnected');
            setError('The desktop connection closed. Reconnect to return to your computer.');
          }
        });
        rfb.addEventListener('securityfailure', () => {
          if (alive) {
            setState('disconnected');
            setError('Desktop authentication failed. Reconnect to get a fresh session.');
          }
        });
      } catch (failure) {
        if (alive) {
          setState('disconnected');
          setError(
            failure instanceof Error ? failure.message : 'Could not connect to the desktop.',
          );
        }
      }
    })();
    return () => {
      alive = false;
      controller.abort();
      poll.stop();
      window.clearTimeout(resizeTimer);
      resize.disconnect();
      clipboard.current?.dispose();
      clipboard.current = null;
      rfb?.disconnect();
      client.current = null;
      container?.replaceChildren();
    };
  }, [workspaceId, open, attempt]);
  useEffect(() => {
    if (client.current) {
      clipboard.current?.setEnabled(interactive);
      client.current.focusOnClick = interactive;
      client.current.viewOnly = !interactive;
      if (!interactive) client.current.blur();
    }
  }, [interactive, state]);
  return (
    <section
      className={`computer-panel ${open ? 'is-open' : ''}`}
      aria-label="Workspace computer"
      aria-hidden={!open}
      inert={!open}
    >
      <header className="computer-heading">
        <span className="computer-title">
          <Monitor size={16} />
          <span className={`computer-status ${state === 'connected' ? 'is-connected' : ''}`}>
            {state === 'connected'
              ? 'Live'
              : state === 'connecting'
                ? 'Connecting'
                : 'Disconnected'}
          </span>
        </span>
        <div className="computer-controls">
          <button
            className={`computer-control ${clipboardOpen ? 'is-active' : ''}`}
            aria-expanded={clipboardOpen}
            disabled={state !== 'connected' || !interactive}
            onClick={() => setClipboardOpen(!clipboardOpen)}
          >
            <Clipboard size={14} />
            <span>Clipboard</span>
          </button>
          <button
            className={`computer-control ${interactive ? 'is-active' : ''}`}
            aria-pressed={interactive}
            title={interactive ? 'Mouse and keyboard enabled' : 'Watch without sending input'}
            onClick={() => setInteractive(!interactive)}
          >
            <MousePointer2 size={14} />
            <span>{interactive ? 'Control' : 'Watch'}</span>
          </button>
          <button className="computer-control" onClick={onClose}>
            <ArrowLeft size={14} />
            <span>Back to workspace</span>
          </button>
        </div>
      </header>
      {clipboardMessage && state === 'connected' && interactive && (
        <p className="computer-clipboard-notice" role="status">
          {clipboardMessage}
        </p>
      )}
      <div className="computer-display">
        {open && clipboardOpen && state === 'connected' && interactive && (
          <ComputerClipboardPanel
            key={`${workspaceId}:${attempt}`}
            workspaceId={workspaceId}
            remote={remoteClipboard}
            onPaste={(text, terminal) => {
              if (!clipboard.current) throw new Error('The VM is disconnected.');
              clipboard.current.pasteText(text, terminal);
            }}
            onCopy={async () => {
              if (!clipboard.current) throw new Error('The VM is disconnected.');
              await clipboard.current.copyRemote();
            }}
            onClose={() => setClipboardOpen(false)}
          />
        )}
        {open && (
          <div
            ref={target}
            className="computer-canvas"
            aria-label="Linux desktop"
            inert={!interactive}
          />
        )}
        {open && state !== 'connected' && (
          <div className="computer-placeholder" role="status">
            <Monitor size={28} strokeWidth={1.4} />
            <h2>{state === 'connecting' ? 'Opening your computer' : 'Desktop disconnected'}</h2>
            <p>
              {error ||
                status?.message ||
                'Starting the Linux desktop. Your workspace files and apps will be here.'}
            </p>
            {state === 'connecting' && (
              <div className="computer-loading">
                <span />
              </div>
            )}
            {status?.detail && state === 'connecting' && (
              <details>
                <summary>Setup details</summary>
                <pre>{status.detail}</pre>
              </details>
            )}
            {state === 'disconnected' && (
              <button className="button" onClick={() => setAttempt(attempt + 1)}>
                <RefreshCw size={14} /> Reconnect
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
