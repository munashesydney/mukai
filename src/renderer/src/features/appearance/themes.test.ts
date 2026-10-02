import { describe, expect, it } from 'vitest';
import { defaultPreferences, parsePreferences, resolveMode, themes } from './themes';

describe('appearance preferences', () => {
  it('recovers safely from missing, corrupt, and unsupported saved preferences', () => {
    for (const value of [
      null,
      '{oops',
      '{}',
      'null',
      '42',
      '{"mode":"dark","theme":"unknown"}',
      '{"mode":"unknown","theme":"iris"}',
    ])
      expect(parsePreferences(value)).toEqual(defaultPreferences);
  });
  it('round-trips every supported palette and mode', () => {
    for (const theme of themes)
      for (const mode of ['light', 'dark', 'system'])
        expect(parsePreferences(JSON.stringify({ theme: theme.id, mode }))).toEqual({
          theme: theme.id,
          mode,
        });
  });
  it('follows system appearance only when system mode is selected', () => {
    expect(resolveMode('system', true)).toBe('dark');
    expect(resolveMode('system', false)).toBe('light');
    expect(resolveMode('light', true)).toBe('light');
    expect(resolveMode('dark', false)).toBe('dark');
  });
});
