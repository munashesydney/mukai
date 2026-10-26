import { expect, it, vi } from 'vitest';
import type RFB from '@novnc/novnc';
import { bindComputerClipboard } from './computerClipboard';

const text = 'café 世界 🌱\nsecond line';
function fixture(mac = false) {
  const canvas = {};
  const document = Object.assign(new EventTarget(), {
    activeElement: canvas as object | null,
    visibilityState: 'visible',
    hasFocus: () => true,
    defaultView: new EventTarget(),
  });
  const container = Object.assign(new EventTarget(), {
    ownerDocument: document,
    contains: (target: unknown) => target === canvas,
  });
  const order: unknown[] = [];
  const viewer = Object.assign(new EventTarget(), {
    clipboardPasteFrom: vi.fn((value: string) => order.push(value)),
    sendKey: vi.fn((...args: unknown[]) => order.push(args)),
    blur: vi.fn(() => {
      document.activeElement = null;
    }),
    focus: vi.fn(() => {
      document.activeElement = canvas;
    }),
  });
  const options = {
    read: vi.fn().mockResolvedValue(text),
    write: vi.fn().mockResolvedValue(undefined),
    remote: vi.fn(),
    message: vi.fn(),
    mac,
  };
  const binding = bindComputerClipboard(
    container as unknown as HTMLElement,
    viewer as unknown as RFB,
    options,
  );
  viewer.dispatchEvent(new Event('connect'));
  const key = (key = 'v', modifiers: object = {}) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), {
      key,
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      ...modifiers,
    });
    container.dispatchEvent(event);
    return event;
  };
  const receive = (value: unknown) =>
    viewer.dispatchEvent(Object.assign(new Event('clipboard'), { detail: { text: value } }));
  return { binding, viewer, options, container, document, key, receive, order };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

it.each([false, true])(
  'sends Unicode clipboard before the complete paste chord (terminal=%s)',
  async (terminal) => {
    const f = fixture();
    expect(f.options.read).not.toHaveBeenCalled();
    expect(f.key('v', { shiftKey: terminal }).defaultPrevented).toBe(true);
    expect(f.viewer.sendKey).not.toHaveBeenCalled();
    await flush();
    expect(f.order).toEqual([
      text,
      [0xffe3, 'ControlLeft', true],
      ...(terminal ? [[0xffe1, 'ShiftLeft', true]] : []),
      [terminal ? 86 : 118, 'KeyV'],
      ...(terminal ? [[0xffe1, 'ShiftLeft', false]] : []),
      [0xffe3, 'ControlLeft', false],
    ]);
    expect(f.viewer.blur).not.toHaveBeenCalled();
    f.binding.dispose();
  },
);

it('shares remote copies only from a focused viewer without feeding host writes back to the VM', async () => {
  const f = fixture();
  f.receive(text);
  expect(f.options.write).toHaveBeenCalledWith(text);
  f.options.write.mockClear();
  f.binding.send('outgoing');
  f.receive('outgoing');
  expect(f.options.write).toHaveBeenCalledWith('outgoing');
  expect(f.viewer.clipboardPasteFrom).toHaveBeenCalledExactlyOnceWith('outgoing');
  f.options.write.mockClear();
  f.document.activeElement = {};
  f.receive('remote while using toolbar');
  expect(f.options.write).not.toHaveBeenCalled();
  await f.binding.copyRemote();
  expect(f.options.write).toHaveBeenCalledWith('remote while using toolbar');
  f.binding.dispose();
});

it.each([
  'dispose',
  'disconnect',
  'watch',
  'blur',
  'hidden',
  'pointer',
  'focus',
  'typing',
  'manual',
])('cancels pending clipboard reads on %s', async (reason) => {
  const f = fixture();
  let complete!: (value: string) => void;
  f.options.read.mockReturnValue(
    new Promise<string>((resolve) => {
      complete = resolve;
    }),
  );
  f.key();
  if (reason === 'dispose') f.binding.dispose();
  if (reason === 'disconnect') f.viewer.dispatchEvent(new Event('disconnect'));
  if (reason === 'watch') f.binding.setEnabled(false);
  if (reason === 'blur') f.document.defaultView.dispatchEvent(new Event('blur'));
  if (reason === 'hidden') {
    f.document.visibilityState = 'hidden';
    f.document.dispatchEvent(new Event('visibilitychange'));
  }
  if (reason === 'pointer') f.container.dispatchEvent(new Event('pointerdown'));
  if (reason === 'focus') f.document.dispatchEvent(new Event('focusin'));
  if (reason === 'typing') f.key('a', { ctrlKey: false });
  if (reason === 'manual') f.binding.pasteText('manual text', true);
  f.viewer.clipboardPasteFrom.mockClear();
  f.viewer.sendKey.mockClear();
  complete(text);
  await flush();
  expect(f.viewer.clipboardPasteFrom).not.toHaveBeenCalled();
  expect(f.viewer.sendKey).not.toHaveBeenCalled();
  f.binding.dispose();
});

it('clears received text across reconnects and watch mode and removes listeners on disposal', async () => {
  const f = fixture();
  f.receive(text);
  f.viewer.dispatchEvent(new Event('disconnect'));
  await expect(f.binding.copyRemote()).rejects.toThrow('Copy some text');
  expect(f.options.remote).toHaveBeenLastCalledWith(null);
  f.viewer.dispatchEvent(new Event('connect'));
  await expect(f.binding.copyRemote()).rejects.toThrow('Copy some text');
  f.binding.setEnabled(false);
  f.options.write.mockClear();
  f.receive('watch');
  expect(f.key().defaultPrevented).toBe(false);
  expect(f.options.write).not.toHaveBeenCalled();
  f.binding.setEnabled(true);
  f.binding.dispose();
  f.viewer.dispatchEvent(new Event('connect'));
  f.receive('old workspace');
  expect(f.key().defaultPrevented).toBe(false);
  expect(f.options.write).not.toHaveBeenCalled();
});

it('offers the manual fallback on denied permission and never pastes stale VM clipboard', async () => {
  const f = fixture();
  f.options.read.mockRejectedValue(new Error('Denied'));
  f.key();
  await flush();
  expect(f.viewer.clipboardPasteFrom).not.toHaveBeenCalled();
  expect(f.viewer.sendKey).not.toHaveBeenCalled();
  expect(f.options.message).toHaveBeenCalledWith(expect.stringContaining('Open Clipboard'));
  f.binding.pasteText(text, true);
  expect(f.order[0]).toBe(text);
  expect(f.viewer.sendKey).toHaveBeenCalledWith(0xffe1, 'ShiftLeft', true);
  f.binding.dispose();
});

it('maps macOS Command copy, cut and paste to Linux Control chords', async () => {
  const f = fixture(true);
  f.key('c', { ctrlKey: false, metaKey: true });
  expect(f.viewer.sendKey).toHaveBeenCalledWith(99, 'KeyC');
  f.key('x', { ctrlKey: false, metaKey: true });
  expect(f.viewer.sendKey).toHaveBeenCalledWith(120, 'KeyX');
  f.key('v', { ctrlKey: false, metaKey: true });
  await flush();
  expect(f.viewer.clipboardPasteFrom).toHaveBeenCalledWith(text);
  f.binding.dispose();
});

it('releases the Alt keysym noVNC sends for left Command before a macOS clipboard chord', () => {
  const f = fixture(true);
  f.key('Meta', { code: 'MetaLeft', ctrlKey: false, metaKey: true });
  f.key('c', { ctrlKey: false, metaKey: true });
  expect(f.viewer.sendKey.mock.calls).toEqual([
    [0xffe9, 'MetaLeft', false],
    [0xffe3, 'ControlLeft', true],
    [99, 'KeyC'],
    [0xffe3, 'ControlLeft', false],
    [0xffe9, 'MetaLeft', true],
  ]);
  f.binding.dispose();
});

it('limits both clipboard directions by UTF-8 bytes and handles native write failures', async () => {
  const f = fixture();
  const huge = '🌱'.repeat(300000);
  expect(() => f.binding.send(huge)).toThrow('at most 1 MB');
  f.options.remote.mockClear();
  f.receive(huge);
  f.receive({ invalid: true });
  expect(f.options.remote).toHaveBeenCalledExactlyOnceWith(null);
  expect(f.options.write).not.toHaveBeenCalled();
  f.options.write.mockRejectedValue(new Error('Clipboard busy'));
  f.receive(text);
  await flush();
  expect(f.options.message).toHaveBeenCalledWith(expect.stringContaining('Clipboard busy'));
  f.binding.dispose();
});

it('supports native browser paste events without a clipboard read or repeated-key duplicate', async () => {
  const f = fixture();
  f.container.dispatchEvent(
    Object.assign(new Event('paste', { cancelable: true }), {
      clipboardData: { getData: () => text },
    }),
  );
  f.key('V', { shiftKey: true, repeat: true });
  await flush();
  expect(f.options.read).not.toHaveBeenCalled();
  expect(f.viewer.clipboardPasteFrom).toHaveBeenCalledExactlyOnceWith(text);
  f.binding.dispose();
});

it('restores held right modifiers after paste and releases them on leaving the viewer', async () => {
  const f = fixture();
  f.key('Control', { code: 'ControlRight' });
  f.key('Shift', { code: 'ShiftRight', shiftKey: true });
  f.key('v', { shiftKey: true });
  await flush();
  expect(f.order).toEqual([
    text,
    [0xffe4, 'ControlRight', false],
    [0xffe2, 'ShiftRight', false],
    [0xffe3, 'ControlLeft', true],
    [0xffe1, 'ShiftLeft', true],
    [86, 'KeyV'],
    [0xffe1, 'ShiftLeft', false],
    [0xffe3, 'ControlLeft', false],
    [0xffe4, 'ControlRight', true],
    [0xffe2, 'ShiftRight', true],
  ]);
  f.viewer.sendKey.mockClear();
  f.container.dispatchEvent(new Event('focusout'));
  expect(f.viewer.sendKey.mock.calls).toEqual([
    [0xffe4, 'ControlRight', false],
    [0xffe2, 'ShiftRight', false],
  ]);
  f.binding.dispose();
});

it('does not restore Ctrl if it was released before the clipboard read completed', async () => {
  const f = fixture();
  let complete!: (value: string) => void;
  f.options.read.mockReturnValue(
    new Promise<string>((resolve) => {
      complete = resolve;
    }),
  );
  f.key('Control', { code: 'ControlLeft' });
  f.key();
  f.container.dispatchEvent(
    Object.assign(new Event('keyup'), { code: 'ControlLeft', key: 'Control' }),
  );
  complete(text);
  await flush();
  expect(f.viewer.sendKey.mock.calls).toEqual([
    [0xffe3, 'ControlLeft', true],
    [118, 'KeyV'],
    [0xffe3, 'ControlLeft', false],
  ]);
  f.binding.dispose();
});
