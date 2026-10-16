import { botAvatarLabels, botAvatarSrc, resolveBotAvatar } from '../../../../shared/mascots';
import { ProfileIconChanger } from '../../features/profile/ProfileIconChanger';

export function Avatar({
  person,
  size = 'md',
  status = false,
}: {
  person: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  status?: boolean;
}) {
  if (person === 'munashe') return <ProfileIconChanger size={size} status={status} />;
  const avatar = resolveBotAvatar(person);
  return (
    <span
      className={`avatar avatar--mascot avatar--${size}`}
      role="img"
      aria-label={botAvatarLabels[avatar]}
    >
      <img className="avatar-mascot" src={botAvatarSrc(avatar)} alt="" draggable={false} />
      {status && <span className="presence-dot" />}
    </span>
  );
}
