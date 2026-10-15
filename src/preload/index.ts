import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type DesktopBridge } from '../shared/contracts';

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
};
contextBridge.exposeInMainWorld('mukai', bridge);
