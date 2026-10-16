import { createContext } from 'react';
import { defaultUserProfile, type UserProfile } from '../../../../shared/userProfile';

interface UserProfileContextValue {
  profile: UserProfile;
  ready: boolean;
  error: string;
  reload: () => void;
  save: (profile: UserProfile) => Promise<void>;
}
export const UserProfileContext = createContext<UserProfileContextValue>({
  profile: defaultUserProfile,
  ready: false,
  error: '',
  reload: () => {},
  save: async () => {
    throw new Error('Profile is not ready.');
  },
});
