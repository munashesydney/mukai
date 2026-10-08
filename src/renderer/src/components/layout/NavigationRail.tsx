import { Layers3, Target, Puzzle, Settings, Plus, Bell } from 'lucide-react';
import type { Section } from '../../features/workspace/types';
import { TriangleMark } from '../ui/TriangleMark';

const items = [
  { id: 'bots', label: 'Bots', icon: null },
  { id: 'notifications', label: 'Updates', icon: Bell },
  { id: 'pursuits', label: 'Pursuits', icon: Target },
  { id: 'spaces', label: 'Spaces', icon: Layers3 },
  { id: 'tools', label: 'Tools', icon: Puzzle },
] as const;
export function NavigationRail({
  section,
  onNavigate,
  onSettings,
  onCreate,
  workspaceName = 'Munashe’s workspace',
  hasBots = true,
  hasPendingApprovals = false,
  notificationCount = 0,
  unreadNotifications = 0,
}: {
  section: Section;
  onNavigate: (section: Section) => void;
  onSettings: () => void;
  onCreate: () => void;
  workspaceName?: string;
  hasBots?: boolean;
  hasPendingApprovals?: boolean;
  notificationCount?: number;
  unreadNotifications?: number;
}) {
  return (
    <nav className="navigation-rail" aria-label="Main navigation">
      <button
        className="workspace-emblem"
        onClick={() => onNavigate(hasBots ? 'spaces' : 'bots')}
        aria-label={workspaceName}
      >
        {workspaceName[0]?.toUpperCase() || 'M'}
        <span />
      </button>
      <div className="rail-links">
        {items
          .filter((item) => item.id !== 'notifications' || notificationCount > 0)
          .map(({ id, label, icon: Icon }) => (
            <button
              className={`rail-link ${section === id ? 'is-active' : ''}`}
              key={id}
              disabled={!hasBots && id !== 'bots'}
              title={!hasBots && id !== 'bots' ? 'Add your first bot to unlock this' : undefined}
              onClick={() => onNavigate(id)}
              aria-current={section === id ? 'page' : undefined}
            >
              <span className="rail-icon">
                {Icon ? <Icon size={22} strokeWidth={1.8} /> : <TriangleMark />}
                {id === 'bots' && hasPendingApprovals && (
                  <i className="rail-notification" aria-label="Pending approvals" />
                )}
                {id === 'notifications' && unreadNotifications > 0 && (
                  <i className="rail-unread" aria-label={`${unreadNotifications} unread updates`}>
                    {unreadNotifications > 99 ? '99+' : unreadNotifications}
                  </i>
                )}
              </span>
              <span>{label}</span>
            </button>
          ))}
      </div>
      <div className="rail-bottom">
        {section !== 'pursuits' && section !== 'notifications' && (
          <button
            className="rail-add"
            onClick={onCreate}
            aria-label={
              section === 'tools'
                ? 'Create workspace'
                : section === 'bots'
                  ? 'Create a new bot'
                  : 'Create a space'
            }
          >
            <Plus size={21} />
          </button>
        )}
        <button
          className="rail-settings"
          onClick={onSettings}
          aria-label="Open settings"
          disabled={!hasBots}
          title={!hasBots ? 'Add your first bot to unlock settings' : undefined}
        >
          <Settings size={21} strokeWidth={1.6} />
        </button>
      </div>
    </nav>
  );
}
