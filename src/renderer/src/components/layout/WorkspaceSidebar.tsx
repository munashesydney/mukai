import {
  ChevronDown,
  ChevronRight,
  Layers3,
  Plus,
  Target,
  ArrowUpRight,
  Sunrise,
  Check,
  Puzzle,
} from 'lucide-react';
import { useState } from 'react';
import type { Bot, Workspace } from '../../../../shared/ai';
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
  bots,
  workspace,
  workspaces,
  onWorkspace,
  onCreateWorkspace,
}: {
  location: Location;
  spaces: Space[];
  pursuits: Pursuit[];
  onSelect: (location: Location) => void;
  onDialog: (dialog: DialogKind) => void;
  collapsed: boolean;
  bots: Bot[];
  workspace?: Workspace;
  workspaces: Workspace[];
  onWorkspace: (id: string) => void;
  onCreateWorkspace: () => void;
}) {
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [directOpen, setDirectOpen] = useState(true);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const isSelected = (item: string) => location.item === item;
  const botRow = (bot: (typeof bots)[number]) => (
    <button
      key={bot.id}
      className={`sidebar-row bot-row ${isSelected(bot.id) ? 'is-selected' : ''}`}
      onClick={() => onSelect({ section: 'bots', item: bot.id })}
    >
      <Avatar person={bot.avatar} size="xs" />
      <span>{bot.name}</span>
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
            {workspace?.name || 'Your workspace'}
            <span className="workspace-subtitle">A little momentum, every day.</span>
          </span>
          <ChevronDown size={16} />
        </button>
        {workspaceMenu && (
          <div className="workspace-menu">
            {workspaces.map((item) => (
              <button
                key={item.id}
                className="workspace-choice"
                onClick={() => {
                  setWorkspaceMenu(false);
                  onWorkspace(item.id);
                }}
              >
                <span className="workspace-mini">{item.name[0]?.toUpperCase()}</span>
                <span>
                  {item.name}
                  <small>{item.folder ? 'Folder workspace' : 'Personal workspace'}</small>
                </span>
                {item.id === workspace?.id && <Check size={15} />}
              </button>
            ))}
            <button
              onClick={() => {
                setWorkspaceMenu(false);
                onCreateWorkspace();
              }}
            >
              <Plus size={15} />
              Create workspace
            </button>
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
                    <Layers3 size={18} strokeWidth={1.6} />
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
                <span>Your bots</span>
              </button>
            </div>
            {directOpen && <div className="sidebar-group">{bots.map(botRow)}</div>}
            {!!pursuits.length && (
              <>
                <div className="sidebar-section-heading plain-heading">
                  <span>In motion</span>
                  <Target size={14} />
                </div>
                {pursuits
                  .filter((pursuit) => !pursuit.paused)
                  .map((pursuit) => (
                    <button
                      key={pursuit.id}
                      className="sidebar-row pursuit-row"
                      onClick={() => onSelect({ section: 'pursuits', item: pursuit.id })}
                    >
                      <Target size={18} />
                      <span>{pursuit.name}</span>
                    </button>
                  ))}
              </>
            )}
          </>
        )}
        {location.section === 'bots' && (
          <>
            <div className="sidebar-title">
              <h2>Bots</h2>
              <IconButton label="Create a bot" onClick={() => onDialog('create-bot')}>
                <Plus size={18} />
              </IconButton>
            </div>
            <div className="sidebar-group">{bots.map(botRow)}</div>
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
              <Puzzle size={18} />
            </div>
            <div className="sidebar-row is-selected">
              <Puzzle size={18} />
              <span>Workspace tools</span>
            </div>
          </>
        )}
      </div>
      <div className="sidebar-footer">
        <div className="wake-icon">
          <Sunrise size={15} />
        </div>
        <div>
          <span>Mukai means “wake up” in Shona.</span>
        </div>
      </div>
    </aside>
  );
}
