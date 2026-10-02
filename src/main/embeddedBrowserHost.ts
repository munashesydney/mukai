import { BrowserWindow, WebContentsView, session } from 'electron';
import { createHash } from 'node:crypto';
import type { BrowserBounds, BrowserSession } from '../shared/runtime';
import type { EmbeddedBrowserHost, BrowserPage } from '../server/browser/types';
import { browserCommand } from '../server/browser/types';

export class MukaiBrowserHost implements EmbeddedBrowserHost {
  private views = new Map<string, WebContentsView>();
  private configured = new Set<string>();
  private window?: BrowserWindow;
  attach(window: BrowserWindow) {
    this.window = window;
    window.on('closed', () => {
      this.window = undefined;
      void this.shutdown();
    });
  }
  async open(info: BrowserSession): Promise<BrowserPage> {
    if (!this.window || this.window.isDestroyed())
      throw new Error('Open the Mukai desktop window to use its browser.');
    const partition =
      'persist:mukai-browser-' +
      createHash('sha256')
        .update(info.workspaceId + '/' + info.botId + '/' + info.conversationId)
        .digest('hex');
    const browserSession = session.fromPartition(partition);
    if (!this.configured.has(partition)) {
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      browserSession.setPermissionCheckHandler(() => false);
      browserSession.on('will-download', (event) => event.preventDefault());
      this.configured.add(partition);
    }
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault();
    });
    view.webContents.on('will-redirect', (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault();
    });
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
    this.window.contentView.addChildView(view);
    this.views.set(info.id, view);
    try {
      await browserCommand(view.webContents.loadURL('about:blank'));
      view.webContents.debugger.attach('1.3');
      await browserCommand(view.webContents.debugger.sendCommand('Page.enable'));
      await browserCommand(view.webContents.debugger.sendCommand('Runtime.enable'));
    } catch (error) {
      this.window?.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
      this.views.delete(info.id);
      throw error;
    }
    return {
      send: async (method, params) => {
        if (method.startsWith('Input.')) {
          if (this.window && !this.window.isFocused()) {
            this.window.focus();
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (!view.webContents.isFocused()) view.webContents.focus();
        }
        if (method === 'Input.dispatchMouseEvent' && params) {
          // Synchronize the native view's compositor after navigation/layout before sending input.
          if (params.type === 'mousePressed')
            await browserCommand(
              view.webContents.debugger.sendCommand('Page.captureScreenshot', {
                format: 'png',
                captureBeyondViewport: false,
              }),
            );
          view.webContents.sendInputEvent({
            type: 'mouseMove',
            x: Math.round(Number(params.x)),
            y: Math.round(Number(params.y)),
          });
          view.webContents.sendInputEvent({
            type: params.type === 'mousePressed' ? 'mouseDown' : 'mouseUp',
            x: Math.round(Number(params.x)),
            y: Math.round(Number(params.y)),
            button: 'left',
            clickCount: 1,
          });
          await new Promise((resolve) => setTimeout(resolve, 30));
          return {};
        }
        return browserCommand(view.webContents.debugger.sendCommand(method, params));
      },
      isClosed: () => view.webContents.isDestroyed(),
      close: async () => {
        this.window?.contentView.removeChildView(view);
        if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
        this.views.delete(info.id);
      },
    };
  }
  bounds(value: BrowserBounds | null) {
    for (const [id, view] of this.views) {
      if (view.webContents.isDestroyed()) {
        this.views.delete(id);
        continue;
      }
      const size = this.window?.getContentSize();
      const show = Boolean(
        value &&
        value.id === id &&
        size &&
        value.x >= 0 &&
        value.y >= 0 &&
        value.width > 0 &&
        value.height > 0 &&
        value.x + value.width <= size[0] + 1 &&
        value.y + value.height <= size[1] + 1,
      );
      if (show && value)
        view.setBounds({
          x: Math.round(value.x),
          y: Math.round(value.y),
          width: Math.round(value.width),
          height: Math.round(value.height),
        });
      view.setVisible(show);
    }
  }
  async shutdown() {
    for (const view of this.views.values()) {
      this.window?.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    }
    this.views.clear();
  }
}
