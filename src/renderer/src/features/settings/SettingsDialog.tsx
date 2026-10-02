import { useState } from 'react';
import { Check, Layers3, Palette, Settings2, KeyRound } from 'lucide-react';
import { Modal } from '../../components/ui/Modal';
import { Brand } from '../../components/ui/Brand';
import { useTheme } from '../appearance/useTheme';
import { AppearancePanel } from './AppearancePanel';
import { WorkspacePanel } from './WorkspacePanel';
import { ProvidersPanel } from './ProvidersPanel';

const sections = [
  { id: 'workspace', label: 'Workspace', icon: Layers3 },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'providers', label: 'Providers', icon: KeyRound },
] as const;
type SettingsSection = (typeof sections)[number]['id'];

export function SettingsDialog({
  onClose,
  initialSection = 'workspace',
  onProvidersChanged = () => {},
}: {
  onClose: () => void;
  initialSection?: SettingsSection;
  onProvidersChanged?: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const { storageAvailable } = useTheme();
  return (
    <Modal title="Settings" className="settings-modal" onClose={onClose}>
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
                onClick={() => setSection(id)}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === 'ArrowDown') next = (index + 1) % sections.length;
                  else if (event.key === 'ArrowUp')
                    next = (index - 1 + sections.length) % sections.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = sections.length - 1;
                  else return;
                  event.preventDefault();
                  setSection(sections[next].id);
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
            <WorkspacePanel />
          ) : section === 'appearance' ? (
            <AppearancePanel />
          ) : (
            <ProvidersPanel onChanged={onProvidersChanged} />
          )}
        </div>
      </div>
      <div className="modal-footer settings-footer">
        <span>
          {storageAvailable ? <Check size={13} /> : <Settings2 size={13} />}
          {storageAvailable
            ? 'Preferences are saved on this device'
            : 'Changes apply to this session'}
        </span>
        <button className="button button--primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
