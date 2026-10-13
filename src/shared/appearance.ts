import { z } from 'zod';

export const appearanceSchema = z
  .object({
    mode: z.enum(['light', 'dark', 'system']),
    theme: z.enum(['mukai', 'ocean', 'iris', 'ember', 'rose', 'graphite']),
  })
  .strict();
export type ThemePreferences = z.infer<typeof appearanceSchema>;
export type ColorMode = ThemePreferences['mode'];
export type ThemeId = ThemePreferences['theme'];
export type ResolvedMode = Exclude<ColorMode, 'system'>;
export const defaultPreferences: ThemePreferences = { mode: 'light', theme: 'ocean' };
export interface AppearanceSettings {
  appearance: ThemePreferences | null;
}
