import {
  ChevronDown,
  ChevronRight,
  Hash,
  Plus,
  Target,
  ArrowUpRight,
  Sparkles,
  Check,
  Plug,
} from 'lucide-react';
import { useState } from 'react';
import { agents } from '../../features/workspace/data';
import type { Location, Space, Pursuit, DialogKind } from '../../features/workspace/types';
import { Avatar } from '../ui/Avatar';
import { IconButton } from '../ui/IconButton';

export function WorkspaceSidebar({
  location,
  spaces,
  pursuits,
  onSelect,
  onDialog,
  collapsed,
}: {
  location: Location;
  spaces: Space[];
  pursuits: Pursuit[];
  onSelect: (location: Location) => void;
  onDialog: (dialog: DialogKind) => void;
  collapsed: boolean;
}) {
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [directOpen, setDirectOpen] = useState(true);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const isSelected = (item: string) => location.item === item;
  const agentRow = (agent: (typeof agents)[number]) => (
    <button
      key={agent.id}
      className={`sidebar-row agent-row ${isSelected(agent.id) ? 'is-selected' : ''}`}
      onClick={() => onSelect({ section: 'agents', item: agent.id })}
    >
      <Avatar person={agent.id} size="xs" />
      <span>{agent.name}</span>
      <i className="agent-online" />
    </button>
  );
  return (
    <aside
      className={`workspace-sidebar ${collapsed ? 'is-collapsed' : ''}`}
      aria-label="Workspace navigation"
    >
      <div className="workspace-switcher">
        <button onClick={() => setWorkspaceMenu(!workspaceMenu)} aria-expanded={workspaceMenu}>
          <span>
            Munashe’s workspace
            <span className="workspace-subtitle">A little momentum, every day.</span>
          </span>
          <ChevronDown size={16} />
        </button>
        {workspaceMenu && (
          <div className="workspace-menu">
            <div>
              <span className="workspace-mini">M</span>
              <span>
                Munashe’s workspace<small>Personal workspace</small>
              </span>
              <Check size={15} />
            </div>
            <button
              onClick={() => {
                setWorkspaceMenu(false);
                onDialog('settings');
              }}
            >
              Workspace settings <ArrowUpRight size={14} />
            </button>
          </div>
        )}
      </div>
      <div className="sidebar-scroll">
        {location.section === 'spaces' && (
          <>
            <div className="sidebar-section-heading">
              <button onClick={() => setSpacesOpen(!spacesOpen)} aria-expanded={spacesOpen}>
                {spacesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span>Spaces</span>
              </button>
              <IconButton label="Create a space" onClick={() => onDialog('create-space')}>
                <Plus size={15} />
              </IconButton>
            </div>
            {spacesOpen && (
              <div className="sidebar-group">
                {spaces.map((space) => (
                  <button
                    key={space.id}
                    className={`sidebar-row ${isSelected(space.id) ? 'is-selected' : ''}`}
                    onClick={() => onSelect({ section: 'spaces', item: space.id })}
                  >
                    <Hash size={18} strokeWidth={1.6} />
                    <span>{space.name}</span>
                    {space.unread && <span className="unread-count">{space.unread}</span>}
                  </button>
                ))}
                <button
                  className="sidebar-row sidebar-add"
                  onClick={() => onDialog('create-space')}
                >
                  <Plus size={17} />
                  <span>Add a space</span>
                </button>
              </div>
            )}
            <div className="sidebar-section-heading">
              <button onClick={() => setDirectOpen(!directOpen)} aria-expanded={directOpen}>
                {directOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span>Your agents</span>
              </button>
            </div>
            {directOpen && <div className="sidebar-group">{agents.map(agentRow)}</div>}
            <div className="sidebar-section-heading plain-heading">
              <span>In motion</span>
              <Target size={14} />
            </div>
            <button
              className="sidebar-row pursuit-row"
              onClick={() => onSelect({ section: 'pursuits', item: 'grow-mrr' })}
            >
              <Target size={18} />
              <span>Grow MRR to $2,000</span>
            </button>
          </>
        )}
        {location.section === 'agents' && (
          <>
            <div className="sidebar-title">
              <h2>Agents</h2>
              <IconButton label="Create an agent" onClick={() => onDialog('create-agent')}>
                <Plus size={18} />
              </IconButton>
            </div>
            <div className="sidebar-group">{agents.map(agentRow)}</div>
          </>
        )}
        {location.section === 'pursuits' && (
          <>
            <div className="sidebar-title">
              <h2>Pursuits</h2>
              <IconButton label="Create a pursuit" onClick={() => onDialog('create-pursuit')}>
                <Plus size={18} />
              </IconButton>
            </div>
            <div className="sidebar-group">
              {pursuits
                .filter((p) => !p.paused)
                .map((p) => (
                  <button
                    key={p.id}
                    className={`sidebar-row pursuit-row ${isSelected(p.id) ? 'is-selected' : ''}`}
                    onClick={() => onSelect({ section: 'pursuits', item: p.id })}
                  >
                    <Target size={18} />
                    <span>{p.name}</span>
                  </button>
                ))}
            </div>
            <div className="sidebar-section-heading plain-heading">
              <span>Paused</span>
              <span className="section-rule" />
            </div>
            {pursuits
              .filter((p) => p.paused)
              .map((p) => (
                <button
                  key={p.id}
                  className={`sidebar-row pursuit-row ${isSelected(p.id) ? 'is-selected' : ''}`}
                  onClick={() => onSelect({ section: 'pursuits', item: p.id })}
                >
                  <Target size={18} />
                  <span>{p.name}</span>
                </button>
              ))}
          </>
        )}
        {location.section === 'tools' && (
          <>
            <div className="sidebar-title">
              <h2>Tools</h2>
              <Plug size={18} />
            </div>
            <button className="sidebar-row is-selected">
              <PuzzleIcon />
              <span>All integrations</span>
              <span className="section-count">6</span>
            </button>
          </>
        )}
      </div>
      <div className="sidebar-footer">
        <div className="wake-icon">
          <Sparkles size={15} />
        </div>
        <div>
          <span>Mukai means “wake up” in Shona.</span>
        </div>
      </div>
    </aside>
  );
}
function PuzzleIcon() {
  return <Plug size={18} />;
}
