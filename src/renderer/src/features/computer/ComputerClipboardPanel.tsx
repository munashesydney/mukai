import { useState } from 'react';
import { X } from 'lucide-react';

export function ComputerClipboardPanel({
  workspaceId,
  remote,
  onPaste,
  onCopy,
  onClose,
}: {
  workspaceId: string;
  remote: string | null;
  onPaste(text: string, terminal: boolean): void;
  onCopy(): Promise<void>;
  onClose(): void;
}) {
  const [text, setText] = useState('');
  const storageKey = `mukai.clipboard.terminal.${workspaceId}`;
  const [terminal, setTerminal] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === 'true';
    } catch {
      return false;
    }
  });
  const [message, setMessage] = useState('');
  return (
    <aside className="computer-clipboard" aria-label="VM clipboard">
      <div className="computer-clipboard-heading">
        <strong>Clipboard</strong>
        <button className="computer-control" aria-label="Close clipboard" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <p>Transfer text between your computer and the VM.</p>
      <label htmlFor="computer-clipboard-send">To VM</label>
      <textarea
        id="computer-clipboard-send"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Paste or type text here"
        spellCheck={false}
        autoFocus
      />
      <label className="computer-clipboard-terminal">
        <input
          type="checkbox"
          checked={terminal}
          onChange={(event) => {
            const checked = event.target.checked;
            setTerminal(checked);
            try {
              localStorage.setItem(storageKey, String(checked));
            } catch {
              /* Keep the control usable when browser storage is unavailable. */
            }
          }}
        />
        Terminal paste (Ctrl+Shift+V)
      </label>
      <button
        className="button"
        onClick={() => {
          try {
            onPaste(text, terminal);
            setMessage('Text pasted into the VM.');
          } catch (failure) {
            setMessage(failure instanceof Error ? failure.message : 'Could not paste text.');
          }
        }}
      >
        Paste into VM
      </button>
      <label htmlFor="computer-clipboard-receive">From VM</label>
      <textarea
        id="computer-clipboard-receive"
        value={remote ?? ''}
        readOnly
        spellCheck={false}
        placeholder="Copy text inside the VM to see it here"
      />
      <button
        className="button"
        disabled={remote === null}
        onClick={() => {
          void onCopy()
            .then(() => setMessage('Copied to your clipboard.'))
            .catch(() => setMessage('Select the text above and copy it with your usual shortcut.'));
        }}
      >
        Copy from VM
      </button>
      <p className="computer-clipboard-message" role="status">
        {message}
      </p>
    </aside>
  );
}
