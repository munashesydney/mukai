import { describe, expect, it } from 'vitest';
import { browserPanelWidth } from './panelWidth';

describe('browser panel layout bounds', () => {
  it('keeps both browser controls and chat usable when dragged or the window shrinks', () => {
    expect(browserPanelWidth(640, 1480)).toBe(640);
    expect(browserPanelWidth(100, 1480)).toBe(320);
    expect(browserPanelWidth(2000, 1480)).toBe(880);
    expect(browserPanelWidth(880, 960)).toBe(360);
    expect(browserPanelWidth(Number.NaN, 1480)).toBe(640);
  });
});
