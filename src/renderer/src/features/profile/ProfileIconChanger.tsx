import { useContext, useId, useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { PopupMenu } from '../../components/ui/PopupMenu';
import {
  defaultUserProfile,
  profileIconIds,
  userProfileSchema,
  type UserProfile,
} from '../../../../shared/userProfile';
import { UserProfileContext } from './UserProfileContext';
import { UserAvatar, type UserAvatarSize } from './UserAvatar';
import { profileIcons } from './profileIcons';

const backgrounds = [
  { name: 'Brown', color: '#b28a66' },
  { name: 'Ocean', color: '#397eaa' },
  { name: 'Iris', color: '#8b70b8' },
  { name: 'Rose', color: '#b96682' },
  { name: 'Forest', color: '#438571' },
  { name: 'Ember', color: '#bc7046' },
  { name: 'Slate', color: '#526678' },
  { name: 'Sand', color: '#e0cda7' },
];

/** Profile-specific editor; the shared PopupMenu owns the floating card. */
export function ProfileIconChanger({
  size = 'md',
  status = false,
}: {
  size?: UserAvatarSize;
  status?: boolean;
}) {
  const { profile, ready, error, reload } = useContext(UserProfileContext);
  return (
    <PopupMenu
      label="Customize your profile icon"
      title="Make it yours"
      role="dialog"
      width={300}
      className="user-avatar-picker"
      buttonClassName="user-avatar-trigger"
      menuClassName="profile-icon-menu"
      trigger={<UserAvatar profile={profile} size={size} status={status} />}
    >
      {(close) =>
        ready ? (
          <ProfileEditor profile={profile} close={close} />
        ) : (
          <div className="profile-loading">
            <p role="status">{error || 'Loading your profile…'}</p>
            {error && (
              <button type="button" className="button" data-popup-autofocus onClick={reload}>
                Try again
              </button>
            )}
          </div>
        )
      }
    </PopupMenu>
  );
}

function ProfileEditor({ profile, close }: { profile: UserProfile; close: () => void }) {
  const { save } = useContext(UserProfileContext);
  const [draft, setDraft] = useState(profile);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  const valid = userProfileSchema.safeParse(draft).success;
  const patch = (value: Partial<UserProfile>) => {
    setDraft((previous) => ({ ...previous, ...value }));
    setError('');
  };
  async function submit() {
    if (!valid || saving) return;
    setSaving(true);
    setError('');
    try {
      await save(draft);
      close();
    } catch {
      setError('Could not save your profile. Your changes are still here—try again.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      className="profile-icon-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={saving}>
        <legend className="profile-style-legend">Style</legend>
        <div className="profile-style-row">
          <div className="profile-preview">
            <UserAvatar profile={draft} />
          </div>
          <div className="profile-mode-options" role="group" aria-label="Profile icon style">
            <button
              type="button"
              data-popup-autofocus
              aria-pressed={draft.mode === 'icon'}
              onClick={() => patch({ mode: 'icon' })}
            >
              Icon
            </button>
            <button
              type="button"
              aria-pressed={draft.mode === 'letter'}
              onClick={() => patch({ mode: 'letter' })}
            >
              Letter
            </button>
          </div>
        </div>
        {draft.mode === 'letter' ? (
          <div className="profile-letter-field">
            <label htmlFor={`${id}-letter`}>Letter or initials</label>
            <input
              id={`${id}-letter`}
              value={draft.letter}
              maxLength={2}
              autoComplete="off"
              onChange={(event) => patch({ letter: event.target.value.toUpperCase().slice(0, 2) })}
              aria-describedby={`${id}-letter-help`}
            />
            <small id={`${id}-letter-help`}>Use one or two letters or numbers.</small>
          </div>
        ) : (
          <div className="profile-icon-options" role="group" aria-label="Choose an icon">
            {profileIconIds.map((icon) => {
              const { Icon, label } = profileIcons[icon];
              return (
                <button
                  key={icon}
                  type="button"
                  title={label}
                  aria-label={label}
                  aria-pressed={draft.icon === icon}
                  onClick={() => patch({ icon })}
                >
                  <Icon size={18} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
      </fieldset>
      <fieldset disabled={saving}>
        <legend>Background</legend>
        <div className="profile-background-row">
          <div className="profile-backgrounds" role="group" aria-label="Choose a background">
            {backgrounds.map(({ name, color }) => (
              <button
                key={name}
                type="button"
                title={name}
                aria-label={`${name} background`}
                aria-pressed={draft.background.toLowerCase() === color}
                style={{ background: color }}
                onClick={() => patch({ background: color })}
              >
                {draft.background.toLowerCase() === color && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <label className="profile-custom-color" title="Custom background color">
            <input
              type="color"
              aria-label="Custom background color"
              value={draft.background}
              onChange={(event) => patch({ background: event.target.value })}
            />
          </label>
        </div>
      </fieldset>
      {error && (
        <p className="profile-save-error" role="alert">
          {error}
        </p>
      )}
      <div className="profile-editor-actions">
        <button
          className="text-button"
          type="button"
          disabled={saving}
          onClick={() => setDraft({ ...defaultUserProfile })}
          title="Reset to the default user icon"
        >
          <RotateCcw size={13} />
          Reset
        </button>
        <button className="button button--small" type="button" disabled={saving} onClick={close}>
          Cancel
        </button>
        <button
          className="button button--small button--primary"
          type="submit"
          disabled={saving || !valid}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
