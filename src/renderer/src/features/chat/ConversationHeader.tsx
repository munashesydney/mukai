import {
  Hash,
  MoreHorizontal,
  PanelRight,
  Info,
  FileText,
  Activity,
  Bookmark,
  Target,
  CircleHelp,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menu.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);
  const agent = agents.find((agent) => agent.id === location.item);
  return (
    <header
      className={`conversation-header ${agent && tab === 'Messages' ? 'conversation-header--minimal' : ''}`}
    >
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
            <h1>{agent?.name ?? pursuit?.name ?? space?.name}</h1>
            {pursuit ? (
              <div className="pursuit-summary">
                <span className={`status-label ${pursuit.paused ? 'status-label--paused' : ''}`}>
                  <i />
                  {pursuit.paused ? 'Paused' : 'In motion'}
                </span>
                <span
                  className="pursuit-progress"
                  role="progressbar"
                  aria-label="Pursuit progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pursuit.progress}
                >
                  <span style={{ width: `${pursuit.progress}%` }} />
                </span>
                <span className="pursuit-percent">{pursuit.progress}%</span>
              </div>
            ) : (
              <p>{agent?.role ?? space?.description}</p>
            )}
          </div>
        </div>
        <div className="header-actions">
          {!agent && !pursuit && (
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
          <IconButton
            label={agent ? 'Agent details' : pursuit ? 'Pursuit details' : 'Space details'}
            className={detailsOpen ? 'is-on' : ''}
            onClick={onDetails}
            aria-expanded={detailsOpen}
            aria-controls="conversation-details"
          >
            {agent ? <Info size={18} /> : <PanelRight size={18} />}
          </IconButton>
          <div className="header-menu-anchor" ref={menu}>
            <IconButton
              label="More conversation options"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-expanded={menuOpen}
            >
              <MoreHorizontal size={21} />
            </IconButton>
            {menuOpen && (
              <div className="popover-menu">
                {agent && (
                  <>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        onTab('Files');
                      }}
                    >
                      <FileText size={15} /> Files
                    </button>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        onTab('Activity');
                      }}
                    >
                      <Activity size={15} /> Activity
                    </button>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        onDialog('settings');
                      }}
                    >
                      <SlidersHorizontal size={15} /> Customize
                    </button>
                  </>
                )}
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
                    onDetails();
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
      {(!agent || tab !== 'Messages') && (
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
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
