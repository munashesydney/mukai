import { createContext } from 'react';
import type { ColorMode, ResolvedMode, ThemeId, ThemePreferences } from './themes';

export interface ThemeContextValue {
  preferences: ThemePreferences;
  resolvedMode: ResolvedMode;
  setMode: (mode: ColorMode) => void;
  setTheme: (theme: ThemeId) => void;
  storageAvailable: boolean;
}
export const ThemeContext = createContext<ThemeContextValue | null>(null);
