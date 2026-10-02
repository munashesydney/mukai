import { useState } from 'react';
import { Search, Layers3, Target, ArrowUpRight } from 'lucide-react';
import { Modal } from '../../components/ui/Modal';
import type { Pursuit } from '../../../../shared/pursuits';
import { Avatar } from '../../components/ui/Avatar';
import type { Bot } from '../../../../shared/ai';
import type { Location, Space } from './types';

export function SearchDialog({
  spaces,
  pursuits,
  onSelect,
  onClose,
  bots,
}: {
  spaces: Space[];
  pursuits: Pursuit[];
  onSelect: (location: Location) => void;
  onClose: () => void;
  bots: Bot[];
}) {
  const [query, setQuery] = useState('');
  const matches = (name: string) => name.toLowerCase().includes(query.toLowerCase());
  const results = [
    ...spaces
      .filter((s) => matches(s.name))
      .map((s) => ({
        id: s.id,
        name: s.name,
        detail: 'Space',
        location: { section: 'spaces', item: s.id } as Location,
        icon: <Layers3 size={19} />,
      })),
    ...bots
      .filter((a) => matches(a.name + a.description))
      .map((a) => ({
        id: a.id,
        name: a.name,
        detail: a.description || 'Bot',
        location: { section: 'bots', item: a.id } as Location,
        icon: <Avatar person={a.avatar} size="xs" />,
      })),
    ...pursuits
      .filter((p) => matches(p.name))
      .map((p) => ({
        id: p.id,
        name: p.name,
        detail: 'Pursuit',
        location: { section: 'pursuits', item: p.id } as Location,
        icon: <Target size={19} />,
      })),
  ];
  return (
    <Modal title="Find your next step" onClose={onClose}>
      <div className="search-dialog-input">
        <Search size={19} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search spaces, bots, and pursuits…"
          aria-label="Search workspace"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && results[0]) {
              onSelect(results[0].location);
              onClose();
            }
          }}
        />
        <kbd>ESC</kbd>
      </div>
      <div className="search-results">
        {results.length ? (
          results.map((result) => (
            <button
              key={result.id}
              onClick={() => {
                onSelect(result.location);
                onClose();
              }}
            >
              <span className="search-result-icon">{result.icon}</span>
              <span>
                <strong>{result.name}</strong>
                <small>{result.detail}</small>
              </span>
              <ArrowUpRight size={16} />
            </button>
          ))
        ) : (
          <p className="search-empty">No matches yet. Try another word.</p>
        )}
      </div>
      <div className="search-footer">Your whole workspace, a few keystrokes away.</div>
    </Modal>
  );
}
