import { botAvatarLabels, botAvatarSrc, resolveBotAvatar } from '../../../../shared/mascots';

export function Avatar({
  person,
  size = 'md',
  status = false,
}: {
  person: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  status?: boolean;
}) {
  const avatar = resolveBotAvatar(person);
  return (
    <span
      className={`avatar avatar--${person === 'munashe' ? 'munashe' : 'mascot'} avatar--${size}`}
      role="img"
      aria-label={person === 'munashe' ? 'Munashe' : botAvatarLabels[avatar]}
    >
      {person === 'munashe' ? (
        <span className="user-initials">U</span>
      ) : (
        <img className="avatar-mascot" src={botAvatarSrc(avatar)} alt="" draggable={false} />
      )}
      {status && <span className="presence-dot" />}
    </span>
  );
}
