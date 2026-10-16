import type { CSSProperties } from 'react';
import type { UserProfile } from '../../../../shared/userProfile';
import { profileIcons } from './profileIcons';

export type UserAvatarSize = 'xs' | 'sm' | 'md' | 'lg';
export function UserAvatar({
  profile,
  size = 'md',
  status = false,
}: {
  profile: UserProfile;
  size?: UserAvatarSize;
  status?: boolean;
}) {
  const { Icon, label } = profileIcons[profile.icon];
  const rgb = profile.background
    .slice(1)
    .match(/../g)!
    .map((value) => parseInt(value, 16));
  const light = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 165;
  return (
    <span
      className={`avatar avatar--munashe avatar--${size}`}
      role="img"
      aria-label={`Your profile: ${profile.mode === 'letter' ? profile.letter : label}`}
      style={
        {
          '--profile-background': profile.background,
          color: light ? '#17232c' : '#fff9eb',
        } as CSSProperties
      }
    >
      {profile.mode === 'letter' ? (
        <span className="user-initials">{profile.letter}</span>
      ) : (
        <Icon className="user-profile-icon" aria-hidden="true" />
      )}
      {status && <span className="presence-dot" />}
    </span>
  );
}
