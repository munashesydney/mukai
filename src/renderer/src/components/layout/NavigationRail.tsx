import { Layers3, Target, BotMessageSquare, Puzzle, Settings, Plus } from 'lucide-react';
import type { Section } from '../../features/workspace/types';
import { Avatar } from '../ui/Avatar';

const items = [
  { id: 'agents', label: 'Agents', icon: BotMessageSquare },
  { id: 'pursuits', label: 'Pursuits', icon: Target },
  { id: 'spaces', label: 'Spaces', icon: Layers3 },
  { id: 'tools', label: 'Tools', icon: Puzzle },
] as const;
export function NavigationRail({
  section,
  onNavigate,
  onSettings,
  onCreate,
}: {
  section: Section;
  onNavigate: (section: Section) => void;
  onSettings: () => void;
  onCreate: () => void;
}) {
  return (
    <nav className="navigation-rail" aria-label="Main navigation">
      <button
        className="workspace-emblem"
        onClick={() => onNavigate('spaces')}
        aria-label="Munashe’s workspace"
      >
        M<span />
      </button>
      <div className="rail-links">
        {items.map(({ id, label, icon: Icon }) => (
          <button
            className={`rail-link ${section === id ? 'is-active' : ''}`}
            key={id}
            onClick={() => onNavigate(id)}
            aria-current={section === id ? 'page' : undefined}
          >
            <span className="rail-icon">
              <Icon size={22} strokeWidth={1.8} />
              {id === 'spaces' && <i className="rail-notification" />}
            </span>
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="rail-bottom">
        <button className="rail-add" onClick={onCreate} aria-label="Create a space">
          <Plus size={21} />
        </button>
        <button className="rail-settings" onClick={onSettings} aria-label="Open settings">
          <Settings size={21} strokeWidth={1.6} />
        </button>
        <button className="rail-profile" onClick={onSettings} aria-label="Munashe’s profile">
          <Avatar person="munashe" size="sm" status />
        </button>
      </div>
    </nav>
  );
}
