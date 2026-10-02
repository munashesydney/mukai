import { useEffect, useState, type ReactNode } from 'react';
import { Bookmark, Check, Copy } from 'lucide-react';
import { IconButton } from '../../components/ui/IconButton';

export function MessageActions({
  text,
  saved,
  onSave,
  children,
}: {
  text: string;
  saved: boolean;
  onSave: () => void;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="message-footer-actions">
      <IconButton
        label={saved ? 'Unsave message' : 'Save message'}
        className={saved ? 'message-saved is-on' : ''}
        aria-pressed={saved}
        onClick={onSave}
      >
        <Bookmark size={14} fill={saved ? 'currentColor' : 'none'} />
      </IconButton>
      <IconButton
        label={copied ? 'Copied message' : 'Copy message'}
        disabled={!text}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setCopyError(false);
          } catch {
            setCopyError(true);
          }
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </IconButton>
      {children}
      <span className="visually-hidden" role="status">
        {copied ? 'Message copied' : ''}
      </span>
      {copyError && <span role="alert">Could not copy. Try again.</span>}
    </div>
  );
}
