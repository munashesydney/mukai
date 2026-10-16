import { appearanceSchema, type AppearanceSettings } from '../../shared/appearance';
import type { SettingsRepository } from '../repositories/settingsRepository';
import { defaultUserProfile, userProfileSchema } from '../../shared/userProfile';
import { z } from 'zod';

const appearanceKey = 'appearance';
export class SettingsService {
  constructor(private readonly repository: SettingsRepository) {}
  automaticUpdates(): boolean {
    const saved = this.repository.get('automatic-updates');
    return saved === null ? true : z.boolean().parse(JSON.parse(saved));
  }
  saveAutomaticUpdates(value: unknown): boolean {
    const enabled = z.boolean().parse(value);
    this.repository.set('automatic-updates', JSON.stringify(enabled));
    return enabled;
  }
  userProfile() {
    const saved = this.repository.get('user-profile');
    return saved === null ? { ...defaultUserProfile } : userProfileSchema.parse(JSON.parse(saved));
  }
  saveUserProfile(value: unknown) {
    const profile = userProfileSchema.parse(value);
    this.repository.set('user-profile', JSON.stringify(profile));
    return profile;
  }
  appearance(): AppearanceSettings {
    const saved = this.repository.get(appearanceKey);
    if (saved === null) return { appearance: null };
    return { appearance: appearanceSchema.parse(JSON.parse(saved)) };
  }
  saveAppearance(value: unknown, initialize = false): AppearanceSettings {
    const preferences = appearanceSchema.parse(value);
    const serialized = JSON.stringify(preferences);
    if (initialize) this.repository.initialize(appearanceKey, serialized);
    else this.repository.set(appearanceKey, serialized);
    return this.appearance();
  }
}
