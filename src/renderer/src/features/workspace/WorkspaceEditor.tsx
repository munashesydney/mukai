import { useEffect, useState } from 'react';
import { FolderOpen, Layers3 } from 'lucide-react';
import type { Workspace } from '../../../../shared/ai';
import { Modal } from '../../components/ui/Modal';
import { workspaceService } from '../../services/workspaceService';
import { errorText } from '../../utils/errors';
import type { QemuSetup } from '../../../../shared/computer';

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
  const [computer, setComputer] = useState<'local' | 'qemu'>('local');
  const [setup, setSetup] = useState<QemuSetup>();
  const [setupError, setSetupError] = useState('');
  useEffect(() => {
    let active = true;
    void workspaceService
      .computerSetup()
      .then((value) => {
        if (active) setSetup(value);
      })
      .catch((error) => {
        if (active) setSetup({ available: false, reason: errorText(error) });
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (computer !== 'qemu') return;
    let active = true;
    const refresh = () =>
      workspaceService
        .computerSetup()
        .then((value) => {
          if (active) setSetup(value);
        })
        .catch((error) => {
          if (active) setSetupError(errorText(error));
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [computer]);
  async function install() {
    setSetupError('');
    try {
      setSetup(await workspaceService.installComputer());
    } catch (error) {
      setSetupError(errorText(error));
    }
  }
  function selectComputer(value: 'local' | 'qemu') {
    setComputer(value);
    if (value === 'qemu' && !setup?.available && (!setup?.phase || setup.phase === 'idle'))
      void install();
  }
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
          : workspaceService.create({ name, folder: computer === 'qemu' ? '' : folder, computer })),
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
            <p>Choose where your bots work. Each workspace keeps its own chats and files.</p>
          </div>
          {error && (
            <div role="alert" className="ai-alert">
              {error}
            </div>
          )}
          {!workspace && (
            <label>
              Computer
              <select
                value={computer}
                disabled={busy}
                onChange={(event) => selectComputer(event.target.value as 'local' | 'qemu')}
              >
                <option value="local">Local machine</option>
                <option value="qemu">Linux VM (automatic setup · preview)</option>
              </select>
              <small>
                {computer === 'local'
                  ? 'Commands and browser tools run on this computer.'
                  : 'Bots share a persistent Linux VM with 2 CPUs and 2 GiB RAM. Files stay on its disk. Headless browser; custom tools and routes are unavailable in v1.'}
              </small>
              {computer === 'qemu' && (
                <small role="status" aria-live="polite">
                  {!setup
                    ? 'Checking VM setup…'
                    : setup.available
                      ? 'Linux is ready. The VM starts when a bot first uses it.'
                      : setup.message || setup.reason}
                </small>
              )}
              {computer === 'qemu' && setup?.phase === 'downloading' && setup.totalBytes && (
                <progress
                  aria-label="Downloading Linux"
                  max={setup.totalBytes}
                  value={setup.downloadedBytes || 0}
                />
              )}
              {computer === 'qemu' && (!setup || !setup.available) && (
                <small>
                  First use installs QEMU and downloads Linux, Node.js and Chrome. Allow several
                  minutes and at least 12 GiB of free disk space. Your OS may ask for administrator
                  approval.
                </small>
              )}
              {computer === 'qemu' &&
                setup &&
                !setup.available &&
                ['idle', 'failed', 'reboot-required'].includes(setup.phase || 'idle') && (
                  <button type="button" className="button" onClick={() => void install()}>
                    {setup.phase === 'idle' ? 'Set up Linux VM' : 'Retry setup'}
                  </button>
                )}
              {computer === 'qemu' && setupError && <small role="alert">{setupError}</small>}
            </label>
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
          {(workspace || computer === 'local') && (
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
          )}
          <p className="ai-caption">
            {computer === 'qemu'
              ? 'VM files can be downloaded from file artifacts. No host folders are mounted.'
              : 'File tools stay inside this folder.'}{' '}
            Your provider connections are available across workspaces.
          </p>
        </div>
        <div className="modal-footer">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={
              busy || !name.trim() || (computer === 'local' ? !folder.trim() : !setup?.available)
            }
          >
            {busy ? 'Saving…' : workspace ? 'Connect folder' : 'Create workspace'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
