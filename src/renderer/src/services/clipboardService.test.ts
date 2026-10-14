import { afterEach, expect, it, vi } from 'vitest';
import { copyText } from './clipboardService';

afterEach(() => vi.unstubAllGlobals());

it('copies through the desktop bridge even when Chromium clipboard permission is denied', async () => {
  const native = vi.fn().mockResolvedValue(undefined),
    browser = vi.fn().mockRejectedValue(new Error('Denied'));
  vi.stubGlobal('window', { mukai: { writeClipboardText: native } });
  vi.stubGlobal('navigator', { clipboard: { writeText: browser } });
  await copyText('https://t.me/MukaiQaBot?start=one_time_code');
  expect(native).toHaveBeenCalledWith('https://t.me/MukaiQaBot?start=one_time_code');
  expect(browser).not.toHaveBeenCalled();
});

it('retains normal browser copying when the desktop bridge is absent', async () => {
  const browser = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', { clipboard: { writeText: browser } });
  await copyText('browser text');
  expect(browser).toHaveBeenCalledWith('browser text');
});

it('reports a native clipboard failure instead of falling back to a denied browser permission', async () => {
  vi.stubGlobal('window', {
    mukai: { writeClipboardText: vi.fn().mockRejectedValue(new Error('Clipboard unavailable')) },
  });
  await expect(copyText('text')).rejects.toThrow('Clipboard unavailable');
});
