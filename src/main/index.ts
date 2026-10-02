import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { join } from 'node:path';
import { startApiServer } from '../server/app';
import { IPC } from '../shared/contracts';
import type { Server } from 'node:http';

let apiServer: Server | undefined;
let apiUrl = '';
let shutdownApi: (() => Promise<void>) | undefined;
let quitting = false;

function createWindow() {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    title: 'Mukai',
    icon: join(
      app.getAppPath(),
      app.isPackaged ? 'out/renderer/mukai-logo.png' : 'src/renderer/public/mukai-logo.png',
    ),
    frame: false,
    backgroundColor: '#12232e',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      const api = await startApiServer(0, {
        dataDir: process.env.MUKAI_DATA_DIR || join(app.getPath('userData'), 'data'),
      });
      apiServer = api.server;
      shutdownApi = api.shutdown;
      apiUrl = api.url;
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      const senderWindow = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return event.senderFrame === event.sender.mainFrame ? window : null;
      };
      ipcMain.handle(IPC.health, async (event) => {
        if (!senderWindow(event)) throw new Error('Untrusted IPC sender');
        const response = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error('API unavailable');
        return response.json();
      });
      ipcMain.on(IPC.minimize, (event) => senderWindow(event)?.minimize());
      ipcMain.handle(IPC.apiConnection, (event) => {
        if (!senderWindow(event)) throw new Error('Untrusted IPC sender');
        return { url: apiUrl, token: api.token };
      });
      ipcMain.handle(IPC.chooseWorkspaceFolder, async (event) => {
        const window = senderWindow(event);
        if (!window) throw new Error('Untrusted IPC sender');
        const result = await dialog.showOpenDialog(window, {
          title: 'Choose a Mukai workspace folder',
          properties: ['openDirectory', 'createDirectory'],
          buttonLabel: 'Use this folder',
        });
        return result.canceled ? null : result.filePaths[0] || null;
      });
      ipcMain.handle(IPC.openExternal, async (event, value: unknown) => {
        if (!senderWindow(event) || typeof value !== 'string') throw new Error('Untrusted link');
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw new Error('Unsupported link');
        await shell.openExternal(url.href);
      });
      ipcMain.on(IPC.maximize, (event) => {
        const window = senderWindow(event);
        if (window?.isMaximized()) window.unmaximize();
        else window?.maximize();
      });
      ipcMain.on(IPC.close, (event) => senderWindow(event)?.close());
      createWindow();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((error) => {
      console.error('Mukai startup failed:', error);
      app.quit();
    });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (!quitting && apiServer) {
      event.preventDefault();
      quitting = true;
      void shutdownApi?.().finally(() => {
        apiServer?.close();
        apiServer?.closeAllConnections();
        app.quit();
      });
    }
  });
}
