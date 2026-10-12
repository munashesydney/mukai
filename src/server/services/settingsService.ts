import { appearanceSchema, type AppearanceSettings } from '../../shared/appearance';
import type { SettingsRepository } from '../repositories/settingsRepository';

const appearanceKey = 'appearance';
export class SettingsService {
  constructor(private readonly repository: SettingsRepository) {}
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
