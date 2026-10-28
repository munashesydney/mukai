import { useContext, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, CircleAlert, Copy, LoaderCircle, Terminal } from 'lucide-react';
import type { ChatActivity } from '../../../../shared/ai';
import { terminalSnapshotSchema, type TerminalSnapshot } from '../../../../shared/terminal';
import { chatActivityService } from '../../services/chatActivityService';
import { copyText } from '../../services/clipboardService';
import { ResponseReferenceContext } from './responseReferenceContext';
import './TerminalCard.css';

function savedSnapshot(activity: ChatActivity) {
  const structured = terminalSnapshotSchema.safeParse(activity.terminal);
  if (structured.success) return structured.data;
  try {
    return terminalSnapshotSchema.parse(JSON.parse(activity.summary));
  } catch {
    return undefined;
  }
}

export function TerminalCard({ activity }: { activity: ChatActivity }) {
  const conversationId = useContext(ResponseReferenceContext);
  const saved = savedSnapshot(activity);
  const sessionId = activity.processSessionId || saved?.id;
  const [live, setLive] = useState<TerminalSnapshot>();
  const [refreshError, setRefreshError] = useState('');
  const [expanded, setExpanded] = useState<boolean>();
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState('');
  const bodyId = useId();
  const output = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const snapshot = live?.id === sessionId ? live : saved;
  const running = snapshot
    ? snapshot.status === 'running' && !snapshot.unavailable
    : activity.status === 'running';
  const failed = snapshot
    ? snapshot.status === 'failed' ||
      (snapshot.status === 'exited' && snapshot.exitCode !== 0 && snapshot.exitCode !== null)
    : activity.status === 'failed';
  const stopped = snapshot?.status === 'killed' || activity.status === 'interrupted';
  const unavailable = snapshot?.unavailable && snapshot.status === 'running';
  const successful = snapshot?.status === 'exited' && snapshot.exitCode === 0;
  const open = expanded ?? running;
  const command = snapshot?.command || activity.path;
  const text = snapshot?.output ?? activity.summary;
  // Strip terminal control sequences; React renders the remaining output as plain text.
  const visibleOutput = text.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]/g,
    '',
  );
  const status = running
    ? 'Running'
    : unavailable
      ? 'Session unavailable'
      : stopped
        ? 'Stopped'
        : failed
          ? `Failed${snapshot?.exitCode !== null && snapshot?.exitCode !== undefined ? ` · exit ${snapshot.exitCode}` : ''}`
          : successful
            ? 'Success'
            : snapshot?.status === 'exited'
              ? 'Exited'
              : 'Result unavailable';

  useEffect(() => {
    if (!sessionId || !conversationId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await chatActivityService.terminal(conversationId, sessionId);
        if (!active) return;
        setLive(next);
        setRefreshError('');
        if (next.status !== 'running' || next.unavailable) return;
      } catch {
        if (!active) return;
        setRefreshError('Live output is temporarily unavailable. Retrying…');
      }
      if (active) timer = setTimeout(() => void load(), 1000);
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [conversationId, sessionId, saved?.status]);
  useEffect(() => {
    if (following.current && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [visibleOutput, open]);
  async function copy(value: string, kind: string) {
    try {
      await copyText(value);
      setCopied(kind);
      setCopyError('');
    } catch {
      setCopyError('Could not copy. Select the text to copy it manually.');
    }
  }
  return (
    <div className={`terminal-card${failed ? ' terminal-card--failed' : ''}`}>
      <button
        type="button"
        className="terminal-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setExpanded(!open)}
      >
        {running ? <LoaderCircle size={14} className="is-spinning" /> : <Terminal size={14} />}
        <span className="terminal-command-preview" title={command}>
          {running ? 'Running' : failed ? 'Failed' : stopped ? 'Stopped' : 'Ran'} {command}
        </span>
        <ChevronDown size={13} className={open ? 'terminal-chevron is-open' : 'terminal-chevron'} />
      </button>
      {open && (
        <section className="terminal-panel" id={bodyId} aria-label="Terminal output">
          <div className="terminal-toolbar">
            <span>{snapshot?.shell || 'Shell'}</span>
            {snapshot?.envFromSettings?.length ? (
              <span className="terminal-env" title={snapshot.envFromSettings.join(', ')}>
                {snapshot.envFromSettings.length} saved{' '}
                {snapshot.envFromSettings.length === 1 ? 'variable' : 'variables'}
              </span>
            ) : null}
            <button
              type="button"
              title="Copy command"
              aria-label="Copy command"
              onClick={() => void copy(command, 'command')}
            >
              {copied === 'command' ? <Check size={13} /> : <Copy size={13} />}
            </button>
            <button
              type="button"
              title="Copy output"
              aria-label="Copy terminal output"
              disabled={!visibleOutput}
              onClick={() => void copy(visibleOutput, 'output')}
            >
              {copied === 'output' ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
          <pre
            ref={output}
            className="terminal-transcript"
            tabIndex={0}
            aria-label="Command and output"
            onScroll={() => {
              if (output.current)
                following.current =
                  output.current.scrollHeight -
                    output.current.scrollTop -
                    output.current.clientHeight <
                  40;
            }}
          >
            <span className="terminal-command-line">
              $ {command}
              {'\n'}
            </span>
            {visibleOutput || (running ? '\nWaiting for output…' : '\nNo output.')}
          </pre>
          <div className="terminal-footer" role="status">
            <span className="terminal-cwd" title={snapshot?.cwd}>
              {snapshot?.cwd}
            </span>
            <span className="terminal-state">
              {running ? (
                <LoaderCircle size={12} className="is-spinning" />
              ) : failed ? (
                <CircleAlert size={12} />
              ) : successful ? (
                <Check size={12} />
              ) : null}
              {status}
            </span>
          </div>
          {(snapshot?.truncated || snapshot?.unavailable || refreshError || copyError) && (
            <p className="terminal-notice">
              {copyError ||
                refreshError ||
                (snapshot?.unavailable
                  ? 'Showing saved output. This session is no longer available.'
                  : 'Earlier output was truncated.')}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
