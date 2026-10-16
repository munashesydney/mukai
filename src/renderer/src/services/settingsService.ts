import { api } from './http';
import type { AppearanceSettings, ThemePreferences } from '../../../shared/appearance';
import type { UserProfile } from '../../../shared/userProfile';

export const settingsService = {
  profile: () => api<UserProfile>('/settings/profile'),
  saveProfile: (value: UserProfile) => api<UserProfile>('/settings/profile', 'PUT', value),
  appearance: () => api<AppearanceSettings>('/settings/appearance'),
  saveAppearance: (value: ThemePreferences) =>
    api<AppearanceSettings>('/settings/appearance', 'PUT', value),
  initializeAppearance: (value: ThemePreferences) =>
    api<AppearanceSettings>('/settings/appearance', 'POST', value),
};
