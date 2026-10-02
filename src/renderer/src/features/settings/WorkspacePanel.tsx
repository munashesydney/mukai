import { useEffect, useState } from 'react';
import { Cpu, HardDrive, RefreshCw, ShieldCheck, Terminal } from 'lucide-react';
import { Avatar } from '../../components/ui/Avatar';
import type { HealthResponse } from '../../../../shared/contracts';
import { getHealth } from '../../services/healthService';

export function WorkspacePanel() {
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
          <strong>Munashe’s workspace</strong>
          <span>Personal · Local to this device</span>
        </div>
        <span className="settings-account-badge">M</span>
      </div>
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
      <div className="settings-privacy-note">
        <ShieldCheck size={15} />
        <span>Runs locally. Your workspace stays on this device.</span>
      </div>
    </>
  );
}
