import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { ThemeContext } from './ThemeContext';
import { applyTheme, readPreferences, resolveMode, themeStorageKey } from './themes';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(readPreferences);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const [storageAvailable, setStorageAvailable] = useState(true);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  useLayoutEffect(() => {
    applyTheme(preferences, systemDark);
  }, [preferences, systemDark]);
  useEffect(() => {
    try {
      localStorage.setItem(themeStorageKey, JSON.stringify(preferences));
      setStorageAvailable(true);
    } catch {
      setStorageAvailable(false);
    }
  }, [preferences]);
  return (
    <ThemeContext.Provider
      value={{
        preferences,
        resolvedMode: resolveMode(preferences.mode, systemDark),
        setMode: (mode) => setPreferences((previous) => ({ ...previous, mode })),
        setTheme: (theme) => setPreferences((previous) => ({ ...previous, theme })),
        storageAvailable,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
