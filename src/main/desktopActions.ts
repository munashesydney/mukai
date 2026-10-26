import { clipboard, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '../shared/contracts';

interface DesktopActions {
  openExternal: (url: string) => Promise<void>;
  writeClipboardText: (text: string) => Promise<void>;
  readClipboardText: () => Promise<string>;
}

/** Explicit actions from Mukai's main frame; embedded websites receive no such privileges. */
export function registerDesktopActions(
  trustedSender: (event: IpcMainInvokeEvent) => boolean,
  actions: DesktopActions = {
    openExternal: (url) => shell.openExternal(url),
    writeClipboardText: (text) => clipboard.writeText(text),
    readClipboardText: () => clipboard.readText(),
  },
) {
  ipcMain.handle(IPC.openExternal, async (event, value: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender');
    if (typeof value !== 'string' || value.length > 16384) throw new Error('Unsupported link');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Unsupported link');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Unsupported link');
    await actions.openExternal(url.href);
  });
  ipcMain.handle(IPC.writeClipboardText, async (event, value: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender');
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 * 1024)
      throw new Error('Clipboard text must be at most 1 MB.');
    await actions.writeClipboardText(value);
  });
  ipcMain.handle(IPC.readClipboardText, async (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted IPC sender');
    const text = await actions.readClipboardText();
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024)
      throw new Error('Clipboard text must be at most 1 MB.');
    return text;
  });
  return () => {
    ipcMain.removeHandler(IPC.openExternal);
    ipcMain.removeHandler(IPC.writeClipboardText);
    ipcMain.removeHandler(IPC.readClipboardText);
  };
}
