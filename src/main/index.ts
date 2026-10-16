import { app, BrowserWindow, dialog, ipcMain, powerMonitor, session } from 'electron';
import { join } from 'node:path';
import { startApiServer } from '../server/app';
import { IPC } from '../shared/contracts';
import type { Server } from 'node:http';
import { MukaiBrowserHost } from './embeddedBrowserHost';
import { z } from 'zod';
import { registerDesktopActions } from './desktopActions';
import electronUpdater from 'electron-updater';
import { DesktopUpdater } from './desktopUpdater';

let apiServer: Server | undefined;
let apiUrl = '';
let shutdownApi: (() => Promise<void>) | undefined;
let quitting = false;
let shutdownPromise: Promise<void> | undefined;
let desktopUpdater: DesktopUpdater | undefined;
const embeddedBrowser = new MukaiBrowserHost();
const appWindows = new Set<number>();

function shutdownDesktop() {
  return (shutdownPromise ??= (async () => {
    desktopUpdater?.stop();
    await shutdownApi?.();
    if (apiServer) {
      const server = apiServer;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      apiServer = undefined;
    }
  })());
}

if (process.platform === 'win32') app.setAppUserModelId('com.mukai.desktop');

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
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 20, y: 23 } }
      : { frame: false }),
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
  const contentsId = window.webContents.id;
  appWindows.add(contentsId);
  window.on('closed', () => appWindows.delete(contentsId));
  embeddedBrowser.attach(window);
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
      const api = await startApiServer(47831, {
        version: app.getVersion(),
        dataDir: process.env.MUKAI_DATA_DIR || join(app.getPath('userData'), 'data'),
        embeddedBrowser,
        desktopHelperDir: app.isPackaged
          ? join(process.resourcesPath, 'computer_use')
          : join(app.getAppPath(), 'dist', 'computer_use'),
        guestBundleDir: app.isPackaged
          ? join(process.resourcesPath, 'guest')
          : join(app.getAppPath(), 'dist', 'guest'),
      });
      apiServer = api.server;
      shutdownApi = api.shutdown;
      apiUrl = api.url;
      // Sleep can leave a guest bridge unable to reconnect on its own. Once the host
      // wakes, give the guest a moment to thaw, then reconnect it — or restart the VM
      // if it stays silent. The guest health monitor covers missing resume events.
      powerMonitor.on('resume', () => {
        setTimeout(() => void api.computers.hostResumed(), 10000).unref();
      });
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      const senderWindow = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return appWindows.has(event.sender.id) && event.senderFrame === event.sender.mainFrame
          ? window
          : null;
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
      ipcMain.handle(IPC.browserBounds, (event, value: unknown) => {
        if (!senderWindow(event)) throw new Error('Untrusted IPC sender');
        const bounds = z
          .object({
            id: z.string().uuid(),
            x: z.number().finite(),
            y: z.number().finite(),
            width: z.number().finite(),
            height: z.number().finite(),
          })
          .nullable()
          .parse(value);
        embeddedBrowser.bounds(bounds);
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
      registerDesktopActions((event) => Boolean(senderWindow(event)));
      const updatesEnabled =
        app.isPackaged &&
        (process.platform === 'win32' ||
          process.platform === 'darwin' ||
          (process.platform === 'linux' && Boolean(process.env.APPIMAGE)));
      desktopUpdater = new DesktopUpdater(
        updatesEnabled ? electronUpdater.autoUpdater : undefined,
        app.getVersion(),
        {
          automaticUpdates: api.settings.automaticUpdates(),
          saveAutomaticUpdates: (enabled) => {
            api.settings.saveAutomaticUpdates(enabled);
          },
          notify: (state) => {
            for (const window of BrowserWindow.getAllWindows())
              if (appWindows.has(window.webContents.id))
                window.webContents.send(IPC.updateState, state);
          },
          confirmRestart: async () => {
            const result = await dialog.showMessageBox({
              type: 'question',
              title: 'Restart to update Mukai?',
              message: 'Mukai will restart to install the downloaded update.',
              detail:
                'Running bots, tools, and computer sessions will stop. Your saved data stays on this device.',
              buttons: ['Restart and update', 'Later'],
              defaultId: 1,
              cancelId: 1,
              noLink: true,
            });
            return result.response === 0;
          },
          prepareQuit: async () => {
            await shutdownDesktop();
            quitting = true;
          },
          disabledReason: app.isPackaged
            ? 'Automatic updates require an installed Windows app, Mac app, or Linux AppImage.'
            : 'Automatic updates are available in installed releases.',
        },
      );
      ipcMain.handle(IPC.updateState, (event) => {
        if (!senderWindow(event)) throw new Error('Untrusted IPC sender');
        return desktopUpdater!.getState();
      });
      ipcMain.handle(IPC.checkForUpdates, (event) => {
        if (!senderWindow(event)) throw new Error('Untrusted IPC sender');
        return desktopUpdater!.check();
      });
      ipcMain.handle(IPC.setAutomaticUpdates, (event, value: unknown) => {
        if (!senderWindow(event)) throw new Error('Untrusted IPC sender');
        return desktopUpdater!.setAutomaticUpdates(z.boolean().parse(value));
      });
      ipcMain.handle(IPC.restartToUpdate, (event) => {
        if (!senderWindow(event)) throw new Error('Untrusted IPC sender');
        return desktopUpdater!.restart();
      });
      ipcMain.on(IPC.maximize, (event) => {
        const window = senderWindow(event);
        if (window?.isMaximized()) window.unmaximize();
        else window?.maximize();
      });
      ipcMain.on(IPC.close, (event) => senderWindow(event)?.close());
      createWindow();
      desktopUpdater.start();
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
      void shutdownDesktop()
        .catch(console.error)
        .finally(() => {
          quitting = true;
          app.quit();
        });
    }
  });
}
