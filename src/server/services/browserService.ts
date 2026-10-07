import { randomUUID } from 'node:crypto';
import type { BrowserSession, RuntimeOwner } from '../../shared/runtime';
import type { EmbeddedBrowserHost } from '../browser/types';
import { ChromeHost } from '../browser/chromeHost';
import { PageDriver } from '../browser/pageDriver';
import { ApiError } from '../config';
import type { BrowserInput } from '../tools/browser/definition';

function browserUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, 'Use a complete http:// or https:// URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new ApiError(400, 'Browser URLs must use HTTP or HTTPS without embedded credentials.');
  return url.href;
}
export class BrowserService {
  private sessions = new Map<
    string,
    { info: BrowserSession; driver: PageDriver; queue: Promise<unknown>; image?: Buffer }
  >();
  private chrome: ChromeHost;
  private closed = false;
  private activation = 0;
  constructor(
    dataDir: string,
    readonly embedded?: EmbeddedBrowserHost,
    headless = false,
  ) {
    this.chrome = new ChromeHost(dataDir, headless);
  }
  list(workspaceId: string, conversationId?: string) {
    for (const [id, entry] of this.sessions)
      if (entry.driver.page.isClosed()) this.sessions.delete(id);
    return [...this.sessions.values()]
      .filter(
        (entry) =>
          entry.info.workspaceId === workspaceId &&
          (!conversationId || entry.info.conversationId === conversationId),
      )
      .map((entry) => entry.info);
  }
  screenshot(id: string) {
    const entry = this.sessions.get(id);
    if (!entry?.image) throw new ApiError(404, 'No screenshot is available.');
    return entry.image;
  }
  async refresh(workspaceId: string) {
    const tabs = this.list(workspaceId);
    await Promise.allSettled(
      tabs.map(async (tab) => {
        const entry = this.require(tab.id);
        const state = (await entry.driver.evaluate(
          '({url:location.href,title:document.title})',
        )) as { url: string; title: string };
        entry.info.url = state.url;
        entry.info.title = state.title;
      }),
    );
    return this.list(workspaceId);
  }
  private require(id: string, owner?: RuntimeOwner) {
    const entry = this.sessions.get(id);
    if (
      !entry ||
      entry.driver.page.isClosed() ||
      (owner &&
        (owner.workspaceId !== entry.info.workspaceId ||
          owner.botId !== entry.info.botId ||
          owner.conversationId !== entry.info.conversationId))
    )
      throw new ApiError(404, 'Browser tab not found in this conversation.');
    return entry;
  }
  async execute(owner: RuntimeOwner, input: BrowserInput, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.closed) throw new ApiError(503, 'Browser is shutting down.');
    if (input.action === 'tabs')
      return {
        tabs: this.list(owner.workspaceId, owner.conversationId).filter(
          (tab) => tab.botId === owner.botId,
        ),
      };
    if (input.action === 'open') {
      const url = browserUrl(input.url || '');
      if (this.sessions.size >= 12)
        throw new ApiError(429, 'Close a browser tab before opening another.');
      const info: BrowserSession = {
        ...owner,
        id: randomUUID(),
        target: input.target || 'mukai',
        url,
        title: 'New tab',
        createdAt: new Date().toISOString(),
        activation: ++this.activation,
      };
      const page =
        info.target === 'mukai' ? await this.embedded?.open(info) : await this.chrome.open(info);
      if (!page)
        throw new ApiError(
          503,
          'The embedded Mukai browser is available in the desktop app. Use Chrome on the standalone server.',
        );
      if (signal.aborted || this.closed) {
        await page.close();
        signal.throwIfAborted();
        throw new ApiError(503, 'Browser is shutting down.');
      }
      const entry = { info, driver: new PageDriver(page), queue: Promise.resolve() };
      this.sessions.set(info.id, entry);
      try {
        await entry.driver.navigate(url);
      } catch (error) {
        await page.close();
        this.sessions.delete(info.id);
        throw error;
      }
      return { tab: info, summary: 'Opened browser tab. Take a snapshot before interacting.' };
    }
    if (!input.sessionId) throw new ApiError(400, 'sessionId is required for this browser action.');
    const entry = this.require(input.sessionId, owner);
    if (input.action !== 'close') entry.info.activation = ++this.activation;
    const operation = entry.queue
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted();
        this.require(input.sessionId!, owner);
        const driver = entry.driver;
        switch (input.action) {
          case 'navigate': {
            const url = browserUrl(input.url || '');
            await driver.navigate(url);
            entry.info.url = url;
            return { summary: 'Navigation started.' };
          }
          case 'snapshot': {
            const snapshot = await driver.snapshot();
            entry.info.url = snapshot.url;
            entry.info.title = snapshot.title;
            return snapshot;
          }
          case 'click':
          case 'type':
            if (!input.ref) throw new ApiError(400, 'Use a control ref from the latest snapshot.');
            return driver.interact(input.action, input.ref, input.text);
          case 'press':
            return driver.press(input.key || '');
          case 'scroll':
            return driver.scroll(input.direction || 'down', input.pixels ?? 600);
          case 'back':
            return driver.history(-1);
          case 'forward':
            return driver.history(1);
          case 'reload':
            await driver.page.send('Page.reload');
            return { summary: 'Reload started.' };
          case 'screenshot': {
            const data = await driver.screenshot();
            entry.image = Buffer.from(data, 'base64');
            return {
              summary: 'Captured viewport screenshot.',
              screenshotUrl: `/browser/${entry.info.id}/screenshot`,
              image: data,
            };
          }
          case 'close':
            await driver.page.close();
            this.sessions.delete(entry.info.id);
            return { summary: 'Closed browser tab.' };
        }
      });
    entry.queue = operation;
    return operation;
  }
  async control(id: string, input: BrowserInput) {
    const entry = this.require(id);
    return this.execute(entry.info, { ...input, sessionId: id }, new AbortController().signal);
  }
  async shutdown() {
    this.closed = true;
    await Promise.allSettled([...this.sessions.values()].map((entry) => entry.driver.page.close()));
    await this.chrome.shutdown();
    await this.embedded?.shutdown();
    this.sessions.clear();
  }
}
