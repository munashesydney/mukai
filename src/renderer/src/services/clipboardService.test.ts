import { afterEach, expect, it, vi } from 'vitest';
import { copyText, readClipboardText } from './clipboardService';

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

it('reads through the desktop bridge without requesting browser clipboard permission', async () => {
  const native = vi.fn().mockResolvedValue('café 世界 🌱\nsecond line');
  const browser = vi.fn().mockRejectedValue(new Error('Denied'));
  vi.stubGlobal('window', { mukai: { readClipboardText: native } });
  vi.stubGlobal('navigator', { clipboard: { readText: browser } });
  await expect(readClipboardText()).resolves.toBe('café 世界 🌱\nsecond line');
  expect(browser).not.toHaveBeenCalled();
});

it('uses browser clipboard reads and surfaces permission failures for the manual fallback', async () => {
  const browser = vi.fn().mockResolvedValue('browser text');
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', { clipboard: { readText: browser } });
  await expect(readClipboardText()).resolves.toBe('browser text');
  browser.mockRejectedValue(new Error('Denied'));
  await expect(readClipboardText()).rejects.toThrow('Denied');
  vi.stubGlobal('navigator', {});
  await expect(readClipboardText()).rejects.toThrow('Clipboard panel');
});
