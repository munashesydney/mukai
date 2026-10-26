import { beforeEach, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '../shared/contracts';
import { registerDesktopActions } from './desktopActions';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, value?: unknown) => Promise<unknown>>(),
  open: vi.fn().mockResolvedValue(undefined),
  copy: vi.fn().mockResolvedValue(undefined),
  read: vi.fn().mockReturnValue('A message 🌱\nC:\\project'),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      name: string,
      handler: (event: IpcMainInvokeEvent, value?: unknown) => Promise<unknown>,
    ) => fixture.handlers.set(name, handler),
    removeHandler: (name: string) => fixture.handlers.delete(name),
  },
  shell: { openExternal: fixture.open },
  clipboard: { writeText: fixture.copy, readText: fixture.read },
}));
const event = {} as IpcMainInvokeEvent;
beforeEach(() => {
  fixture.handlers.clear();
  vi.clearAllMocks();
  fixture.read.mockReturnValue('A message 🌱\nC:\\project');
});

it('uses the native OS actions for trusted links and text without dropping pairing parameters', async () => {
  const remove = registerDesktopActions(() => true);
  await fixture.handlers.get(IPC.openExternal)!(
    event,
    'https://t.me/MukaiQaBot?start=one_time_code',
  );
  await fixture.handlers.get(IPC.writeClipboardText)!(event, 'A message 🌱\nC:\\project');
  expect(fixture.open).toHaveBeenCalledWith('https://t.me/MukaiQaBot?start=one_time_code');
  expect(fixture.copy).toHaveBeenCalledWith('A message 🌱\nC:\\project');
  await expect(fixture.handlers.get(IPC.readClipboardText)!(event)).resolves.toBe(
    'A message 🌱\nC:\\project',
  );
  remove();
  expect(fixture.handlers.size).toBe(0);
});

it('rejects non-HTTP schemes, credential-bearing links, invalid input, and oversized clipboard writes', async () => {
  registerDesktopActions(() => true);
  for (const value of [
    'file:///C:/Windows',
    'javascript:alert(1)',
    'tg://resolve?domain=example',
    'https://user:pass@t.me/bot',
    'not a url',
    null,
  ]) {
    await expect(fixture.handlers.get(IPC.openExternal)!(event, value)).rejects.toThrow(
      'Unsupported link',
    );
  }
  await expect(
    fixture.handlers.get(IPC.writeClipboardText)!(event, { text: 'hello' }),
  ).rejects.toThrow('at most 1 MB');
  await expect(
    fixture.handlers.get(IPC.writeClipboardText)!(event, '🌱'.repeat(300000)),
  ).rejects.toThrow('at most 1 MB');
  expect(fixture.open).not.toHaveBeenCalled();
  expect(fixture.copy).not.toHaveBeenCalled();
});

it('bounds native clipboard reads by UTF-8 bytes', async () => {
  registerDesktopActions(() => true);
  fixture.read.mockReturnValue('🌱'.repeat(300000));
  await expect(fixture.handlers.get(IPC.readClipboardText)!(event)).rejects.toThrow('at most 1 MB');
});

it('never grants native clipboard or browser access to an untrusted IPC sender', async () => {
  registerDesktopActions(() => false);
  await expect(
    fixture.handlers.get(IPC.openExternal)!(event, 'https://t.me/BotFather'),
  ).rejects.toThrow('Untrusted IPC sender');
  await expect(fixture.handlers.get(IPC.writeClipboardText)!(event, 'private')).rejects.toThrow(
    'Untrusted IPC sender',
  );
  await expect(fixture.handlers.get(IPC.readClipboardText)!(event)).rejects.toThrow(
    'Untrusted IPC sender',
  );
  expect(fixture.open).not.toHaveBeenCalled();
  expect(fixture.copy).not.toHaveBeenCalled();
  expect(fixture.read).not.toHaveBeenCalled();
});
