import {
  Layers3,
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
import { bots } from '../workspace/data';
import type { BotId, DialogKind, Location, Space, Pursuit } from '../workspace/types';
import type { Bot } from '../../../../shared/ai';
import { BrowserToggle } from '../browser/BrowserToggle';
import { useBrowserPanel } from '../browser/useBrowserPanel';

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
  members,
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
  members?: Bot[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const browser = useBrowserPanel();
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
  const bot = bots.find((bot) => bot.id === location.item);
  return (
    <header
      className={`conversation-header ${bot && tab === 'Messages' ? 'conversation-header--minimal' : ''}`}
    >
      <div className="conversation-heading">
        <div className="heading-identity">
          {bot ? (
            <Avatar person={bot.id as BotId} size="md" />
          ) : pursuit ? (
            <span className="heading-pursuit-icon">
              <Target size={23} />
            </span>
          ) : (
            <span className="heading-space">
              <Layers3 size={24} strokeWidth={1.8} />
            </span>
          )}
          <div>
            <h1>{bot?.name ?? pursuit?.name ?? space?.name}</h1>
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
              <p>{bot?.role ?? space?.description}</p>
            )}
          </div>
        </div>
        <div className="header-actions">
          <BrowserToggle />
          {!bot && !pursuit && (
            <button
              className="member-stack"
              onClick={onDetails}
              aria-label="View the bots in this space"
            >
              {members ? (
                members
                  .slice(0, 3)
                  .map((member) => <Avatar key={member.id} person={member.avatar} size="xs" />)
              ) : (
                <>
                  <Avatar person="atlas" size="xs" />
                  <Avatar person="nova" size="xs" />
                  <Avatar person="scout" size="xs" />
                </>
              )}
              <span>{members?.length ?? 3}</span>
            </button>
          )}
          <IconButton
            label={bot ? 'Bot details' : pursuit ? 'Pursuit details' : 'Space details'}
            className={detailsOpen ? 'is-on' : ''}
            onClick={onDetails}
            aria-expanded={detailsOpen}
            aria-controls="conversation-details"
          >
            {bot || browser?.tabs.length ? <Info size={18} /> : <PanelRight size={18} />}
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
                {bot && (
                  <>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        onTab('Artifacts');
                      }}
                    >
                      <FileText size={15} /> Artifacts
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
      {(!bot || tab !== 'Messages') && (
        <div className="conversation-tabs" role="tablist" aria-label="Conversation views">
          {['Messages', 'Artifacts', 'Activity'].map((label) => (
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
