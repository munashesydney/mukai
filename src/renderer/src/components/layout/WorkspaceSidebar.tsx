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
import { IconButton } from '../ui/IconButton';
import type { Conversation } from '../../../../shared/conversations';
import { BotConversationsSidebar } from '../../features/ai/BotConversationsSidebar';
import { BotPairConversationsSidebar } from '../../features/ai/BotPairConversationsSidebar';
import { PopupMenu } from '../ui/PopupMenu';

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
  botPairConversations,
  botPairLoading,
  botPairError,
  onRefreshBotPairs,
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
  botPairConversations: Conversation[];
  botPairLoading: boolean;
  botPairError: string;
  onRefreshBotPairs: () => void;
  onCreateConversation: (botId: string) => Promise<void>;
  workspace?: Workspace;
  workspaces: Workspace[];
  onWorkspace: (id: string) => void;
  onCreateWorkspace: () => void;
}) {
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [directOpen, setDirectOpen] = useState(true);
  const isSelected = (item: string) => location.item === item;
  const pausedPursuits = pursuits.filter((pursuit) => pursuit.status === 'paused');
  const unpausedPursuits = pursuits.filter((pursuit) => pursuit.status !== 'paused');
  const inMotion = pursuits.filter(
    (pursuit) => pursuit.status !== 'paused' && pursuit.status !== 'completed',
  );
  return (
    <aside
      className={`workspace-sidebar ${collapsed ? 'is-collapsed' : ''}`}
      aria-label="Workspace navigation"
    >
      <PopupMenu
        className="workspace-switcher"
        menuClassName="workspace-picker-menu"
        label="Choose workspace"
        title="Your workspaces"
        footer="A little momentum, every day."
        trigger={
          <>
            <span>
              {workspace?.name || 'Your workspace'}
              <span className="workspace-subtitle">A little momentum, every day.</span>
            </span>
            <ChevronDown size={16} />
          </>
        }
      >
        {(close) => (
          <>
            {workspaces.map((item) => (
              <button
                key={item.id}
                className="workspace-choice"
                role="menuitemradio"
                aria-checked={item.id === workspace?.id}
                onClick={() => {
                  close();
                  onWorkspace(item.id);
                }}
              >
                <span className="workspace-mini">{item.name[0]?.toUpperCase()}</span>
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.folder ? 'Folder workspace' : 'Personal workspace'}</small>
                </span>
                {item.id === workspace?.id && <Check size={15} />}
              </button>
            ))}
            <button
              role="menuitem"
              onClick={() => {
                close();
                onCreateWorkspace();
              }}
            >
              <Plus size={15} />
              <span>
                <strong>Create workspace</strong>
              </span>
            </button>
            <button
              role="menuitem"
              disabled={!bots.length}
              onClick={() => {
                close();
                onSettings();
              }}
            >
              <span>
                <strong>Workspace settings</strong>
              </span>
              <ArrowUpRight size={14} />
            </button>
          </>
        )}
      </PopupMenu>
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
                <span>Bot conversations</span>
              </button>
            </div>
            {directOpen && (
              <BotPairConversationsSidebar
                bots={bots}
                conversations={botPairConversations}
                location={location}
                onSelect={onSelect}
                loading={botPairLoading}
                error={botPairError}
                onRefresh={onRefreshBotPairs}
              />
            )}
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
            {!bots.length && (
              <div className="sidebar-empty">
                <strong>No bots yet</strong>
                <p>Add your first bot to start a conversation and lead your workspace.</p>
                <button className="sidebar-empty-action" onClick={() => onDialog('create-bot')}>
                  Add your first bot <ArrowUpRight size={14} />
                </button>
              </div>
            )}
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
      {location.section === 'bots' && (
        <button
          className={`sidebar-hierarchy-link ${location.item === 'hierarchy' ? 'is-active' : ''}`}
          aria-current={location.item === 'hierarchy' ? 'page' : undefined}
          onClick={() => onSelect({ section: 'bots', item: 'hierarchy' })}
        >
          Bot Hierarchy <ArrowUpRight size={15} />
        </button>
      )}
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
