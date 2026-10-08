import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ChromeHost } from '../src/server/browser/chromeHost';
import type { BrowserPage, EmbeddedBrowserHost } from '../src/server/browser/types';
import type { BrowserSession } from '../src/shared/runtime';

function info(workspaceId: string, botId: string, conversationId: string): BrowserSession {
  return {
    workspaceId,
    botId,
    conversationId,
    id: randomUUID(),
    target: 'chrome',
    url: 'about:blank',
    title: 'Test',
    createdAt: new Date().toISOString(),
    activation: 1,
  };
}
async function cookie(page: BrowserPage, url: string) {
  const result = await page.send('Network.getCookies', { urls: [url] });
  return (result.cookies as { name: string; value: string }[]).find(
    (item) => item.name === 'mukai-profile-test',
  )?.value;
}
async function setCookie(page: BrowserPage, url: string) {
  await page.send('Network.setCookie', {
    name: 'mukai-profile-test',
    value: 'shared-workspace',
    url,
    expires: Math.floor(Date.now() / 1000) + 3600,
  });
}
export async function checkSharedChromeProfiles(directory: string, url: string, headless = false) {
  let host = new ChromeHost(directory, headless);
  try {
    const [first, second] = await Promise.all([
      host.open(info('profile-test', 'one', 'conversation-one')),
      host.open(info('profile-test', 'two', 'conversation-two')),
    ]);
    await setCookie(first, url);
    assert.equal(
      await cookie(second, url),
      'shared-workspace',
      'Different bots/conversations must share the workspace login',
    );
    await first.send('Runtime.evaluate', {
      expression:
        "window.open = () => { throw new Error('Page scripts must not intercept tool-created tabs'); };",
    });
    const third = await host.open(info('profile-test', 'one', 'conversation-one'));
    if (!headless) {
      const a = await first.send('Browser.getWindowForTarget');
      const b = await second.send('Browser.getWindowForTarget');
      const c = await third.send('Browser.getWindowForTarget');
      assert.notEqual(
        a.windowId,
        b.windowId,
        'Different conversations need separate native windows',
      );
      assert.equal(
        a.windowId,
        c.windowId,
        'Additional tabs should stay in their conversation window',
      );
    }
    await first.close();
    assert.equal(second.isClosed(), false, 'Closing one conversation must not close another');
    assert.equal(await cookie(third, url), 'shared-workspace');
    const isolated = await host.open(info('other-workspace', 'one', 'conversation-one'));
    assert.equal(
      await cookie(isolated, url),
      undefined,
      'Other workspaces must not inherit logins',
    );
    await isolated.close();
    await second.close();
    await third.close();
    const reopened = await host.open(info('profile-test', 'three', 'new-conversation'));
    assert.equal(
      await cookie(reopened, url),
      'shared-workspace',
      'Closing all windows must preserve logins',
    );
    await host.shutdown();
    host = new ChromeHost(directory, headless);
    const restarted = await host.open(info('profile-test', 'four', 'after-restart'));
    assert.equal(
      await cookie(restarted, url),
      'shared-workspace',
      'Restarting the host must preserve logins',
    );
    console.log(
      'PASS Chrome profiles: shared logins, conversation windows, same-conversation tabs, workspace isolation, close/reopen, restart',
    );
  } finally {
    await host.shutdown();
  }
}

export async function checkSharedInlineProfiles(host: EmbeddedBrowserHost, url: string) {
  const first = await host.open(info('profile-test', 'one', 'conversation-one'));
  const second = await host.open(info('profile-test', 'two', 'conversation-two'));
  const isolated = await host.open(info('other-inline-workspace', 'one', 'conversation-one'));
  try {
    assert.equal(
      await cookie(first, url),
      undefined,
      'Inline and Chrome logins must remain separate',
    );
    await setCookie(first, url);
    assert.equal(await cookie(second, url), 'shared-workspace');
    assert.equal(await cookie(isolated, url), undefined);
    await first.close();
    assert.equal(second.isClosed(), false);
    assert.equal(await cookie(second, url), 'shared-workspace');
    console.log(
      'PASS inline profiles: shared logins across bots/conversations, workspace isolation, independent tabs',
    );
  } finally {
    await Promise.all([first.close(), second.close(), isolated.close()]);
  }
}
