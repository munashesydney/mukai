import { api } from './http';
import type { AppearanceSettings, ThemePreferences } from '../../../shared/appearance';

export const settingsService = {
  appearance: () => api<AppearanceSettings>('/settings/appearance'),
  saveAppearance: (value: ThemePreferences) =>
    api<AppearanceSettings>('/settings/appearance', 'PUT', value),
  initializeAppearance: (value: ThemePreferences) =>
    api<AppearanceSettings>('/settings/appearance', 'POST', value),
};
