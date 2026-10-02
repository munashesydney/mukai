import { useState } from 'react';
import { ChevronDown, FileDiff } from 'lucide-react';
import type { ChatMessage } from '../../../../shared/ai';
import type { FileChangeSummary } from '../../../../shared/fileChanges';

export function ChangeCounts({ added, removed }: Pick<FileChangeSummary, 'added' | 'removed'>) {
  if (added === null || removed === null)
    return <span className="change-counts-unavailable">Counts unavailable</span>;
  return (
    <span className="change-counts" aria-label={`${added} lines added, ${removed} lines removed`}>
      <span className="change-added">+{added}</span>
      <span className="change-removed">−{removed}</span>
    </span>
  );
}

export function FileChanges({
  message,
  onReview,
}: {
  message: ChatMessage;
  onReview: (changes: FileChangeSummary[], selectedId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const changes = message.changes || [];
  if (message.status === 'streaming' || !changes.length) return null;
  const known = changes.every((change) => change.added !== null && change.removed !== null);
  const added = known ? changes.reduce((sum, change) => sum + change.added!, 0) : null;
  const removed = known ? changes.reduce((sum, change) => sum + change.removed!, 0) : null;
  return (
    <section className="file-changes" aria-label="Files changed in this response">
      <header className="file-changes-header">
        <span className="file-changes-icon">
          <FileDiff size={19} />
        </span>
        <div>
          <strong>
            Edited {changes.length} {changes.length === 1 ? 'file' : 'files'}
          </strong>
          <ChangeCounts added={added} removed={removed} />
        </div>
        <button
          type="button"
          className="file-changes-view"
          onClick={() => onReview(changes, changes[0].id)}
        >
          View changes
        </button>
      </header>
      <div id={`file-changes-${message.id}`}>
        {(expanded ? changes : changes.slice(0, 3)).map((change) => (
          <button
            type="button"
            className="file-change-row"
            key={change.id}
            onClick={() => onReview(changes, change.id)}
            aria-label={`Review ${change.path}`}
          >
            <span className="file-change-path" title={change.path}>
              {change.path}
            </span>
            {change.kind === 'created' && <span className="file-change-kind">New</span>}
            <ChangeCounts added={change.added} removed={change.removed} />
          </button>
        ))}
      </div>
      {changes.length > 3 && (
        <button
          type="button"
          className="file-changes-more"
          aria-expanded={expanded}
          aria-controls={`file-changes-${message.id}`}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? 'Show fewer files'
            : `Show ${changes.length - 3} more ${changes.length - 3 === 1 ? 'file' : 'files'}`}
          <ChevronDown size={14} className={expanded ? 'is-expanded' : ''} />
        </button>
      )}
    </section>
  );
}
