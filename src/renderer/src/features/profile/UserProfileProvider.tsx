import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { defaultUserProfile, type UserProfile } from '../../../../shared/userProfile';
import { settingsService } from '../../services/settingsService';
import { UserProfileContext } from './UserProfileContext';

export function UserProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState(defaultUserProfile);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void settingsService
      .profile()
      .then((next) => {
        if (active) {
          setProfile(next);
          setReady(true);
          setError('');
        }
      })
      .catch(() => {
        if (active) setError('Could not load your profile. Try again.');
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const save = useCallback(async (value: UserProfile) => {
    const next = await settingsService.saveProfile(value);
    setProfile(next);
  }, []);
  return (
    <UserProfileContext.Provider
      value={{ profile, ready, error, save, reload: () => setRevision((value) => value + 1) }}
    >
      {children}
    </UserProfileContext.Provider>
  );
}
