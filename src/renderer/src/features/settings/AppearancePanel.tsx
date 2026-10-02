import { Check, Monitor, Moon, Sun, Sparkles } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useTheme } from '../appearance/useTheme';
import { themes, type ColorMode } from '../appearance/themes';

const modes = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
] as const;

export function AppearancePanel() {
  const { preferences, resolvedMode, setMode, setTheme } = useTheme();
  return (
    <>
      <div className="settings-panel-heading">
        <span className="settings-eyebrow">A SPACE THAT FEELS LIKE YOU</span>
        <h3>Appearance</h3>
        <p>Find your light. Set your own tone.</p>
      </div>
      <fieldset className="appearance-group">
        <legend>Color mode</legend>
        <p>Choose your light, or let your device lead.</p>
        <div className="mode-options">
          {modes.map(({ id, label, icon: Icon }) => (
            <label
              className={`mode-option ${preferences.mode === id ? 'is-selected' : ''}`}
              key={id}
            >
              <input
                type="radio"
                name="color-mode"
                value={id}
                checked={preferences.mode === id}
                onChange={() => setMode(id as ColorMode)}
                className="visually-hidden"
              />
              <span className={`mode-preview mode-preview--${id}`} aria-hidden="true">
                <span className="mode-preview-sidebar">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="mode-preview-content">
                  <i />
                  <i />
                  <span />
                  <span />
                </span>
                <Icon size={16} />
              </span>
              <span className="mode-option-label">
                <Icon size={14} />
                {label}
                {preferences.mode === id && <Check size={13} />}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="appearance-group theme-group">
        <legend>Workspace theme</legend>
        <p>A little color goes a long way.</p>
        <div className="theme-options">
          {themes.map((theme) => {
            const palette = theme[resolvedMode];
            const selected = preferences.theme === theme.id;
            const style = {
              '--preview-accent': palette.accent,
              '--preview-soft': palette.soft,
              '--preview-rail': palette.rail,
              '--preview-nav': palette.nav,
              '--preview-glow': palette.glow,
            } as CSSProperties;
            return (
              <label
                className={`theme-option ${selected ? 'is-selected' : ''}`}
                key={theme.id}
                style={style}
              >
                <input
                  type="radio"
                  name="workspace-theme"
                  value={theme.id}
                  checked={selected}
                  onChange={() => setTheme(theme.id)}
                  className="visually-hidden"
                />
                <span className="theme-preview" aria-hidden="true">
                  <span className="theme-preview-top">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="theme-preview-rail">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="theme-preview-sidebar">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="theme-preview-content">
                    <span className="theme-preview-message">
                      <i />
                      <span />
                    </span>
                    <span className="theme-preview-message">
                      <i />
                      <span />
                    </span>
                    <span className="theme-preview-card" />
                    <span className="theme-preview-input">
                      <i />
                    </span>
                  </span>
                  {selected && (
                    <span className="theme-selected-check">
                      <Check size={11} />
                    </span>
                  )}
                </span>
                <span className="theme-option-name">
                  <i />
                  {theme.name}
                </span>
                <span className="theme-option-description">{theme.description}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="appearance-note">
        <Sparkles size={14} />
        <span>Yours to change. Make yourself at home.</span>
        <span className="appearance-live">Live preview</span>
      </div>
    </>
  );
}
