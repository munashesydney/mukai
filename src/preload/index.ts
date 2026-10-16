import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type DesktopBridge, type DesktopUpdateState } from '../shared/contracts';

const bridge: DesktopBridge = {
  platform: process.platform,
  getHealth: () => ipcRenderer.invoke(IPC.health),
  getApiConnection: () => ipcRenderer.invoke(IPC.apiConnection),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  writeClipboardText: (text) => ipcRenderer.invoke(IPC.writeClipboardText, text),
  chooseWorkspaceFolder: () => ipcRenderer.invoke(IPC.chooseWorkspaceFolder),
  minimize: () => ipcRenderer.send(IPC.minimize),
  toggleMaximize: () => ipcRenderer.send(IPC.maximize),
  close: () => ipcRenderer.send(IPC.close),
  setBrowserBounds: (value) => ipcRenderer.invoke(IPC.browserBounds, value),
  getUpdateState: () => ipcRenderer.invoke(IPC.updateState),
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
  setAutomaticUpdates: (enabled) => ipcRenderer.invoke(IPC.setAutomaticUpdates, enabled),
  restartToUpdate: () => ipcRenderer.invoke(IPC.restartToUpdate),
  onUpdateState: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState) =>
      listener(state);
    ipcRenderer.on(IPC.updateState, receive);
    return () => ipcRenderer.removeListener(IPC.updateState, receive);
  },
};
contextBridge.exposeInMainWorld('mukai', bridge);
