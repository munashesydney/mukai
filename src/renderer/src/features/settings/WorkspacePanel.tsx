import { DeleteWorkspace } from './DeleteWorkspace';
import { useEffect, useState } from 'react';
import {
  Cpu,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Monitor,
  MemoryStick,
} from 'lucide-react';
import { Avatar } from '../../components/ui/Avatar';
import type { HealthResponse } from '../../../../shared/contracts';
import { getHealth } from '../../services/healthService';
import type { Workspace } from '../../../../shared/ai';
import { workspaceService } from '../../services/workspaceService';
import {
  DEFAULT_VM_RESOURCES,
  vmResourcesSchema,
  type ComputerStatus,
  type VmResources,
} from '../../../../shared/computer';
import { errorText } from '../../utils/errors';

export function WorkspacePanel({
  workspace,
  onConnectFolder,
  onDelete,
}: {
  workspace?: Workspace;
  onConnectFolder?: () => void;
  onDelete?: (id: string, name: string) => Promise<void>;
}) {
  const [health, setHealth] = useState<HealthResponse>();
  const [status, setStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setStatus('checking');
    getHealth()
      .then((result) => {
        if (!cancelled) {
          setHealth(result);
          setStatus('online');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('offline');
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);
  return (
    <>
      <div className="settings-panel-heading">
        <span className="settings-eyebrow">THE PLACE YOU WORK FROM</span>
        <h3>Workspace</h3>
        <p>Your harness, at a glance.</p>
      </div>
      <div className="settings-account-card">
        <Avatar person="munashe" size="md" />
        <div>
          <strong>{workspace?.name || 'Your workspace'}</strong>
          <span>Personal · Local to this device</span>
        </div>
        <span className="settings-account-badge">{workspace?.name[0]?.toUpperCase() || 'M'}</span>
      </div>
      {workspace?.computer === 'qemu' && !workspace.deleting && (
        <VmComputer key={workspace.id} workspace={workspace} />
      )}
      {workspace && workspace.computer !== 'qemu' && (
        <section className="settings-card workspace-folder-card">
          <h4>Workspace folder</h4>
          <p>{workspace.folder || 'Connect a folder to let your bots work with local files.'}</p>
          {!workspace.folder && !workspace.deleting && onConnectFolder && (
            <button className="button" onClick={onConnectFolder}>
              Connect folder
            </button>
          )}
        </section>
      )}
      <section className="settings-card">
        <div className="settings-card-heading">
          <span className="settings-card-icon">
            <Cpu size={18} />
          </span>
          <div>
            <h4>Local runtime</h4>
            <p>The foundation keeping Mukai awake.</p>
          </div>
        </div>
        <dl className="settings-data">
          <div>
            <dt>Application version</dt>
            <dd>
              0.1.0 <span className="settings-inline-badge">UI preview</span>
            </dd>
          </div>
          <div>
            <dt>Environment</dt>
            <dd>{window.mukai ? `Electron · ${window.mukai.platform}` : 'Browser preview'}</dd>
          </div>
          <div>
            <dt>
              <HardDrive size={13} /> Workspace storage
            </dt>
            <dd>On this device</dd>
          </div>
        </dl>
      </section>
      <section className="settings-card">
        <div className="settings-card-heading">
          <span className="settings-card-icon">
            <Terminal size={18} />
          </span>
          <div>
            <h4>Node service</h4>
            <p>A small service. Ready for what’s next.</p>
          </div>
          <button
            className={`settings-refresh ${status === 'checking' ? 'is-checking' : ''}`}
            onClick={() => setRefresh((previous) => previous + 1)}
            disabled={status === 'checking'}
            aria-label="Refresh service health"
            title="Refresh service health"
          >
            <RefreshCw size={15} />
          </button>
        </div>
        <dl className="settings-data">
          <div>
            <dt>Health endpoint</dt>
            <dd>
              <code>GET /health</code>
            </dd>
          </div>
          <div>
            <dt>Connection</dt>
            <dd>
              <span className={`service-badge service-badge--${status}`}>
                <i />
                {status === 'checking'
                  ? 'Checking…'
                  : status === 'online'
                    ? 'Healthy'
                    : 'Not running'}
              </span>
            </dd>
          </div>
          {health && status === 'online' && (
            <div>
              <dt>Service</dt>
              <dd>
                <code>{health.service}</code>
              </dd>
            </div>
          )}
        </dl>
        {status === 'offline' && (
          <div className="settings-runtime-note">
            Start <code>npm run dev:server</code> to check the service in the browser preview.
          </div>
        )}
      </section>
      {workspace && onDelete && (
        <DeleteWorkspace key={workspace.id} workspace={workspace} onDelete={onDelete} />
      )}
      <div className="settings-privacy-note">
        <ShieldCheck size={15} />
        <span>Runs locally. Your workspace stays on this device.</span>
      </div>
    </>
  );
}

function VmComputer({ workspace }: { workspace: Workspace }) {
  const [status, setStatus] = useState<ComputerStatus>();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<VmResources | null>(null);
  const [memory, setMemory] = useState(String(DEFAULT_VM_RESOURCES.memoryMiB / 1024));
  const [cpus, setCpus] = useState(String(DEFAULT_VM_RESOURCES.vcpus));
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let initialized = false;
    const refresh = () =>
      workspaceService
        .computerStatus(workspace.id)
        .then((value) => {
          if (!active) return;
          setStatus(value);
          if (!initialized) {
            const resources =
              value.resources || workspace.computerResources || DEFAULT_VM_RESOURCES;
            setSaved(resources);
            setMemory(String(resources.memoryMiB / 1024));
            setCpus(String(resources.vcpus));
            initialized = true;
          }
        })
        .catch((error) => {
          if (active) setError(errorText(error));
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [workspace.id, workspace.computerResources]);
  const parsed = vmResourcesSchema.safeParse({
    memoryMiB: Number(memory) * 1024,
    vcpus: Number(cpus),
  });
  const changed =
    parsed.success &&
    saved !== null &&
    (parsed.data.memoryMiB !== saved.memoryMiB || parsed.data.vcpus !== saved.vcpus);
  const disabled = busy || saving || saved === null;
  async function saveResources() {
    if (!parsed.success || !changed || disabled) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const updated = await workspaceService.saveComputerResources(workspace.id, parsed.data);
      setSaved(updated.computerResources!);
      const next = await workspaceService.computerStatus(workspace.id);
      setStatus(next);
      setNotice(
        next.restartRequired
          ? 'Saved. Restart the VM when you’re ready to apply these resources.'
          : 'Saved. These resources will be used when the VM starts.',
      );
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  }
  async function control(action: 'start' | 'stop' | 'restart') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (action === 'restart') await workspaceService.controlComputer(workspace.id, 'stop');
      setStatus(
        await workspaceService.controlComputer(
          workspace.id,
          action === 'restart' ? 'start' : action,
        ),
      );
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card vm-settings-card">
      <div className="settings-card-heading">
        <span className="settings-card-icon">
          <Monitor size={18} />
        </span>
        <div>
          <h4>Linux computer</h4>
          <p>One computer, shared by this workspace’s bots.</p>
        </div>
        <span
          className={`service-badge service-badge--${status?.state === 'running' ? 'online' : 'checking'}`}
          role="status"
        >
          <i />
          {busy
            ? 'Working…'
            : status
              ? status.state[0].toUpperCase() + status.state.slice(1)
              : 'Checking…'}
        </span>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void saveResources();
        }}
      >
        <div className="vm-resource-fields">
          <div className="vm-resource-field">
            <label htmlFor="vm-memory">
              <MemoryStick size={15} />
              Memory
            </label>
            <div className="vm-resource-input">
              <input
                id="vm-memory"
                type="number"
                min="1"
                max="64"
                step="0.25"
                value={memory}
                disabled={disabled}
                aria-describedby="vm-memory-help"
                onChange={(event) => {
                  setMemory(event.target.value);
                  setNotice('');
                }}
              />
              <span>GB</span>
            </div>
            <p id="vm-memory-help">4 GB recommended for the desktop and Chrome.</p>
          </div>
          <div className="vm-resource-field">
            <label htmlFor="vm-cpus">
              <Cpu size={15} />
              Virtual CPUs
            </label>
            <div className="vm-resource-input">
              <input
                id="vm-cpus"
                type="number"
                min="1"
                max="32"
                step="1"
                value={cpus}
                disabled={disabled}
                aria-describedby="vm-cpus-help"
                onChange={(event) => {
                  setCpus(event.target.value);
                  setNotice('');
                }}
              />
              <span>vCPUs</span>
            </div>
            <p id="vm-cpus-help">2 by default. Increase for builds and parallel tasks.</p>
          </div>
        </div>
        <p className="vm-resource-help">
          Resources come from this device. Leave room for Mukai and your other apps.
        </p>
        {!parsed.success && (
          <p className="ai-alert" role="alert">
            Use 1–64 GB of memory in 0.25 GB steps and 1–32 whole virtual CPUs.
          </p>
        )}
        <div className="vm-resource-actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={disabled || !changed || !parsed.success}
          >
            {saving ? 'Saving…' : 'Save resources'}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => {
              setMemory(String(DEFAULT_VM_RESOURCES.memoryMiB / 1024));
              setCpus(String(DEFAULT_VM_RESOURCES.vcpus));
              setNotice('');
            }}
          >
            Use defaults
          </button>
        </div>
      </form>
      {status?.activeResources && (
        <p className="vm-active-resources">
          Currently allocated: {status.activeResources.memoryMiB / 1024} GB RAM ·{' '}
          {status.activeResources.vcpus} vCPUs
        </p>
      )}
      {status?.restartRequired && (
        <div className="vm-restart-note">
          <RefreshCw size={14} />
          <span>Restart required. Saved resources take effect on the next boot.</span>
        </div>
      )}
      {(error || status?.error) && (
        <p className="ai-alert" role="alert">
          {error || status?.error}
        </p>
      )}
      {notice && (
        <p className="ai-notice" role="status">
          {notice}
        </p>
      )}
      <div className="vm-lifecycle-actions">
        <button
          className="button"
          disabled={
            busy || saving || !status || status.state === 'starting' || status.state === 'running'
          }
          onClick={() => void control('start')}
        >
          {busy ? 'Please wait…' : 'Start VM'}
        </button>
        <button
          className="button"
          disabled={busy || saving || !status || status.state === 'stopped'}
          onClick={() => void control('stop')}
        >
          Stop VM
        </button>
        {status?.activeResources && (
          <button
            className="button"
            disabled={busy || saving || status.state === 'starting'}
            onClick={() => void control('restart')}
          >
            <RefreshCw size={13} />
            Restart VM
          </button>
        )}
      </div>
      <p className="vm-lifecycle-help">
        Stopping ends all running guest sessions. Files survive restarts. Bots start the VM
        automatically when they need it.
      </p>
    </section>
  );
}
