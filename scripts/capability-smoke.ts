// Exercise the built Electron renderer and workers using disposable local data.
import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApiServer } from '../src/server/app';
import { seedTestBot } from '../src/server/testFixtures';
import { IPC } from '../src/shared/contracts';

async function main() {
  const root = process.env.MUKAI_CAPABILITY_SMOKE_DIR;
  if (!root) throw new Error('The smoke runner must provide a disposable data directory.');
  app.setPath('userData', root);
  await app.whenReady();
  const folder = join(root, 'workspace');
  mkdirSync(folder);
  const api = await startApiServer(0, { dataDir: join(root, 'data') });
  seedTestBot(api.store);
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(api.url + path, {
      method,
      headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert(response.ok, await response.clone().text());
    return response.json();
  };
  await request('/workspaces/default', 'PUT', { name: 'Personal', folder });
  writeFileSync(
    join(folder, 'echo.ts'),
    `export default {name:'echo_custom',description:'Echo a value',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},requiredEnv:['SMOKE_KEY'],execute:(args,context)=>({value:args.value,configured:!!context.env.SMOKE_KEY})};`,
  );
  writeFileSync(
    join(folder, 'route.js'),
    `export default {name:'smoke_route',method:'POST',path:'/custom/smoke',auth:'mukai',handle:r=>({status:200,body:{received:r.body}})};`,
  );
  for (const [channel, callback] of [
    [IPC.apiConnection, () => ({ url: api.url, token: api.token })],
    [IPC.health, () => ({ status: 'ok' })],
    [IPC.browserBounds, () => {}],
  ] as const)
    ipcMain.handle(channel, () => callback());
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1050,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(process.cwd(), 'out/preload/index.js'),
    },
  });
  const errors: string[] = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level === 3) errors.push(message);
  });
  const evaluate = async <T>(code: string) => {
    try {
      return (await window.webContents.executeJavaScript(code)) as T;
    } catch (error) {
      console.error(
        'Smoke renderer state:',
        await window.webContents.executeJavaScript('document.body.innerText'),
      );
      console.error('Smoke renderer errors:', errors.join('\n'));
      throw error;
    }
  };
  const wait = async (code: string, name: string) => {
    for (let i = 0; i < 100; i++) {
      if (
        await evaluate<boolean>(`(() => { try { return (${code}); } catch { return false; } })()`)
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      name + ' did not settle: ' + (await evaluate<string>('document.body.innerText')),
    );
  };
  const click = async (selector: string, text?: string) => {
    await wait(
      `Boolean([...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>!e.disabled && (${text ? 'e.textContent.trim()===' + JSON.stringify(text) : 'true'})))`,
      'control ' + (text || selector),
    );
    return evaluate(
      `(() => {const element=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${text ? 'e.textContent.trim()===' + JSON.stringify(text) : 'true'});if(!element)throw new Error('Control not found');element.click();})()`,
    );
  };
  const fill = async (selector: string, value: string) =>
    evaluate(
      `(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Field not found');const prototype=element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:element.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event(element.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`,
    );
  const checkSheet = async (name: string) => {
    await wait(
      'Boolean(document.querySelector("dialog.sheet[open] .capability-sheet-body"))',
      name + ' sheet',
    );
    assert(
      await evaluate<boolean>(
        `parseFloat(getComputedStyle(document.querySelector('.capability-sheet-body')).paddingLeft) >= 20`,
      ),
      name + ' sheet must have body padding',
    );
    await evaluate(
      `Promise.all([...document.querySelector('dialog.sheet').getAnimations()].map(animation=>animation.finished))`,
    );
    mkdirSync(join(process.cwd(), 'artifacts'), { recursive: true });
    writeFileSync(
      join(process.cwd(), 'artifacts', 'capabilities-sheet-' + name + '.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
  };
  try {
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await evaluate(
      `localStorage.setItem('mukai.appearance.v1', JSON.stringify({mode:'dark',theme:'rose'}))`,
    );
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await wait('Boolean(document.querySelector(".rail-links"))', 'renderer');
    await click('[aria-label="Open settings"]');
    await click('#settings-tab-environment');
    await wait(
      'Boolean(document.querySelector(".capability-panel .provider-empty"))',
      'empty environment',
    );
    assert(
      await evaluate<boolean>(
        `parseFloat(getComputedStyle(document.querySelector('.capability-panel .provider-empty')).fontSize) <= 12`,
      ),
    );
    await click('.rail-link', 'Tools');
    const catalog = await request('/tools?workspaceId=default');
    await wait(
      `document.querySelectorAll('.tool-family-card').length === ${catalog.length}`,
      'built-in catalog',
    );
    await click('.sidebar-row', 'Custom tools');
    await wait('Boolean(document.querySelector(".custom-capabilities"))', 'custom sections');
    await click('.custom-capabilities > button', 'Register a saved module');
    await fill('.custom-capabilities .capability-form input', 'echo.ts');
    await checkSheet('register');
    await click('.custom-capabilities .capability-form button', 'Validate & register');
    await wait(
      'document.querySelector(".custom-capabilities").textContent.includes("echo_custom")',
      'TS registration',
    );
    assert.equal(api.capabilities.list('default')[0].status, 'needs_configuration');
    await click('[aria-label="Open settings"]');
    await click('#settings-tab-environment');
    await wait('Boolean(document.querySelector(".capability-panel"))', 'environment page');
    await click('.capability-panel button', 'Add variable');
    await fill('.modal input:not([type=password])', 'SMOKE_KEY');
    await fill('.modal input[type=password]', 'ui-private-value');
    await checkSheet('variable');
    await click('.modal .capability-form button', 'Save variable');
    await wait(
      'document.querySelector(".capability-panel").textContent.includes("Configured")',
      'variable save',
    );
    assert(!(await evaluate<boolean>('document.body.innerText.includes("ui-private-value")')));
    await click('.capability-panel button', 'Import .env');
    await fill('.capability-import textarea', 'SECOND_KEY=another-private-value');
    await checkSheet('import');
    await click('.capability-import button', 'Preview import');
    await click('.capability-import button', 'Save 1 variables');
    await wait('document.body.innerText.includes("SECOND_KEY")', 'env import');
    await click('.rail-link', 'Tools');
    await click('.sidebar-row', 'Custom tools');
    await wait(
      'document.querySelector(".custom-capabilities").textContent.includes("echo_custom")',
      'tools refresh',
    );
    await click('.capability-open');
    await wait('Boolean(document.querySelector(".capability-inspector"))', 'inspect');
    mkdirSync(join(process.cwd(), 'artifacts'), { recursive: true });
    await evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    writeFileSync(
      join(process.cwd(), 'artifacts', 'capabilities-detail.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    assert(!(await evaluate<boolean>('Boolean(document.querySelector(".custom-capabilities"))')));
    await click('.capability-tabs button', 'Test');
    await fill('.capability-inspector textarea', '{"value":"hello"}');
    await click('.capability-inspector button', 'Run test');
    await wait(
      'Boolean(document.querySelector(".capability-inspector pre[aria-label]"))',
      'handler test',
    );
    assert(
      (
        await evaluate<string>(
          'document.querySelector(".capability-inspector pre[aria-label]").textContent',
        )
      ).includes('hello'),
    );
    await click('.capability-actions button', 'Disable');
    await wait(
      'document.querySelector(".capability-inspector").textContent.includes("disabled")',
      'disable status',
    );
    assert(
      await evaluate<boolean>(
        '[...document.querySelectorAll(".capability-inspector button")].find(e=>e.textContent==="Run test").disabled',
      ),
    );
    await click('.capability-actions button', 'Enable');
    await wait(
      'document.querySelector(".capability-inspector").textContent.includes("ready")',
      'enable',
    );
    await click('.tool-detail-back', 'All tools');
    await click('.sidebar-row', 'Routes');
    await click('.custom-capabilities > button', 'Register a saved module');
    await click('.custom-capabilities [role=combobox]');
    await click('.custom-capabilities [role=option]', 'Route');
    await fill('.custom-capabilities .capability-form input', 'route.js');
    await click('.custom-capabilities .capability-form button', 'Validate & register');
    await wait('document.body.textContent.includes("smoke_route")', 'route registration');
    await evaluate(
      `([...document.querySelectorAll('.capability-open')].find(e=>e.textContent.includes('smoke_route'))).click()`,
    );
    await wait('Boolean(document.querySelector(".capability-url"))', 'route URL');
    assert.equal(
      await evaluate<string>('document.querySelector(".capability-url code").textContent'),
      api.url + '/custom/smoke',
    );
    const routed = await fetch(api.url + '/custom/smoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + api.token },
      body: '{"ok":true}',
    });
    assert.deepEqual(await routed.json(), { received: { ok: true } });
    await click('.tool-detail-back', 'All tools');
    await click('.sidebar-row', 'Custom tools');
    const screenshot = join(process.cwd(), 'artifacts', 'capabilities-tools.png');
    await wait(
      'document.querySelectorAll(".capability-open").length === 1',
      'registered tool card',
    );
    assert.equal(api.capabilities.list('default').length, 2);
    await evaluate(
      'document.querySelector(".custom-capabilities").scrollIntoView({block:"start"})',
    );
    await evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    mkdirSync(join(process.cwd(), 'artifacts'), { recursive: true });
    writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
    await click('[aria-label="Open settings"]');
    await click('#settings-tab-environment');
    await wait('document.body.innerText.includes("SMOKE_KEY")', 'stored variables');
    await evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    writeFileSync(
      join(process.cwd(), 'artifacts', 'capabilities-environment.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    assert.equal(errors.length, 0, errors.join('\n'));
    assert(
      !readFileSync(join(root, 'data', 'mukai.sqlite')).includes(Buffer.from('ui-private-value')),
    );
    const routeId = api.capabilities.list('default').find((item) => item.kind === 'route')!.id;
    writeFileSync(
      join(folder, 'call-route.js'),
      `export default {name:'test_route_call',description:'Test the authenticated route',inputSchema:{type:'object'},execute(args,context){return context.callRoute(${JSON.stringify(routeId)},{body:{ok:true}});}};`,
    );
    const caller = await request('/capabilities', 'POST', {
      kind: 'tool',
      operation: 'register',
      modulePath: 'call-route.js',
      permissionMode: 'auto_approve',
    });
    assert.deepEqual(await request('/capabilities/' + caller.id + '/test', 'POST', {}), {
      status: 200,
      body: { received: { ok: true } },
    });
    // Verify VM workspaces expose the same management pages, without booting a guest.
    api.store.run("UPDATE workspaces SET computer='qemu',folder=NULL WHERE id='default'");
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await wait(
      'Boolean(document.querySelector(".rail-settings:not([disabled])"))',
      'VM workspace loaded',
    );
    await click('.rail-link', 'Tools');
    await click('.sidebar-row', 'Custom tools');
    await wait(
      'document.querySelector(".custom-capabilities").textContent.includes("echo_custom")',
      'VM custom tools',
    );
    assert(
      await evaluate<boolean>(
        'document.querySelector(".custom-capabilities").textContent.includes("inside the Linux VM")',
      ),
    );
    await click('.sidebar-row', 'Routes');
    await wait(
      'document.querySelector(".custom-capabilities").textContent.includes("smoke_route")',
      'VM custom routes',
    );
    assert(!(await evaluate<boolean>('document.body.innerText.includes("unavailable in VM v1")')));
    console.log(
      'PASS Electron capability UI/runtime: built-in sections, TS/JS registration, encrypted variables, env import, testing, disable/enable, route URL, HTTP dispatch and VM management pages.',
    );
  } finally {
    window.destroy();
    for (const channel of [IPC.apiConnection, IPC.health, IPC.browserBounds])
      ipcMain.removeHandler(channel);
    await api.shutdown();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    api.dispose();
  }
}
void main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
