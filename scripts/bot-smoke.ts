import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { startApiServer } from '../src/server/app';
import { IPC } from '../src/shared/contracts';
import type { Bot } from '../src/shared/ai';

async function main() {
  const dir = process.env.MUKAI_BOT_SMOKE_DIR;
  if (!dir) throw new Error('Disposable bot smoke directory required.');
  app.setPath('userData', dir);
  await app.whenReady();
  const api = await startApiServer(0, {
    dataDir: join(dir, 'api'),
    memoryExtractor: async () => ({ facts: [] }),
  });
  const window = new BrowserWindow({
    show: false,
    width: 1480,
    height: 980,
    webPreferences: {
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(process.cwd(), 'out/preload/index.js'),
    },
  });
  let modelFixture: Server | undefined;
  ipcMain.handle(IPC.apiConnection, () => ({ url: api.url, token: api.token }));
  ipcMain.handle(IPC.health, () => ({ status: 'ok' }));
  ipcMain.handle(IPC.browserBounds, () => {});
  const evaluate = async <T>(code: string): Promise<T> => {
    try {
      return await window.webContents.executeJavaScript(code);
    } catch (error) {
      throw new Error('Renderer check failed: ' + code, { cause: error });
    }
  };
  const wait = async (code: string) => {
    for (let i = 0; i < 160; i++) {
      if (await evaluate<boolean>(code)) return;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error('Bot UI did not settle: ' + code);
  };
  const click = (label: string) =>
    evaluate(
      `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)}).click()`,
    );
  const fill = (selector: string, value: string) =>
    evaluate(
      `(()=>{const field=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  const capture = async (name: string) => {
    await evaluate(
      'Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})))',
    );
    await evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    mkdirSync(join(process.cwd(), 'artifacts'), { recursive: true });
    writeFileSync(
      join(process.cwd(), 'artifacts', name),
      (await window.webContents.capturePage()).toPNG(),
    );
  };
  const errors: string[] = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const request = async <T>(path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(api.url + path, {
      method,
      headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert(response.ok, await response.clone().text());
    return (await response.json()) as T;
  };
  try {
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await wait('Boolean(document.querySelector(".workspace-onboarding button"))');
    assert.equal(await evaluate('document.querySelectorAll(".rail-link:disabled").length'), 3);
    assert.equal(await evaluate('document.querySelector(".rail-settings").disabled'), true);
    assert.equal(
      await evaluate('document.querySelector(".sidebar-empty strong").textContent'),
      'No bots yet',
    );
    const onboardingFont = await evaluate<string>(
      'getComputedStyle(document.querySelector(".workspace-onboarding h2")).fontFamily',
    );
    assert.equal(await evaluate('document.querySelector(".onboarding-mark")'), null);
    await capture('bot-empty-workspace.png');
    await click('Add your first bot');
    await wait('Boolean(document.querySelector(".bot-name-suggestions"))');
    assert.deepEqual(
      await evaluate(
        'Array.from(document.querySelectorAll(".bot-name-suggestions button")).map(b=>b.textContent)',
      ),
      ['Mukai', 'Scout', 'Nova', 'Atlas'],
    );
    assert.equal(await evaluate('document.querySelector(".bot-editor input").value'), 'Mukai');
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('.bot-editor label')).find(e=>e.textContent.trim().startsWith('Role')).querySelector('input').value`,
      ),
      'Main Bot/Orchestrator',
    );
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('.bot-editor label')).some(e=>e.textContent.startsWith('Description'))`,
      ),
      false,
    );
    await capture('bot-first-editor.png');
    await evaluate('document.querySelector(".bot-editor form").requestSubmit()');
    await wait('Boolean(document.querySelector(".composer textarea"))');
    const main = (await request<Bot[]>('/bots'))[0];
    assert(main.isMain);
    assert.equal(await evaluate('document.querySelectorAll(".rail-link:disabled").length'), 0);
    await evaluate(
      `(()=>{const field=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Hello');field.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await wait(`!document.querySelector('button[aria-label="Send message"]').disabled`);
    await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
    await wait('Boolean(document.querySelector("#settings-tab-providers[aria-selected=true]"))');
    assert.equal((await request<unknown[]>(`/bots/${main.id}/messages`)).length, 0);
    await evaluate(
      `Array.from(document.querySelectorAll('.rail-link')).find(b=>b.textContent.trim()==='Bots').click()`,
    );
    await wait('Boolean(document.querySelector(".composer textarea"))');
    await evaluate(`document.querySelector('button[aria-label="Create a bot"]').click()`);
    await wait('Boolean(document.querySelector(".bot-editor"))');
    assert.equal(
      await evaluate('document.querySelector(".bot-editor form").checkValidity()'),
      false,
    );
    await fill('.bot-editor input', 'Scout');
    await fill('.bot-editor label:nth-of-type(2) input', 'Research assistant');
    await evaluate('document.querySelector(".bot-editor form").requestSubmit()');
    await wait('!document.querySelector(".bot-editor")');
    const child = (await request<Bot[]>('/bots')).find((bot) => bot.name === 'Scout')!;
    assert.equal(child.role, 'Research assistant');
    assert(
      !(await evaluate<boolean>(
        'document.querySelector(".bot-conversation-groups").textContent.includes("Created by")',
      )),
    );
    await evaluate(
      `Array.from(document.querySelectorAll('.rail-link')).find(b=>b.textContent.includes('Tools')).click()`,
    );
    await wait(
      'Array.from(document.querySelectorAll(".tool-family-name")).some(e=>e.textContent==="Pursuits")',
    );
    assert.equal(
      await evaluate('getComputedStyle(document.querySelector(".tools-page h1")).fontFamily'),
      onboardingFont,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('.tool-family-card')).find(b=>b.textContent.includes('Pursuits')).click()`,
    );
    await wait('document.querySelectorAll(".assignment-row").length===2');
    await wait(`!document.querySelector('input[aria-label="Assign Scout"]').disabled`);
    assert.equal(
      await evaluate(`document.querySelector('input[aria-label="Assign Mukai"]').checked`),
      true,
    );
    assert.equal(
      await evaluate(`document.querySelector('input[aria-label="Assign Scout"]').checked`),
      false,
    );
    await capture('bot-tool-assignments.png');
    await evaluate(`document.querySelector('input[aria-label="Assign Scout"]').click()`);
    await wait(
      `document.querySelector('input[aria-label="Assign Scout"]').checked && !document.querySelector('input[aria-label="Assign Scout"]').disabled`,
    );
    assert(api.access.allowed(child, 'manage_pursuit'));
    mkdirSync(join(dir, 'workspace'));
    await request('/workspaces/default', 'PUT', {
      name: 'Test workspace',
      folder: join(dir, 'workspace'),
    });
    writeFileSync(
      join(dir, 'workspace', 'echo.ts'),
      `export default {name:'echo',description:'Echo a value',inputSchema:{type:'object',properties:{}},execute:()=>({ok:true})};`,
    );
    const custom = await request<{ id: string }>('/capabilities', 'POST', {
      kind: 'tool',
      operation: 'register',
      modulePath: 'echo.ts',
    });
    await click('Custom tools');
    await wait(
      'Array.from(document.querySelectorAll(".capability-open")).some(b=>b.textContent.includes("echo"))',
    );
    await evaluate(
      `Array.from(document.querySelectorAll('.capability-open')).find(b=>b.textContent.includes('echo')).click()`,
    );
    await wait('document.querySelectorAll(".assignment-row").length===2');
    assert.equal(
      await evaluate(`document.querySelector('input[aria-label="Assign Scout"]').checked`),
      false,
    );
    await evaluate(`document.querySelector('input[aria-label="Assign Scout"]').click()`);
    await wait(
      `document.querySelector('input[aria-label="Assign Scout"]').checked && !document.querySelector('input[aria-label="Assign Scout"]').disabled`,
    );
    assert(api.access.allowed(child, 'custom:' + custom.id));
    await capture('bot-custom-assignments.png');
    window.setSize(900, 800);
    await capture('bot-assignments-narrow.png');
    window.setSize(1480, 980);
    const sentModels: string[] = [];
    modelFixture = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      sentModels.push((JSON.parse(body) as { model: string }).model);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [delta, finish_reason] of [
        [{ role: 'assistant', content: 'Fixture model switched.' }, null],
        [{}, 'stop'],
      ])
        res.write(
          `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: sentModels.at(-1), choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => modelFixture!.listen(0, '127.0.0.1', resolve));
    await request('/providers', 'POST', {
      name: 'Model fixture',
      kind: 'compatible',
      baseUrl: `http://127.0.0.1:${(modelFixture.address() as { port: number }).port}/v1`,
      defaultModel: 'fixture-default',
      isDefault: true,
      supportsImages: false,
      contextWindowTokens: 32768,
      apiKey: '',
    });
    window.reload();
    await wait('Boolean(document.querySelector(".composer textarea"))');
    await evaluate(
      `Array.from(document.querySelectorAll('.bot-conversation-row')).find(b=>b.closest('.bot-conversation-group').textContent.includes('Mukai')).click()`,
    );
    await wait('document.querySelector(".conversation-header h1")?.textContent==="Mukai"');
    await evaluate('document.querySelector(".ai-model-picker").click()');
    await wait('Boolean(document.querySelector(".bot-model-sheet"))');
    await evaluate(`document.querySelector('button[aria-label="Bot model"]').click()`);
    await evaluate(
      `Array.from(document.querySelectorAll('[role=option]')).find(e=>e.textContent==='Use another model…').click()`,
    );
    await wait('Boolean(document.querySelector(".bot-model-sheet form"))');
    await fill('.bot-model-sheet form input', 'fixture-alternate');
    await fill('.bot-model-sheet input[type=number]', '65536');
    await capture('bot-model-picker.png');
    await click('Use model');
    await wait('!document.querySelector(".bot-model-sheet")');
    assert.equal(
      (await request<Bot[]>('/bots')).find((bot) => bot.id === main.id)?.model,
      'fixture-alternate',
    );
    assert.equal(
      await evaluate('document.querySelector(".ai-model-picker span").textContent'),
      'fixture-alternate',
    );
    await fill('.composer textarea', 'Check the selected model.');
    await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
    await wait(
      'document.querySelector(".ai-message-feed").textContent.includes("Fixture model switched.")',
    );
    assert.deepEqual(sentModels, ['fixture-alternate']);
    await wait('!document.querySelector(".ai-model-picker").disabled');
    await evaluate('document.querySelector(".ai-model-picker").click()');
    await wait('Boolean(document.querySelector(".bot-model-sheet"))');
    await evaluate(`document.querySelector('button[aria-label="Bot model"]').click()`);
    await evaluate(
      `Array.from(document.querySelectorAll('[role=option]')).find(e=>e.textContent.startsWith('Provider default ·')).click()`,
    );
    await wait('!document.querySelector(".bot-model-sheet")');
    assert.equal((await request<Bot[]>('/bots')).find((bot) => bot.id === main.id)?.model, null);
    await fill('.composer textarea', 'Use the provider default again.');
    await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
    await wait(
      'document.querySelectorAll(".ai-message--assistant").length===2 && !document.querySelector(".ai-model-picker").disabled',
    );
    assert.deepEqual(sentModels, ['fixture-alternate', 'fixture-default']);
    assert.equal((await request<Bot[]>('/bots')).find((bot) => bot.id === child.id)?.model, null);
    await capture('bot-name-only-sidebar.png');
    assert.deepEqual(errors, []);
    console.log(
      'PASS bot UI: onboarding, required roles, name-only sidebar, assignments, model picker saves and uses selected/default models on actual SDK requests.',
    );
  } finally {
    window.destroy();
    await api.shutdown();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    if (modelFixture) {
      modelFixture.closeAllConnections();
      await new Promise<void>((resolve) => modelFixture!.close(() => resolve()));
    }
  }
}
void main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
