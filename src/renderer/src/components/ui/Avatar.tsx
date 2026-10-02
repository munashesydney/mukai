import type { PersonId } from '../../features/workspace/types';

export function Avatar({
  person,
  size = 'md',
  status = false,
}: {
  person: PersonId;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  status?: boolean;
}) {
  return (
    <span
      className={`avatar avatar--${person} avatar--${size}`}
      aria-label={person === 'munashe' ? 'Munashe' : person}
    >
      {person === 'munashe' ? (
        <span className="user-initials">M</span>
      ) : person === 'atlas' ? (
        <span className="atlas-mark">
          <i />
          <i />
        </span>
      ) : person === 'nova' ? (
        <span className="nova-mark" />
      ) : (
        <span className="scout-mark" />
      )}
      {status && <span className="presence-dot" />}
    </span>
  );
}
