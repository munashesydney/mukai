import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ThemeContext } from './ThemeContext';
import {
  applyTheme,
  defaultPreferences,
  readPreferences,
  readStoredPreferences,
  resolveMode,
  themeStorageKey,
  type ThemePreferences,
} from './themes';
import { settingsService } from '../../services/settingsService';
import { startPoll } from '../../services/poll';
import { errorText } from '../../utils/errors';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(readPreferences);
  const current = useRef(preferences);
  const saved = useRef<ThemePreferences | null>(null);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const saveQueue = useRef(Promise.resolve());
  const pending = useRef(0);
  const generation = useRef(0);
  const accept = useCallback((value: ThemePreferences) => {
    current.current = value;
    setPreferences(value);
    // The browser copy is only a startup cache; the database is authoritative.
    try {
      localStorage.setItem(themeStorageKey, JSON.stringify(value));
    } catch {
      /* Shared saving still works. */
    }
  }, []);
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
    let disposed = false;
    const load = async () => {
      try {
        let result = await settingsService.appearance();
        // Only the desktop's legacy cache seeds an unset setting. A browser cache cannot
        // silently replace the desktop appearance when switching databases or ports.
        const legacy = window.mukai ? readStoredPreferences() : null;
        if (result.appearance === null && legacy)
          result = await settingsService.initializeAppearance(legacy);
        if (disposed) return;
        saved.current = result.appearance;
        if (result.appearance) accept(result.appearance);
        else {
          current.current = defaultPreferences;
          setPreferences(defaultPreferences);
        }
        setReady(true);
        setError('');
      } catch (caught) {
        if (!disposed) {
          setReady(false);
          setError(errorText(caught));
        }
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [accept, retry]);
  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let loading = false;
    let previous: string | undefined;
    const refresh = async () => {
      if (loading || pending.current) return;
      const requestedGeneration = generation.current;
      loading = true;
      try {
        const result = await settingsService.appearance();
        if (disposed || pending.current || generation.current !== requestedGeneration) return;
        saved.current = result.appearance;
        const snapshot = JSON.stringify(result.appearance ?? null);
        const changed = snapshot !== previous;
        previous = snapshot;
        if (changed && result.appearance) accept(result.appearance);
        return changed;
      } catch {
        /* Retain the confirmed preference during temporary disconnections. */
      } finally {
        loading = false;
      }
    };
    const poll = startPoll(() => refresh(), { interval: 5000, maxInterval: 20000 });
    const onFocus = () => poll.refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      disposed = true;
      poll.stop();
      window.removeEventListener('focus', onFocus);
    };
  }, [accept, ready]);
  const update = (patch: Partial<ThemePreferences>) => {
    if (!ready) return;
    const next = { ...current.current, ...patch };
    generation.current++;
    current.current = next;
    setPreferences(next);
    pending.current++;
    setSaving(true);
    setError('');
    // Serialize rapid changes so an older response cannot win the last click.
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        const result = await settingsService.saveAppearance(next);
        saved.current = result.appearance;
        if (pending.current === 1) accept(result.appearance ?? defaultPreferences);
        setError('');
      } catch (caught) {
        if (pending.current === 1) {
          accept(saved.current ?? defaultPreferences);
          setError(errorText(caught));
        }
      } finally {
        pending.current--;
        if (!pending.current) setSaving(false);
      }
    });
  };
  return (
    <ThemeContext.Provider
      value={{
        preferences,
        resolvedMode: resolveMode(preferences.mode, systemDark),
        setMode: (mode) => update({ mode }),
        setTheme: (theme) => update({ theme }),
        ready,
        saving,
        error,
        retry: () => setRetry((value) => value + 1),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
