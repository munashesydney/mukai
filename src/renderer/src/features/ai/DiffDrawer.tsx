import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react';
import type { FileChangeDetail, FileChangeSummary } from '../../../../shared/fileChanges';
import { fileChangeService } from '../../services/fileChangeService';
import { errorText } from '../../utils/errors';
import { Modal } from '../../components/ui/Modal';
import { IconButton } from '../../components/ui/IconButton';
import { ChangeCounts } from './FileChanges';
import { DiffView } from './DiffView';

function DiffFile({ change }: { change: FileChangeSummary }) {
  const [detail, setDetail] = useState<FileChangeDetail | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fileChangeService
      .detail(change.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(errorText(caught));
      });
    return () => controller.abort();
  }, [change.id, retry]);
  if (error)
    return (
      <div className="diff-load-state" role="alert">
        <p>{error}</p>
        <button
          className="text-button"
          onClick={() => {
            setError('');
            setRetry(retry + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  if (!detail)
    return (
      <div className="diff-load-state" role="status">
        <LoaderCircle size={20} className="is-spinning" />
        Loading saved changes…
      </div>
    );
  return (
    <div className="diff-file">
      <div className="diff-file-heading">
        <span>{detail.kind === 'created' ? 'Created file' : 'Edited file'}</span>
        <ChangeCounts added={detail.added} removed={detail.removed} />
      </div>
      {detail.hunks ? (
        <DiffView hunks={detail.hunks} />
      ) : (
        <div className="diff-fallback">
          <p>
            This change is too large to compute a line diff quickly. The exact saved contents are
            available below.
          </p>
          <h3>Before</h3>
          <pre>{detail.before ?? '(File did not exist)'}</pre>
          <h3>After</h3>
          <pre>{detail.after}</pre>
        </div>
      )}
    </div>
  );
}

export function DiffDrawer({
  changes,
  selectedId,
  onSelect,
  onClose,
}: {
  changes: FileChangeSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const selected = changes.findIndex((change) => change.id === selectedId);
  const change = changes[selected];
  if (!change) return null;
  return (
    <Modal title="File changes" className="diff-drawer" onClose={onClose}>
      <nav className="diff-navigation" aria-label="Changed files">
        <select
          aria-label="Select changed file"
          value={selectedId}
          onChange={(event) => onSelect(event.target.value)}
        >
          {changes.map((file) => (
            <option key={file.id} value={file.id}>
              {file.path}
            </option>
          ))}
        </select>
        <span>
          {selected + 1} / {changes.length}
        </span>
        <IconButton
          label="Previous changed file"
          disabled={selected === 0}
          onClick={() => onSelect(changes[selected - 1].id)}
        >
          <ChevronLeft size={16} />
        </IconButton>
        <IconButton
          label="Next changed file"
          disabled={selected === changes.length - 1}
          onClick={() => onSelect(changes[selected + 1].id)}
        >
          <ChevronRight size={16} />
        </IconButton>
      </nav>
      <div className="diff-drawer-content">
        <DiffFile key={change.id} change={change} />
      </div>
      <footer className="diff-drawer-footer">
        Saved changes from this response · Later edits do not change this diff
      </footer>
    </Modal>
  );
}
