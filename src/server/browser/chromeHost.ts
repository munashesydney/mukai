import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type CDPSession,
} from 'playwright-core';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceBrowserProfile } from './profile';
import type { BrowserSession } from '../../shared/runtime';
import type { BrowserPage } from './types';
import { browserCommand } from './types';
import { ApiError } from '../config';

export class ChromeHost {
  private contexts = new Map<string, Promise<BrowserContext>>();
  private configured = new WeakSet<BrowserContext>();
  private conversations = new WeakMap<Page, string>();
  private opening = new Set<string>();
  private operations = new Map<string, Promise<unknown>>();
  private attached = new Map<BrowserContext, Browser>();
  private ownedPages = new Set<Page>();
  private closed = false;
  constructor(
    private dataDir: string,
    private headless = false,
    private profile: 'workspace' | 'main' = 'workspace',
  ) {}
  private get mainProfile() {
    return this.profile === 'main';
  }
  async open(info: BrowserSession): Promise<BrowserPage> {
    const key = this.mainProfile ? 'main' : workspaceBrowserProfile(info.workspaceId);
    const conversation = JSON.stringify([info.workspaceId, info.botId, info.conversationId]);
    return this.serialize(key, () => this.openPage(key, conversation));
  }
  private async connectMain(): Promise<BrowserContext> {
    // Chrome discovers its running default profile and asks the user to allow this connection.
    // noDefaults preserves the user's viewport, focus and download settings.
    const browser = await chromium.connectOverCDP('chrome', { noDefaults: true, timeout: 20000 });
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close();
      throw new Error('Chrome did not expose its main profile.');
    }
    this.attached.set(context, browser);
    browser.once('disconnected', () => this.attached.delete(context));
    return context;
  }
  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.operations.get(key) || Promise.resolve()).catch(() => {}).then(operation);
    this.operations.set(key, result);
    const clear = () => {
      if (this.operations.get(key) === result) this.operations.delete(key);
    };
    void result.then(clear, clear);
    return result;
  }
  private async openPage(key: string, conversationId: string): Promise<BrowserPage> {
    if (this.closed) throw new ApiError(503, 'Browser is shutting down.');
    let contextPromise = this.contexts.get(key);
    if (!contextPromise) {
      contextPromise = this.mainProfile
        ? this.connectMain()
        : chromium.launchPersistentContext(
            join(this.dataDir, 'browser-profiles', 'chrome', 'workspaces', key),
            {
              channel: 'chrome',
              headless: this.headless,
              acceptDownloads: false,
              viewport: this.headless ? { width: 1280, height: 800 } : null,
            },
          );
      this.contexts.set(key, contextPromise);
    }
    let context: BrowserContext;
    try {
      context = await contextPromise;
    } catch {
      if (this.contexts.get(key) === contextPromise) this.contexts.delete(key);
      throw new ApiError(
        503,
        this.mainProfile
          ? 'Main Chrome could not connect. On this workspace’s computer, open Chrome 144 or newer, enable remote debugging at chrome://inspect/#remote-debugging, then retry and allow Chrome’s connection request. For a VM workspace, do this inside the VM. No other browser profile was opened.'
          : 'Chrome could not start. Install Google Chrome and try again. Mukai uses a separate browser profile.',
      );
    }
    if (this.closed) {
      await this.closeContext(context);
      throw new ApiError(503, 'Browser is shutting down.');
    }
    const emptyPages =
      !this.mainProfile && !this.configured.has(context)
        ? context.pages().filter((page) => page.url() === 'about:blank')
        : [];
    if (!this.configured.has(context)) {
      // Registered once per context, rather than once per tab.
      this.configured.add(context);
      context.once('close', () => {
        if (this.contexts.get(key) === contextPromise) this.contexts.delete(key);
      });
    }
    const opener = context
      .pages()
      .find((page) => !page.isClosed() && this.conversations.get(page) === conversationId);
    // Create the first tab in a separate window; additional tabs stay with their conversation.
    const page = this.headless ? await context.newPage() : await this.newPage(context, opener);
    this.ownedPages.add(page);
    page.once('close', () => this.ownedPages.delete(page));
    this.conversations.set(page, conversationId);
    for (const empty of emptyPages) if (!empty.isClosed()) await empty.close();
    page.on('popup', (popup) => {
      if (!this.opening.has(popup.url())) void popup.close().catch(() => {});
    });
    let client: CDPSession;
    try {
      client = await context.newCDPSession(page);
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
    return {
      send: async (method, params) => {
        if (method === 'Page.captureScreenshot' && !this.headless) {
          // A loaded DOM can precede the first composited frame in a new native window.
          await browserCommand(page.bringToFront());
          const { frameTree } = await browserCommand(client.send('Page.getFrameTree'));
          const { executionContextId } = await browserCommand(
            client.send('Page.createIsolatedWorld', {
              frameId: frameTree.frame.id,
              worldName: 'mukai-browser-capture',
            }),
          );
          await browserCommand(
            client.send('Runtime.evaluate', {
              expression:
                'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
              contextId: executionContextId,
              awaitPromise: true,
              timeout: 10000,
            }),
          );
        }
        return browserCommand(
          client.send(method as Parameters<typeof client.send>[0], params as never),
        ) as Promise<Record<string, unknown>>;
      },
      close: async () => {
        await this.serialize(key, async () => {
          await page.close();
          if (!this.mainProfile && context.pages().length === 0) await context.close();
        });
      },
      isClosed: () => page.isClosed(),
    };
  }
  private async closeContext(context: BrowserContext) {
    if (this.mainProfile) {
      // For a CDP-attached browser, Playwright browser.close() disconnects the transport.
      // context.close() would close the user's personal browser and tabs.
      await this.attached.get(context)?.close();
    } else await context.close();
  }
  private async newPage(context: BrowserContext, opener?: Page): Promise<Page> {
    const browser = context.browser();
    if (!browser) throw new Error('Chrome browser connection is unavailable.');
    const control = await browser.newBrowserCDPSession();
    const url = 'about:blank#' + randomUUID();
    let targetId: string | undefined;
    this.opening.add(url);
    try {
      if (opener) {
        const client = await context.newCDPSession(opener);
        try {
          const { frameTree } = await client.send('Page.getFrameTree');
          const { executionContextId } = await client.send('Page.createIsolatedWorld', {
            frameId: frameTree.frame.id,
            worldName: 'mukai-browser-windows',
          });
          // Use a native window.open in an isolated world so page scripts cannot replace it.
          await client.send('Runtime.evaluate', {
            expression: `window.open(${JSON.stringify(url)}, '_blank'); void 0`,
            contextId: executionContextId,
          });
        } finally {
          await client.detach().catch(() => {});
        }
      } else {
        ({ targetId } = await control.send('Target.createTarget', { url, newWindow: true }));
      }
      return await new Promise<Page>((resolve, reject) => {
        const observed = new Set<Page>();
        let settled = false;
        const cleanup = () => {
          settled = true;
          clearTimeout(timer);
          context.off('page', observe);
          context.off('close', closed);
          for (const page of observed) page.off('framenavigated', changed);
        };
        const changed = () => {
          const page = [...observed].find((candidate) => candidate.url() === url);
          if (page) {
            cleanup();
            resolve(page);
          }
        };
        const observe = (page: Page) => {
          if (settled) return;
          observed.add(page);
          page.on('framenavigated', changed);
          changed();
        };
        const closed = () => {
          cleanup();
          reject(new Error('Chrome closed while opening a window.'));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Chrome window did not become ready.'));
        }, 15000);
        context.on('page', observe);
        context.once('close', closed);
        for (const page of context.pages()) observe(page);
        if (!browser.isConnected()) closed();
      });
    } catch (error) {
      if (targetId) await control.send('Target.closeTarget', { targetId }).catch(() => {});
      throw error;
    } finally {
      this.opening.delete(url);
      await control.detach().catch(() => {});
    }
  }
  async shutdown() {
    this.closed = true;
    await Promise.allSettled([...this.operations.values()]);
    await Promise.allSettled([...this.ownedPages].map((page) => page.close()));
    await Promise.allSettled(
      [...this.contexts.values()].map(async (value) => this.closeContext(await value)),
    );
    this.contexts.clear();
  }
}
