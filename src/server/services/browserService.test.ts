import { afterEach, expect, it, vi } from 'vitest';
import { BrowserService } from './browserService';
import type { EmbeddedBrowserHost, BrowserPage } from '../browser/types';
const owner = { workspaceId: 'workspace', botId: 'scout', conversationId: 'chat' };
const signal = () => new AbortController().signal;
let service: BrowserService | undefined;
afterEach(async () => {
  await service?.shutdown();
});
function fixture() {
  let closed = false;
  const send = vi.fn(async (method: string) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
    if (method === 'Runtime.evaluate')
      return {
        result: {
          value: { url: 'https://example.com/', title: 'Example', text: 'Page text', controls: [] },
        },
      };
    if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') };
    return {};
  });
  const page: BrowserPage = {
    send,
    isClosed: () => closed,
    close: async () => {
      closed = true;
    },
  };
  const host: EmbeddedBrowserHost = {
    open: vi.fn(async () => page),
    bounds: () => {},
    shutdown: async () => {},
  };
  service = new BrowserService('unused', host);
  return { host, page, send, service };
}
it('owns tabs per conversation and workspace, updates snapshots, and closes sessions', async () => {
  const { service, send } = fixture();
  const opened = (await service.execute(
    owner,
    { action: 'open', url: 'https://example.com' },
    signal(),
  )) as { tab: { id: string } };
  const id = opened.tab.id;
  expect(service.list(owner.workspaceId)).toHaveLength(1);
  expect(service.list('other')).toEqual([]);
  await expect(
    service.execute(
      { ...owner, conversationId: 'other' },
      { action: 'close', sessionId: id },
      signal(),
    ),
  ).rejects.toThrow('not found');
  await expect(
    service.execute({ ...owner, botId: 'other-bot' }, { action: 'close', sessionId: id }, signal()),
  ).rejects.toThrow('not found');
  await service.execute(owner, { action: 'snapshot', sessionId: id }, signal());
  expect(send).toHaveBeenCalledWith('Page.createIsolatedWorld', {
    frameId: 'main',
    worldName: 'mukai-browser-tools',
  });
  expect(service.list(owner.workspaceId)[0].title).toBe('Example');
  await service.execute(owner, { action: 'screenshot', sessionId: id }, signal());
  expect(service.screenshot(id).toString()).toBe('png');
  await service.execute(owner, { action: 'close', sessionId: id }, signal());
  expect(service.list(owner.workspaceId)).toEqual([]);
});
it('rejects unsupported schemes, embedded credentials, and missing sessions before performing actions', async () => {
  const { service, host } = fixture();
  for (const url of [
    'file:///C:/secret.txt',
    'javascript:alert(1)',
    'https://user:password@example.com',
  ])
    await expect(service.execute(owner, { action: 'open', url }, signal())).rejects.toThrow('HTTP');
  expect(host.open).not.toHaveBeenCalled();
  await expect(
    service.execute(owner, { action: 'click', ref: 'missing' }, signal()),
  ).rejects.toThrow('sessionId');
});
it('handles unavailable embedded browsing and cancellation without leaking a tab', async () => {
  service = new BrowserService('unused');
  await expect(
    service.execute(owner, { action: 'open', url: 'https://example.com' }, signal()),
  ).rejects.toThrow('desktop');
  const { service: available, page } = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    available.execute(owner, { action: 'open', url: 'https://example.com' }, controller.signal),
  ).rejects.toThrow();
  expect(available.list(owner.workspaceId)).toEqual([]);
  expect(page.isClosed()).toBe(false);
});
