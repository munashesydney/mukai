import {
  Hash,
  ChevronDown,
  MoreHorizontal,
  PanelRight,
  Bookmark,
  Target,
  CircleHelp,
  SlidersHorizontal,
} from 'lucide-react';
import { useState } from 'react';
import { Avatar } from '../../components/ui/Avatar';
import { IconButton } from '../../components/ui/IconButton';
import { agents } from '../workspace/data';
import type { AgentId, DialogKind, Location, Space, Pursuit } from '../workspace/types';

export function ConversationHeader({
  location,
  space,
  pursuit,
  tab,
  onTab,
  detailsOpen,
  onDetails,
  onDialog,
  onSaved,
}: {
  location: Location;
  space?: Space;
  pursuit?: Pursuit;
  tab: string;
  onTab: (tab: string) => void;
  detailsOpen: boolean;
  onDetails: () => void;
  onDialog: (dialog: DialogKind) => void;
  onSaved: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const agent = agents.find((agent) => agent.id === location.item);
  return (
    <header className="conversation-header">
      <div className="conversation-heading">
        <div className="heading-identity">
          {agent ? (
            <Avatar person={agent.id as AgentId} size="md" />
          ) : pursuit ? (
            <span className="heading-pursuit-icon">
              <Target size={23} />
            </span>
          ) : (
            <span className="heading-hash">
              <Hash size={24} strokeWidth={1.8} />
            </span>
          )}
          <div>
            <h1>
              {agent?.name ?? pursuit?.name ?? space?.name}
              <ChevronDown size={15} />
            </h1>
            <p>
              {agent?.role ??
                (pursuit
                  ? `${agents.find((a) => a.id === pursuit.agent)?.name} is keeping this moving`
                  : space?.description)}
            </p>
          </div>
        </div>
        <div className="header-actions">
          {agent ? (
            <button className="button button--small" onClick={() => onDialog('settings')}>
              <SlidersHorizontal size={14} /> Customize
            </button>
          ) : pursuit ? (
            <span className={`status-label ${pursuit.paused ? 'status-label--paused' : ''}`}>
              <i />
              {pursuit.paused ? 'Paused' : 'In motion'}
            </span>
          ) : (
            <button
              className="member-stack"
              onClick={onDetails}
              aria-label="View the agents in this space"
            >
              <Avatar person="atlas" size="xs" />
              <Avatar person="nova" size="xs" />
              <Avatar person="scout" size="xs" />
              <span>3</span>
            </button>
          )}
          <span className="header-action-divider" />
          <IconButton
            label="Toggle conversation details"
            className={detailsOpen ? 'is-on' : ''}
            onClick={onDetails}
          >
            <PanelRight size={18} />
          </IconButton>
          <div className="header-menu-anchor">
            <IconButton
              label="More conversation options"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-expanded={menuOpen}
            >
              <MoreHorizontal size={21} />
            </IconButton>
            {menuOpen && (
              <div className="popover-menu">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onSaved();
                  }}
                >
                  <Bookmark size={15} />
                  Saved messages
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onDialog('details');
                  }}
                >
                  <CircleHelp size={15} />
                  Conversation details
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="conversation-tabs" role="tablist" aria-label="Conversation views">
        {['Messages', 'Files', 'Activity'].map((label) => (
          <button
            key={label}
            role="tab"
            aria-selected={tab === label}
            className={tab === label ? 'is-active' : ''}
            onClick={() => onTab(label)}
          >
            {label}
            {label === 'Files' && <span className="tab-count">1</span>}
          </button>
        ))}
        <span className="channel-privacy">
          {agent
            ? 'Direct conversation'
            : pursuit
              ? 'One step at a time'
              : 'A space to move things forward'}
        </span>
      </div>
    </header>
  );
}
