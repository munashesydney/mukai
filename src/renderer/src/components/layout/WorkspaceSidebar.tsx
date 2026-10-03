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
  FileCode2,
  Webhook,
  BookOpen,
} from 'lucide-react';
import { useState } from 'react';
import type { Bot, Workspace } from '../../../../shared/ai';
import type { Location, Space, DialogKind } from '../../features/workspace/types';
import type { Pursuit } from '../../../../shared/pursuits';
import { Avatar } from '../ui/Avatar';
import { IconButton } from '../ui/IconButton';
import type { Conversation } from '../../../../shared/conversations';
import { BotConversationsSidebar } from '../../features/ai/BotConversationsSidebar';

export function WorkspaceSidebar({
  location,
  spaces,
  pursuits,
  pursuitsLoading = false,
  pursuitsError = '',
  onSelect,
  onDialog,
  onSettings,
  collapsed,
  bots,
  botConversations,
  onCreateConversation,
  workspace,
  workspaces,
  onWorkspace,
  onCreateWorkspace,
}: {
  location: Location;
  spaces: Space[];
  pursuits: Pursuit[];
  pursuitsLoading?: boolean;
  pursuitsError?: string;
  onSelect: (location: Location) => void;
  onDialog: (dialog: DialogKind) => void;
  onSettings: () => void;
  collapsed: boolean;
  bots: Bot[];
  botConversations: Conversation[];
  onCreateConversation: (botId: string) => Promise<void>;
  workspace?: Workspace;
  workspaces: Workspace[];
  onWorkspace: (id: string) => void;
  onCreateWorkspace: () => void;
}) {
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [directOpen, setDirectOpen] = useState(true);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const isSelected = (item: string) => location.item === item;
  const pausedPursuits = pursuits.filter((pursuit) => pursuit.status === 'paused');
  const unpausedPursuits = pursuits.filter((pursuit) => pursuit.status !== 'paused');
  const inMotion = pursuits.filter(
    (pursuit) => pursuit.status !== 'paused' && pursuit.status !== 'completed',
  );
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
                onSettings();
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
            {!!inMotion.length && (
              <>
                <div className="sidebar-section-heading plain-heading">
                  <span>In motion</span>
                  <Target size={14} />
                </div>
                {inMotion.map((pursuit) => (
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
            <BotConversationsSidebar
              bots={bots}
              conversations={botConversations}
              location={location}
              onSelect={onSelect}
              onCreate={onCreateConversation}
            />
          </>
        )}
        {location.section === 'pursuits' && (
          <>
            <div className="sidebar-title">
              <h2>Pursuits</h2>
            </div>
            {!pursuits.length && (pursuitsLoading || pursuitsError) && (
              <p className="sidebar-empty">
                {pursuitsLoading ? 'Loading pursuits…' : 'Couldn’t load pursuits.'}
              </p>
            )}
            {!pursuits.length && !pursuitsLoading && !pursuitsError && (
              <div className="sidebar-empty">
                <Target size={22} strokeWidth={1.5} aria-hidden="true" />
                <strong>No pursuits yet</strong>
                <p>Ask a bot to work toward a goal on a schedule. Its pursuits will appear here.</p>
                <button
                  className="sidebar-empty-action"
                  onClick={() => onSelect({ section: 'bots', item: bots[0]?.id || '' })}
                >
                  {bots.length ? 'Talk to a bot' : 'Go to bots'} <ArrowUpRight size={14} />
                </button>
              </div>
            )}
            <div className="sidebar-group">
              {unpausedPursuits.map((p) => (
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
            {!!pausedPursuits.length && (
              <>
                <div className="sidebar-section-heading plain-heading">
                  <span>Paused</span>
                  <span className="section-rule" />
                </div>
                {pausedPursuits.map((p) => (
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
          </>
        )}
        {location.section === 'tools' && (
          <>
            <div className="sidebar-title">
              <h2>Tools</h2>
              <Puzzle size={18} />
            </div>
            <button
              className={`sidebar-row ${isSelected('workspace-tools') ? 'is-selected' : ''}`}
              onClick={() => onSelect({ section: 'tools', item: 'workspace-tools' })}
            >
              <Puzzle size={18} />
              <span>Workspace tools</span>
            </button>
            <button
              className={`sidebar-row ${isSelected('custom-tools') ? 'is-selected' : ''}`}
              onClick={() => onSelect({ section: 'tools', item: 'custom-tools' })}
            >
              <FileCode2 size={18} />
              <span>Custom tools</span>
            </button>
            <button
              className={`sidebar-row ${isSelected('custom-routes') ? 'is-selected' : ''}`}
              onClick={() => onSelect({ section: 'tools', item: 'custom-routes' })}
            >
              <Webhook size={18} />
              <span>Routes</span>
            </button>
            <button
              className={`sidebar-row ${isSelected('skills') ? 'is-selected' : ''}`}
              onClick={() => onSelect({ section: 'tools', item: 'skills' })}
            >
              <BookOpen size={18} />
              <span>Skills</span>
            </button>
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
