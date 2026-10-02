export type ColorMode = 'light' | 'dark' | 'system';
export type ResolvedMode = Exclude<ColorMode, 'system'>;
export type ThemeId = 'mukai' | 'ocean' | 'iris' | 'ember' | 'rose' | 'graphite';
export interface ThemePreferences {
  mode: ColorMode;
  theme: ThemeId;
}
interface AccentPalette {
  accent: string;
  hover: string;
  soft: string;
  text: string;
  border: string;
  rail: string;
  nav: string;
  glow: string;
}
export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  description: string;
  light: AccentPalette;
  dark: AccentPalette;
}

export const themes: ThemeDefinition[] = [
  {
    id: 'mukai',
    name: 'Mukai',
    description: 'A little grounded.',
    light: {
      accent: '#388b73',
      hover: '#28745e',
      soft: '#e8f2ed',
      text: '#37725b',
      border: '#b9d5c8',
      rail: '#12232e',
      nav: '#2b665e',
      glow: '#65d5c5',
    },
    dark: {
      accent: '#409f84',
      hover: '#4caf92',
      soft: '#203b34',
      text: '#8dcdb3',
      border: '#365b4e',
      rail: '#111b23',
      nav: '#2b665e',
      glow: '#70d7b7',
    },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Room to think.',
    light: {
      accent: '#377eb0',
      hover: '#2b6590',
      soft: '#eaf2f9',
      text: '#376d95',
      border: '#b5cfe4',
      rail: '#102338',
      nav: '#285d85',
      glow: '#82c9f1',
    },
    dark: {
      accent: '#3b87bd',
      hover: '#4899d1',
      soft: '#20354a',
      text: '#91c9ef',
      border: '#355774',
      rail: '#101b2b',
      nav: '#285d85',
      glow: '#82c9f1',
    },
  },
  {
    id: 'iris',
    name: 'Iris',
    description: 'A different perspective.',
    light: {
      accent: '#8060b4',
      hover: '#684a9b',
      soft: '#f1edf8',
      text: '#77549c',
      border: '#d1c0e7',
      rail: '#251d36',
      nav: '#62467e',
      glow: '#c5a6f2',
    },
    dark: {
      accent: '#9170c8',
      hover: '#a181da',
      soft: '#352941',
      text: '#ceb3f3',
      border: '#58446d',
      rail: '#1b1627',
      nav: '#62467e',
      glow: '#c5a6f2',
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    description: 'Keep the spark.',
    light: {
      accent: '#b87643',
      hover: '#9a5b32',
      soft: '#fbf0e7',
      text: '#9b663e',
      border: '#e9cbb3',
      rail: '#30231f',
      nav: '#875a3b',
      glow: '#ecb283',
    },
    dark: {
      accent: '#c28a56',
      hover: '#d39a65',
      soft: '#3c2f27',
      text: '#e4b587',
      border: '#69503b',
      rail: '#241c19',
      nav: '#875a3b',
      glow: '#ecb283',
    },
  },
  {
    id: 'rose',
    name: 'Rose',
    description: 'A warmer kind of focus.',
    light: {
      accent: '#ae6581',
      hover: '#96506b',
      soft: '#f9edf2',
      text: '#9a5b76',
      border: '#e6c1d0',
      rail: '#2d202a',
      nav: '#7f4a64',
      glow: '#e6a4bf',
    },
    dark: {
      accent: '#bb7897',
      hover: '#ce8aa9',
      soft: '#3c2a34',
      text: '#e4aec6',
      border: '#644353',
      rail: '#231922',
      nav: '#7f4a64',
      glow: '#e6a4bf',
    },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Quietly considered.',
    light: {
      accent: '#637583',
      hover: '#4d606f',
      soft: '#edf1f4',
      text: '#526b7a',
      border: '#c2cdd5',
      rail: '#202830',
      nav: '#4d606b',
      glow: '#b4c7d2',
    },
    dark: {
      accent: '#738a99',
      hover: '#839daa',
      soft: '#2c373f',
      text: '#b5cbd8',
      border: '#4a5b67',
      rail: '#181e24',
      nav: '#4d606b',
      glow: '#b4c7d2',
    },
  },
];

export const themeStorageKey = 'mukai.appearance.v1';
export const defaultPreferences: ThemePreferences = { mode: 'light', theme: 'mukai' };

export function parsePreferences(raw: string | null): ThemePreferences {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object') return defaultPreferences;
    const candidate = value as Partial<ThemePreferences>;
    if (
      !['light', 'dark', 'system'].includes(candidate.mode ?? '') ||
      !themes.some((theme) => theme.id === candidate.theme)
    )
      return defaultPreferences;
    return { mode: candidate.mode!, theme: candidate.theme! };
  } catch {
    return defaultPreferences;
  }
}

export function readPreferences(): ThemePreferences {
  try {
    return parsePreferences(localStorage.getItem(themeStorageKey));
  } catch {
    return defaultPreferences;
  }
}

export function resolveMode(mode: ColorMode, systemDark: boolean): ResolvedMode {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

export function applyTheme(preferences: ThemePreferences, systemDark: boolean) {
  const mode = resolveMode(preferences.mode, systemDark);
  const theme = themes.find((theme) => theme.id === preferences.theme) ?? themes[0];
  const palette = theme[mode];
  const root = document.documentElement;
  root.dataset.mode = mode;
  root.dataset.theme = theme.id;
  root.style.colorScheme = mode;
  for (const [name, value] of Object.entries(palette))
    root.style.setProperty(`--theme-${name}`, value);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.rail);
}
