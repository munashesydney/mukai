import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { BrowserSession } from '../../shared/runtime';
import type { BrowserPage } from './types';
import { browserCommand } from './types';
import { ApiError } from '../config';

export class ChromeHost {
  private contexts = new Map<string, Promise<BrowserContext>>();
  private pages = new WeakSet<Page>();
  constructor(
    private dataDir: string,
    private headless = false,
  ) {}
  async open(info: BrowserSession): Promise<BrowserPage> {
    const key = createHash('sha256')
      .update(info.workspaceId + '/' + info.botId + '/' + info.conversationId)
      .digest('hex');
    let contextPromise = this.contexts.get(key);
    if (!contextPromise) {
      contextPromise = chromium.launchPersistentContext(
        join(this.dataDir, 'browser-profiles', 'chrome', key),
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
      this.contexts.delete(key);
      throw new ApiError(
        503,
        'Chrome could not start. Install Google Chrome and try again. Mukai uses a separate browser profile.',
      );
    }
    context.once('close', () => this.contexts.delete(key));
    const emptyPages = context
      .pages()
      .filter((page) => page.url() === 'about:blank' && !this.pages.has(page));
    const page = await context.newPage();
    this.pages.add(page);
    for (const empty of emptyPages)
      if (!this.pages.has(empty) && !empty.isClosed()) await empty.close();
    page.on('popup', (popup) => {
      void popup.close();
    });
    const client = await context.newCDPSession(page);
    return {
      send: (method, params) =>
        browserCommand(
          client.send(method as Parameters<typeof client.send>[0], params as never),
        ) as Promise<Record<string, unknown>>,
      close: async () => {
        await page.close();
        if (context.pages().length === 0) await context.close();
      },
      isClosed: () => page.isClosed(),
    };
  }
  async shutdown() {
    await Promise.allSettled(
      [...this.contexts.values()].map(async (value) => (await value).close()),
    );
    this.contexts.clear();
  }
}
