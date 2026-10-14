import { Layers3, Target, Puzzle, Settings, Plus, Bell } from 'lucide-react';
import type { Section } from '../../features/workspace/types';
import { botAvatarSrc } from '../../../../shared/mascots';

const items = [
  { id: 'bots', label: 'Bots', icon: null },
  { id: 'notifications', label: 'Messages', icon: Bell },
  { id: 'pursuits', label: 'Pursuits', icon: Target },
  { id: 'spaces', label: 'Spaces', icon: Layers3 },
  { id: 'tools', label: 'Tools', icon: Puzzle },
] as const;
export function NavigationRail({
  section,
  onNavigate,
  onSettings,
  onCreate,
  workspaceName = 'Your workspace',
  disabled = false,
  hasBots = true,
  hasPendingApprovals = false,
  notificationCount = 0,
  unreadNotifications = 0,
}: {
  section?: Section;
  onNavigate: (section: Section) => void;
  onSettings: () => void;
  onCreate: () => void;
  workspaceName?: string;
  disabled?: boolean;
  hasBots?: boolean;
  hasPendingApprovals?: boolean;
  notificationCount?: number;
  unreadNotifications?: number;
}) {
  return (
    <nav
      className={`navigation-rail ${disabled ? 'is-disabled' : ''}`}
      aria-label="Main navigation"
    >
      <button
        className="workspace-emblem"
        disabled={disabled}
        title={disabled ? 'Create your first workspace to get started' : undefined}
        onClick={() => onNavigate('bots')}
        aria-label={workspaceName}
      >
        {workspaceName[0]?.toUpperCase() || 'M'}
        {!disabled && <span />}
      </button>
      <div className="rail-links">
        {items
          .filter((item) => disabled || item.id !== 'notifications' || notificationCount > 0)
          .map(({ id, label, icon: Icon }) => (
            <button
              className={`rail-link ${!disabled && section === id ? 'is-active' : ''}`}
              key={id}
              disabled={disabled || (!hasBots && id !== 'bots')}
              title={
                disabled
                  ? 'Create your first workspace to unlock this'
                  : !hasBots && id !== 'bots'
                    ? 'Add your first bot to unlock this'
                    : undefined
              }
              onClick={() => onNavigate(id)}
              aria-current={!disabled && section === id ? 'page' : undefined}
            >
              <span className="rail-icon">
                {Icon ? (
                  <Icon size={22} strokeWidth={1.8} />
                ) : (
                  <img className="rail-mascot" src={botAvatarSrc('mukai-logo')} alt="" />
                )}
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
            disabled={disabled}
            onClick={onCreate}
            aria-label={
              disabled || section === 'tools'
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
          disabled={disabled}
          onClick={onSettings}
          aria-label="Open settings"
        >
          <Settings size={21} strokeWidth={1.6} />
        </button>
      </div>
    </nav>
  );
}
