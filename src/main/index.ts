import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  session,
  Menu,
  Tray,
  nativeImage,
  shell,
} from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApiServer } from '../server/app';
import { IPC } from '../shared/contracts';
import type { Server } from 'node:http';
import { MukaiBrowserHost } from './embeddedBrowserHost';
import { z } from 'zod';
import { registerDesktopActions } from './desktopActions';
import electronUpdater from 'electron-updater';
import { DesktopUpdater } from './desktopUpdater';
import { startOrConnectBackend } from '../server/backendConnection';
import type { DesktopUpdateState } from '../shared/contracts';

let apiServer: Server | undefined;
let apiUrl = '';
let shutdownApi: (() => Promise<void>) | undefined;
let quitting = false;
let shutdownPromise: Promise<void> | undefined;
let desktopUpdater: DesktopUpdater | undefined;
let tray: Tray | undefined;
let desktopReady = false;
let preferenceRefresh: ReturnType<typeof setInterval> | undefined;
const embeddedBrowser = new MukaiBrowserHost();
const appWindows = new Set<number>();

function shutdownDesktop() {
  return (shutdownPromise ??= (async () => {
    desktopUpdater?.stop();
    clearInterval(preferenceRefresh);
    await shutdownApi?.();
    if (apiServer) {
      const server = apiServer;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      apiServer = undefined;
    }
    tray?.destroy();
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
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
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

function showWindow() {
  if (!desktopReady) return;
  const window = BrowserWindow.getAllWindows().find((entry) =>
    appWindows.has(entry.webContents.id),
  );
  if (!window) return createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createTray(connectionUrl: string) {
  const icon = nativeImage
    .createFromPath(
      join(
        app.getAppPath(),
        app.isPackaged ? 'out/renderer/mukai-logo.png' : 'src/renderer/public/mukai-logo.png',
      ),
    )
    .resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('Mukai');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Mukai', click: showWindow },
      {
        label: 'Open in browser',
        click: () => {
          void shell.openExternal(connectionUrl);
        },
      },
      { type: 'separator' },
      { label: 'Quit Mukai', click: () => app.quit() },
    ]),
  );
  tray.on('double-click', showWindow);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    showWindow();
  });
  app
    .whenReady()
    .then(async () => {
      const dataDir = process.env.MUKAI_DATA_DIR || join(app.getPath('userData'), 'data');
      const webDir = app.isPackaged
        ? join(process.resourcesPath, 'web')
        : join(app.getAppPath(), 'dist', 'web');
      const apiOptions = {
        version: app.getVersion(),
        dataDir,
        webDir,
        embeddedBrowser,
        desktopHelperDir: app.isPackaged
          ? join(process.resourcesPath, 'computer_use')
          : join(app.getAppPath(), 'dist', 'computer_use'),
        guestBundleDir: app.isPackaged
          ? join(process.resourcesPath, 'guest')
          : join(app.getAppPath(), 'dist', 'guest'),
        updates: {
          getState: (): DesktopUpdateState =>
            desktopUpdater?.getState() ?? {
              status: 'disabled',
              currentVersion: app.getVersion(),
              automaticUpdates: true,
              message: 'The desktop app is starting.',
            },
          check: () => desktopUpdater!.check(),
          setAutomaticUpdates: (enabled: boolean) => desktopUpdater!.setAutomaticUpdates(enabled),
          restart: async () => {
            await desktopUpdater!.restart();
          },
        },
      };
      const result = await startOrConnectBackend(dataDir, app.getVersion(), async () => {
        if (!existsSync(join(webDir, 'index.html')))
          throw new Error('Mukai browser UI is missing. Run npm run build:web or reinstall Mukai.');
        try {
          return await startApiServer(47831, apiOptions);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
          // Another directory may own the default port. Never attach to it by address.
          return startApiServer(0, apiOptions);
        }
      });
      const api = result.owned ? result.api : undefined;
      const state = result.owned ? result.api.state! : result.connection.state;
      const token = result.owned ? result.api.token : result.connection.token;
      apiServer = api?.server;
      shutdownApi = api?.shutdown;
      apiUrl = state.url;
      const backendRequest = async <T>(
        path: string,
        method = 'GET',
        value?: unknown,
      ): Promise<T> => {
        const response = await fetch(`${apiUrl}/api${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(value === undefined ? {} : { body: JSON.stringify(value) }),
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        if (!response.ok) throw new Error(`Mukai backend request failed (${response.status}).`);
        return response.json() as Promise<T>;
      };
      // Sleep can leave a guest bridge unable to reconnect on its own. Once the host
      // wakes, give the guest a moment to thaw, then reconnect it — or restart the VM
      // if it stays silent. The guest health monitor covers missing resume events.
      if (api)
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
        return { url: `${apiUrl}/api`, token };
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
          automaticUpdates: api
            ? api.settings.automaticUpdates()
            : (await backendRequest<DesktopUpdateState>('/settings/updates')).automaticUpdates,
          saveAutomaticUpdates: (enabled) => {
            api?.settings.saveAutomaticUpdates(enabled);
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
      if (!api) {
        const refreshPreference = async () => {
          try {
            const state = await backendRequest<DesktopUpdateState>('/settings/updates');
            if (!quitting && state.automaticUpdates !== desktopUpdater!.getState().automaticUpdates)
              desktopUpdater!.setAutomaticUpdates(state.automaticUpdates);
          } catch {
            // A stopped backend must not disable the desktop's own update controls.
          }
        };
        preferenceRefresh = setInterval(() => void refreshPreference(), 30_000).unref();
      }
      ipcMain.handle(IPC.updateState, (event) => {
        if (!senderWindow(event)) throw new Error('Untrusted IPC sender');
        return desktopUpdater!.getState();
      });
      ipcMain.handle(IPC.checkForUpdates, (event) => {
        if (!senderWindow(event)) throw new Error('Untrusted IPC sender');
        return desktopUpdater!.check();
      });
      ipcMain.handle(IPC.setAutomaticUpdates, async (event, value: unknown) => {
        if (!senderWindow(event)) throw new Error('Untrusted IPC sender');
        const enabled = z.boolean().parse(value);
        if (!api) await backendRequest('/settings/updates', 'PUT', { enabled });
        return desktopUpdater!.setAutomaticUpdates(enabled);
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
      desktopReady = true;
      showWindow();
      createTray(state.connectionUrl);
      desktopUpdater.start();
      app.on('activate', showWindow);
    })
    .catch((error) => {
      console.error('Mukai startup failed:', error);
      dialog.showErrorBox(
        'Mukai could not start',
        error instanceof Error ? error.message : String(error),
      );
      app.quit();
    });
  app.on('window-all-closed', () => {
    /* The tray owns the background lifetime. */
  });
  app.on('before-quit', (event) => {
    if (!quitting) {
      event.preventDefault();
      quitting = true;
      void shutdownDesktop()
        .catch(console.error)
        .finally(() => {
          quitting = true;
          app.quit();
        });
    }
  });
}
