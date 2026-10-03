import { Layers3, Palette, KeyRound, Brain } from 'lucide-react';
import { Brand } from '../../components/ui/Brand';
import { AppearancePanel } from './AppearancePanel';
import { WorkspacePanel } from './WorkspacePanel';
import { ProvidersPanel } from './ProvidersPanel';
import { EnvironmentPanel } from './EnvironmentPanel';
import { MemoryPanel } from './MemoryPanel';
import type { Workspace } from '../../../../shared/ai';
import type { SettingsSection } from '../workspace/types';

const sections = [
  { id: 'workspace', label: 'Workspace', icon: Layers3 },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'providers', label: 'Providers', icon: KeyRound },
  { id: 'environment', label: 'Environment variables', icon: KeyRound },
  { id: 'memory', label: 'Memory', icon: Brain },
] as const;

export function SettingsPage({
  section,
  onSection,
  onProvidersChanged = () => {},
  workspace,
  onConnectFolder,
}: {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onProvidersChanged?: () => void;
  workspace?: Workspace;
  onConnectFolder?: () => void;
}) {
  return (
    <main className="settings-page" aria-label="Settings">
      <div className="settings-layout">
        <aside className="settings-navigation">
          <div className="settings-nav-label">YOUR WORKSPACE</div>
          <div role="tablist" aria-label="Settings sections" aria-orientation="vertical">
            {sections.map(({ id, label, icon: Icon }, index) => (
              <button
                key={id}
                id={`settings-tab-${id}`}
                role="tab"
                aria-selected={section === id}
                aria-controls={`settings-panel-${id}`}
                tabIndex={section === id ? 0 : -1}
                className={`settings-nav-item ${section === id ? 'is-selected' : ''}`}
                onClick={() => onSection(id)}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === 'ArrowDown') next = (index + 1) % sections.length;
                  else if (event.key === 'ArrowUp')
                    next = (index - 1 + sections.length) % sections.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = sections.length - 1;
                  else return;
                  event.preventDefault();
                  onSection(sections[next].id);
                  document.getElementById(`settings-tab-${sections[next].id}`)?.focus();
                }}
              >
                <Icon size={17} strokeWidth={1.7} />
                {label}
              </button>
            ))}
          </div>
          <div className="settings-nav-footer">
            <Brand />
            <span>Your ideas. Your pace.</span>
            <small>Version 0.1.0</small>
          </div>
        </aside>
        <div
          className="settings-panel"
          role="tabpanel"
          id={`settings-panel-${section}`}
          aria-labelledby={`settings-tab-${section}`}
          tabIndex={0}
        >
          {section === 'workspace' ? (
            <WorkspacePanel workspace={workspace} onConnectFolder={onConnectFolder} />
          ) : section === 'appearance' ? (
            <AppearancePanel />
          ) : section === 'memory' ? (
            <MemoryPanel
              key={workspace?.id || 'default'}
              workspaceId={workspace?.id || 'default'}
            />
          ) : section === 'environment' ? (
            <EnvironmentPanel
              key={workspace?.id || 'default'}
              workspaceId={workspace?.id || 'default'}
            />
          ) : (
            <ProvidersPanel onChanged={onProvidersChanged} />
          )}
        </div>
      </div>
    </main>
  );
}
