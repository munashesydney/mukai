import { useState } from 'react';
import { FolderOpen, Layers3 } from 'lucide-react';
import type { Workspace } from '../../../../shared/ai';
import { Modal } from '../../components/ui/Modal';
import { workspaceService } from '../../services/workspaceService';
import { errorText } from '../../utils/errors';

export function WorkspaceEditor({
  workspace,
  onClose,
  onSaved,
}: {
  workspace?: Workspace;
  onClose: () => void;
  onSaved: (workspace: Workspace) => void;
}) {
  const [folder, setFolder] = useState(''),
    [name, setName] = useState(workspace?.name || '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function choose() {
    setBusy(true);
    setError('');
    try {
      const folder = await workspaceService.chooseFolder();
      if (folder) {
        setFolder(folder);
        if (!name) setName(folder.split(/[\\/]/).filter(Boolean).at(-1) || 'My workspace');
      }
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      onSaved(
        await (workspace
          ? workspaceService.connect(workspace.id, { name, folder })
          : workspaceService.create({ name, folder })),
      );
    } catch (error) {
      setError(errorText(error));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={workspace ? 'Connect a workspace folder' : 'Create a workspace'}
      className="workspace-editor"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="ai-form bot-editor-body">
          <div className="workspace-editor-intro">
            <Layers3 size={25} />
            <h3>A place for your next good idea.</h3>
            <p>
              Choose a folder. Scout and your bots can work with files there, and each workspace
              keeps its own chats.
            </p>
          </div>
          {error && (
            <div role="alert" className="ai-alert">
              {error}
            </div>
          )}
          <label>
            Workspace name
            <input
              value={name}
              disabled={busy}
              required
              maxLength={60}
              placeholder="e.g. My next project"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Workspace folder
            <div className="workspace-folder-input">
              <input
                value={folder}
                disabled={busy}
                required
                maxLength={2000}
                placeholder={
                  window.mukai
                    ? 'Choose a folder on your computer'
                    : 'Enter an absolute local folder path'
                }
                onChange={(event) => setFolder(event.target.value)}
              />
              {window.mukai && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => void choose()}
                >
                  <FolderOpen size={16} />
                  Browse
                </button>
              )}
            </div>
            <small>
              {window.mukai
                ? 'Select an existing folder or create one in the folder picker.'
                : 'The browser preview uses a local path. The desktop app includes a native folder picker.'}
            </small>
          </label>
          <p className="ai-caption">
            File tools stay inside this folder. Your provider connections are available across
            workspaces.
          </p>
        </div>
        <div className="modal-footer">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={busy || !name.trim() || !folder.trim()}
          >
            {busy ? 'Saving…' : workspace ? 'Connect folder' : 'Create workspace'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
