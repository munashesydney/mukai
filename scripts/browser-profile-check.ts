import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { ChromeHost } from '../src/server/browser/chromeHost';
import { MainChromeProfiles } from '../src/server/browser/mainChromeProfiles';
import { PageDriver } from '../src/server/browser/pageDriver';
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
export async function checkSharedChromeProfiles(
  directory: string,
  url: string,
  headless = false,
  executablePath?: string,
) {
  let host = new ChromeHost(directory, headless, 'workspace', undefined, executablePath);
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
    host = new ChromeHost(directory, headless, 'workspace', undefined, executablePath);
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

/** Uses a disposable daily-browser stand-in; never connects to the developer's personal Chrome.
 * The endpoint override substitutes only discovery/consent, leaving the actual CDP connection real.
 */
export async function checkMainChromeProfile(directory: string, executablePath?: string) {
  const server = createServer((_request, response) =>
    response
      .writeHead(200, {
        'Content-Type': 'text/html',
      })
      .end(
        "<title>Main Chrome fixture</title><h1>Signed in</h1><label>Message<input></label><button onclick=\"document.querySelector('h1').textContent=document.querySelector('input').value\">Apply</button>",
      ),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const profile = join(directory, 'main-chrome-fixture');
  const context = await chromium.launchPersistentContext(profile, {
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    headless: false,
    viewport: null,
    args: ['--remote-debugging-port=0'],
  });
  const connect = chromium.connectOverCDP;
  const connectEndpoint = chromium.connectOverCDP.bind(chromium) as (
    endpoint: string,
    options?: { noDefaults?: boolean; timeout?: number },
  ) => ReturnType<typeof connect>;
  const profiles = new MainChromeProfiles(profile, executablePath);
  let host = new ChromeHost(directory, false, 'main', profiles);
  try {
    const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8'))
      .trim()
      .split(/\r?\n/);
    chromium.connectOverCDP = ((endpoint, options) => {
      assert.equal(
        endpoint,
        'chrome',
        'Production must discover the local main Chrome, never a remote host',
      );
      assert.equal(options?.noDefaults, true, 'Preserve the daily browser settings');
      return connectEndpoint(`ws://127.0.0.1:${port}${path}`, options);
    }) as typeof connect;
    const personal = context.pages()[0];
    await personal.goto(url);
    await context.addCookies([
      { name: 'mukai-profile-test', value: 'user-already-signed-in', url },
    ]);
    const [first, second] = await Promise.all([
      host.open({ ...info('workspace-one', 'one', 'conversation-one'), target: 'chrome-default' }),
      host.open({ ...info('workspace-two', 'two', 'conversation-two'), target: 'chrome-default' }),
    ]);
    assert.equal(await cookie(first, url), 'user-already-signed-in');
    assert.equal(await cookie(second, url), 'user-already-signed-in');
    const third = await host.open({
      ...info('workspace-one', 'one', 'conversation-one'),
      target: 'chrome-default',
    });
    const a = await first.send('Browser.getWindowForTarget');
    const b = await second.send('Browser.getWindowForTarget');
    const c = await third.send('Browser.getWindowForTarget');
    assert.notEqual(a.windowId, b.windowId);
    assert.equal(a.windowId, c.windowId);
    const driver = new PageDriver(first);
    await driver.navigate(url);
    type Snapshot = { title: string; text: string; controls: { name: string; ref: string }[] };
    let snapshot = (await driver.snapshot()) as Snapshot;
    for (let attempt = 0; snapshot.title !== 'Main Chrome fixture' && attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      snapshot = (await driver.snapshot()) as Snapshot;
    }
    const input = snapshot.controls.find((control) => control.name === 'Message');
    const button = snapshot.controls.find((control) => control.name === 'Apply');
    assert(input && button);
    await driver.interact('type', input.ref, 'Shared main profile works');
    await driver.interact('click', button.ref);
    assert.match((await driver.snapshot()).text, /Shared main profile works/);
    assert((await driver.screenshot()).length > 1000);
    await first.close();
    assert.equal(second.isClosed(), false);
    assert.equal(personal.isClosed(), false);
    await host.shutdown();
    assert.equal(second.isClosed(), true);
    assert.equal(third.isClosed(), true);
    assert.equal(personal.isClosed(), false, 'Disconnect must leave the user browser open');
    assert.equal(await personal.title(), 'Main Chrome fixture');
    assert.equal(context.pages().length, 1, 'Only tool-owned tabs should have been closed');
    host = new ChromeHost(directory, false, 'main', profiles);
    const reconnected = await host.open({
      ...info('workspace-one', 'one', 'new-chat'),
      target: 'chrome-default',
    });
    assert.equal(await cookie(reconnected, url), 'user-already-signed-in');
    assert.equal(reconnected.profile?.id, 'Default');
    // Create another personal profile only in this disposable Chrome data directory.
    const marker = url + '?bootstrap=' + randomUUID();
    const before = new Set(context.pages());
    await profiles.openWindow({ id: 'Profile 1', name: 'Work', lastUsed: false }, marker);
    let workPersonal = context.pages().find((page) => !before.has(page));
    let available = await profiles.list();
    for (
      let attempt = 0;
      (!workPersonal || !available.some((item) => item.id === 'Profile 1')) && attempt < 100;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      workPersonal = context.pages().find((page) => !before.has(page));
      available = await profiles.list();
    }
    assert(workPersonal, 'Chrome must open the requested profile window');
    assert.equal((await profiles.identify(workPersonal)).id, 'Profile 1');
    assert(available.some((item) => item.id === 'Default'));
    assert(available.some((item) => item.id === 'Profile 1'));
    const workClient = await context.newCDPSession(workPersonal);
    await workClient.send('Network.setCookie', {
      name: 'mukai-profile-test',
      value: 'work-profile',
      url,
    });
    await workClient.detach();
    const owner = info('profile-selection', 'one', 'same-conversation');
    const [personalBot, workBot] = await Promise.all([
      host.open(owner, 'Default'),
      host.open(owner, 'Profile 1'),
    ]);
    assert.equal(personalBot.profile?.id, 'Default');
    assert.equal(workBot.profile?.id, 'Profile 1');
    assert.equal(await cookie(personalBot, url), 'user-already-signed-in');
    assert.equal(await cookie(workBot, url), 'work-profile');
    assert.notEqual(
      (await personalBot.send('Browser.getWindowForTarget')).windowId,
      (await workBot.send('Browser.getWindowForTarget')).windowId,
    );
    // Chrome's current profile is Work now. The next Personal tab must still use Personal.
    const extraPersonal = await host.open(owner, 'Default');
    assert.equal(extraPersonal.profile?.id, 'Default');
    assert.equal(await cookie(extraPersonal, url), 'user-already-signed-in');
    assert.equal(
      (await personalBot.send('Browser.getWindowForTarget')).windowId,
      (await extraPersonal.send('Browser.getWindowForTarget')).windowId,
    );
    await host.shutdown();
    assert.equal(personal.isClosed(), false);
    assert.equal(workPersonal.isClosed(), false);
    assert.equal(context.pages().length, 2, 'Cleanup must preserve both personal profiles');
    class MisroutedProfiles extends MainChromeProfiles {
      override openWindow(
        profile: Parameters<MainChromeProfiles['openWindow']>[0],
        marker: string,
      ) {
        return super.openWindow({ ...profile, id: 'Default' }, marker);
      }
    }
    const misrouted = new ChromeHost(
      directory,
      false,
      'main',
      new MisroutedProfiles(profile, executablePath),
    );
    try {
      await assert.rejects(
        misrouted.open(info('wrong-profile', 'one', 'verify'), 'Profile 1'),
        /different profile/,
      );
      assert.equal(context.pages().length, 2, 'A mismatched tool-created tab must be closed');
    } finally {
      await misrouted.shutdown();
    }
    console.log(
      'PASS main Chrome: existing login, real interactions, named profile discovery/selection, separate cookies and windows, profile remains fixed after switching, mismatches rejected, personal tabs survive shutdown, reconnect',
    );
  } finally {
    await host.shutdown();
    chromium.connectOverCDP = connect;
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
