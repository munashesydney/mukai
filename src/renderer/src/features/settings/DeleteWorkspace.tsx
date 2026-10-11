import { useState } from 'react';
import { LoaderCircle, ShieldAlert, Trash2 } from 'lucide-react';
import type { Workspace } from '../../../../shared/ai';
import { Modal } from '../../components/ui/Modal';
import { errorText } from '../../utils/errors';

export function DeleteWorkspace({
  workspace,
  onDelete,
}: {
  workspace: Workspace;
  onDelete: (id: string, name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await onDelete(workspace.id, name);
      setOpen(false);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card workspace-danger-card" aria-label="Danger zone">
      <div className="settings-card-heading">
        <span className="settings-card-icon" aria-hidden="true">
          <ShieldAlert size={18} />
        </span>
        <div>
          <h4>Danger zone</h4>
          <p>Permanent changes. Proceed with care.</p>
        </div>
      </div>
      <div className="workspace-danger-action">
        <div className="workspace-danger-copy">
          <h5>Delete workspace</h5>
          <p>
            {workspace.deleting
              ? 'Deletion is incomplete. This workspace is blocked from running. Retry to finish cleanup.'
              : 'Permanently remove this workspace and its data. This cannot be undone.'}
          </p>
        </div>
        <button
          className="button workspace-danger-button"
          onClick={() => {
            setName('');
            setError('');
            setOpen(true);
          }}
        >
          <Trash2 size={14} aria-hidden="true" />
          {workspace.deleting ? 'Retry deletion' : 'Delete workspace'}
        </button>
      </div>
      {open && (
        <Modal
          title="Delete workspace"
          className="workspace-delete-modal"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name === workspace.name && !busy) void remove();
            }}
          >
            <div className="ai-form bot-editor-body workspace-delete-body">
              <div className="workspace-delete-warning">
                <ShieldAlert size={18} aria-hidden="true" />
                <div>
                  <strong>This action cannot be undone</strong>
                  <p>Make sure you have saved anything you want to keep.</p>
                </div>
              </div>
              <p>
                Delete <strong>{workspace.name}</strong>? This permanently removes its bots, chats,
                pursuits, memories, and uploaded files.
              </p>
              <p>
                {workspace.computer === 'qemu'
                  ? 'Its Linux VM will stop, and its disk and all files inside it will be deleted.'
                  : 'Your connected project folder and its contents will be kept.'}
              </p>
              <p>Other workspaces and provider connections will be kept. This cannot be undone.</p>
              <label>
                <span>
                  Type <strong>{workspace.name}</strong> to confirm
                </span>
                <input
                  value={name}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="off"
                />
              </label>
              {error && (
                <p className="ai-alert" role="alert">
                  {error} Deletion can be retried.
                </p>
              )}
              {busy && <p role="status">Stopping running work and removing workspace data...</p>}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="button button--danger"
                disabled={busy || name !== workspace.name}
                aria-busy={busy}
              >
                {busy ? (
                  <LoaderCircle size={14} className="is-spinning" aria-hidden="true" />
                ) : (
                  <Trash2 size={14} aria-hidden="true" />
                )}
                {busy ? 'Deleting' : 'Permanently delete'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
