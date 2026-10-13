import { afterEach, expect, it, vi } from 'vitest';
import { BrowserService } from './browserService';
import type { EmbeddedBrowserHost, BrowserPage } from '../browser/types';
import { chromium } from 'playwright-core';
import { MainChromeProfiles } from '../browser/mainChromeProfiles';
import { ChromeHost } from '../browser/chromeHost';
const owner = { workspaceId: 'workspace', botId: 'scout', conversationId: 'chat' };
const signal = () => new AbortController().signal;
let service: BrowserService | undefined;
afterEach(async () => {
  await service?.shutdown();
  vi.restoreAllMocks();
});
it('uses an explicitly supplied guest Chromium executable and retains Chrome for local mode', async () => {
  const launch = vi
    .spyOn(chromium, 'launchPersistentContext')
    .mockRejectedValue(new Error('fixture stops before browser launch'));
  service = new BrowserService('unused', undefined, true, '/usr/local/bin/mukai-browser');
  await expect(
    service.execute(
      owner,
      { action: 'open', target: 'chrome', url: 'https://example.com' },
      signal(),
    ),
  ).rejects.toThrow('Chromium could not start');
  expect(launch).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ executablePath: '/usr/local/bin/mukai-browser' }),
  );
  expect(launch.mock.calls.at(-1)![1]).not.toHaveProperty('channel');
  await service.shutdown();
  service = new BrowserService('unused', undefined, true);
  await expect(
    service.execute(
      owner,
      { action: 'open', target: 'chrome', url: 'https://example.com' },
      signal(),
    ),
  ).rejects.toThrow('Chrome could not start');
  expect(launch).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ channel: 'chrome' }),
  );
  expect(launch.mock.calls.at(-1)![1]).not.toHaveProperty('executablePath');
});
it('lists main Chrome profiles without starting or connecting to a browser', async () => {
  const profiles = [{ id: 'Profile 1', name: 'Work', lastUsed: true }];
  vi.spyOn(MainChromeProfiles.prototype, 'list').mockResolvedValue(profiles);
  const connect = vi.spyOn(chromium, 'connectOverCDP');
  const launch = vi.spyOn(chromium, 'launchPersistentContext');
  const { service, host } = fixture();
  expect(await service.execute(owner, { action: 'profiles' }, signal())).toEqual({
    target: 'chrome-default',
    profiles,
  });
  expect(connect).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
  expect(host.open).not.toHaveBeenCalled();
});
it('rejects unknown profiles and profile selection on other browser modes before opening tabs', async () => {
  vi.spyOn(MainChromeProfiles.prototype, 'list').mockResolvedValue([
    { id: 'Default', name: 'Personal', lastUsed: true },
  ]);
  const connect = vi.spyOn(chromium, 'connectOverCDP');
  const { service, host } = fixture();
  await expect(
    service.execute(
      owner,
      {
        action: 'open',
        target: 'chrome-default',
        profileId: 'Unknown',
        url: 'https://example.com',
      },
      signal(),
    ),
  ).rejects.toThrow('not found');
  await expect(
    service.execute(
      owner,
      { action: 'open', target: 'mukai', profileId: 'Default', url: 'https://example.com' },
      signal(),
    ),
  ).rejects.toThrow('only supported');
  await expect(
    service.execute(owner, { action: 'profiles', target: 'chrome' }, signal()),
  ).rejects.toThrow('main Chrome');
  expect(connect).not.toHaveBeenCalled();
  expect(host.open).not.toHaveBeenCalled();
});
it('passes the requested main profile and returns the verified profile in session results', async () => {
  const { service, page, host } = fixture();
  const profile = { id: 'Profile 1', name: 'Work', lastUsed: false };
  page.profile = profile;
  const open = vi.spyOn(ChromeHost.prototype, 'open').mockResolvedValue(page);
  const result = await service.execute(
    owner,
    { action: 'open', target: 'chrome-default', profileId: profile.id, url: 'https://example.com' },
    signal(),
  );
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ ...owner, target: 'chrome-default' }),
    profile.id,
  );
  expect(result).toMatchObject({ tab: { target: 'chrome-default', profile } });
  expect(service.list(owner.workspaceId)[0].profile).toEqual(profile);
  expect(host.open).not.toHaveBeenCalled();
});
it('reports main Chrome setup failures without opening inline or a replacement profile', async () => {
  const connect = vi.spyOn(chromium, 'connectOverCDP').mockRejectedValue(new Error('Not enabled'));
  const launch = vi.spyOn(chromium, 'launchPersistentContext');
  const { service, host } = fixture();
  await expect(
    service.execute(
      owner,
      {
        action: 'open',
        target: 'chrome-default',
        url: 'https://example.com',
      },
      signal(),
    ),
  ).rejects.toThrow('chrome://inspect/#remote-debugging');
  expect(connect).toHaveBeenCalledWith('chrome', { noDefaults: true, timeout: 20000 });
  expect(host.open).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
  expect(service.list(owner.workspaceId)).toEqual([]);
  // A missing/denied connection must be evicted so a later attempt can ask Chrome again.
  await expect(
    service.execute(
      owner,
      {
        action: 'open',
        target: 'chrome-default',
        url: 'https://example.com',
      },
      signal(),
    ),
  ).rejects.toThrow('Main Chrome');
  expect(connect).toHaveBeenCalledTimes(2);
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
    service.execute(
      owner,
      { action: 'open', target: 'mukai', url: 'https://example.com' },
      signal(),
    ),
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
it('standalone mode defaults to workspace Chrome without invoking embedded browsing', async () => {
  service = new BrowserService('unused');
  const open = vi
    .spyOn(ChromeHost.prototype, 'open')
    .mockRejectedValue(new Error('workspace Chrome selected'));
  await expect(
    service.execute(owner, { action: 'open', url: 'https://example.com' }, signal()),
  ).rejects.toThrow('workspace Chrome selected');
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ target: 'chrome' }), undefined);
});

it('closes workspace-owned tabs while retaining another workspace tabs', async () => {
  const { service, host, page } = fixture();
  const closeDeleted = vi.fn(async () => {});
  const closeOther = vi.fn(async () => {});
  vi.mocked(host.open)
    .mockResolvedValueOnce({ ...page, close: closeDeleted })
    .mockResolvedValueOnce({ ...page, close: closeOther });
  await service.execute(owner, { action: 'open', url: 'https://example.com' }, signal());
  const other = { ...owner, workspaceId: 'other' };
  await service.execute(other, { action: 'open', url: 'https://example.com' }, signal());
  await service.stopWorkspace(owner.workspaceId);
  expect(closeDeleted).toHaveBeenCalledTimes(1);
  expect(closeOther).not.toHaveBeenCalled();
  expect(service.list(owner.workspaceId)).toEqual([]);
  expect(service.list(other.workspaceId)).toHaveLength(1);
  await expect(
    service.execute(owner, { action: 'open', url: 'https://example.com' }, signal()),
  ).rejects.toThrow('being deleted');
});
