import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { startApiServer } from '../src/server/app';
import { IPC } from '../src/shared/contracts';
import type { Bot, Workspace } from '../src/shared/ai';
import { seedTestWorkspace } from '../src/server/testFixtures';
import { themeStorageKey } from '../src/renderer/src/features/appearance/themes';
import type { ApprovalState } from '../src/shared/approvals';
import { randomUUID } from 'node:crypto';
import { ConversationRepository } from '../src/server/repositories/conversationRepository';
import type { NotificationInbox } from '../src/shared/notifications';
import { PursuitRepository } from '../src/server/repositories/pursuitRepository';
import { WorkspaceRepository } from '../src/server/repositories/workspaceRepository';

async function main() {
  const dir = process.env.MUKAI_BOT_SMOKE_DIR;
  if (!dir) throw new Error('Disposable bot smoke directory required.');
  app.setPath('userData', dir);
  app.on('window-all-closed', () => {});
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
    console.error('Bot UI did not settle: ' + code);
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
      'Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))',
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
    await wait('Boolean(document.querySelector(".workspace-first-run button"))');
    assert.deepEqual(await request('/workspaces'), []);
    assert.equal(await evaluate('document.querySelectorAll(".rail-link:disabled").length'), 6);
    assert.equal(
      await evaluate(
        'Array.from(document.querySelectorAll(".navigation-rail button")).every(button=>button.disabled)',
      ),
      true,
    );
    assert.equal(await evaluate('document.querySelector(".workspace-search").disabled'), true);
    assert.equal(await evaluate('document.querySelector(".rail-link.is-active")'), null);
    await capture('first-workspace-light.png');
    await click('Create workspace');
    await wait('Boolean(document.querySelector(".workspace-editor"))');
    await click('Cancel');
    assert.deepEqual(await request('/workspaces'), []);
    await click('Create workspace');
    await wait('Boolean(document.querySelector(".workspace-editor"))');
    await fill('.workspace-editor input[maxlength="60"]', 'My first workspace');
    const folder = join(dir, 'project');
    mkdirSync(folder);
    await fill('.workspace-editor input[maxlength="2000"]', folder);
    await evaluate('document.querySelector(".workspace-editor button[type=submit]").click()');
    await wait('Boolean(document.querySelector(".sidebar-empty strong"))');
    const created = (await request<Workspace[]>('/workspaces'))[0];
    assert.equal(created.name, 'My first workspace');
    assert.notEqual(created.id, 'default');
    assert.equal(await evaluate('localStorage.getItem("mukai.active-workspace")'), created.id);
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await wait('Boolean(document.querySelector(".sidebar-empty strong"))');
    assert.equal(await evaluate('document.querySelector(".rail-link").disabled'), false);
    await request('/workspaces/' + created.id, 'DELETE', { name: created.name });
    // A stale selection after deletion must return to the same empty state.
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await wait('Boolean(document.querySelector(".workspace-first-run button"))');
    await request('/settings/appearance', 'PUT', { mode: 'dark', theme: 'mukai' });
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await wait('Boolean(document.querySelector(".workspace-first-run button"))');
    await capture('first-workspace-dark.png');
    window.setSize(680, 760);
    await capture('first-workspace-narrow.png');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    assert.deepEqual(errors, []);
    if (process.argv.includes('--workspace-only')) {
      console.log(
        'PASS first workspace UI: disabled navigation, cancellation, creation, selection, reload, stale selection, dark and narrow layouts.',
      );
      return;
    }
    // The remaining bot-specific scenarios explicitly provide their workspace.
    seedTestWorkspace(api.store);
    window.setSize(1480, 980);
    await request('/settings/appearance', 'PUT', { mode: 'light', theme: 'mukai' });
    await evaluate(`localStorage.removeItem(${JSON.stringify(themeStorageKey)})`);
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await wait('Boolean(document.querySelector(".workspace-onboarding button"))');
    assert.equal(await evaluate('document.querySelectorAll(".rail-link:disabled").length'), 3);
    if (!process.argv.includes('--mascots-only'))
      assert.equal(await evaluate('document.querySelector(".rail-settings").disabled'), false);
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
    if (process.argv.includes('--mascots-only')) {
      await wait(
        'Array.from(document.querySelectorAll(".bot-avatar-options img")).every(img=>img.complete && img.naturalWidth>0)',
      );
      assert.equal(
        await evaluate('document.querySelectorAll(".bot-avatar-options button").length'),
        16,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".bot-avatar-options .is-selected img").getAttribute("src")',
        ),
        './mascots/mukai-logo.webp',
      );
      await evaluate(
        `document.querySelector('button[aria-label="Use Blue star wizard mascot"]').click()`,
      );
      window.setSize(420, 900);
      await capture('bot-mascots-narrow.png');
      assert.equal(
        await evaluate(
          'document.querySelector(".bot-avatar-options").scrollWidth <= document.querySelector(".bot-avatar-options").clientWidth',
        ),
        true,
      );
      window.setSize(1480, 980);
      await capture('bot-mascots-picker.png');
      await evaluate('document.querySelector(".bot-editor form").requestSubmit()');
      await wait('Boolean(document.querySelector(".composer textarea"))');
      const saved = (await request<Bot[]>('/bots'))[0];
      assert.equal(saved.avatar, 'muka-mascot-5-blue');
      await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
      await wait('Boolean(document.querySelector(".composer textarea"))');
      await wait(
        'Boolean(document.querySelector(".bot-conversation-parent img[src*=muka-mascot-5-blue]"))',
      );
      api.store.run('UPDATE bots SET avatar=? WHERE id=?', 'nova', saved.id);
      await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
      await wait('Boolean(document.querySelector(".composer textarea"))');
      await wait(
        'Boolean(document.querySelector(".bot-conversation-parent img[src*=mukai-logo]"))',
      );
      assert.deepEqual(errors, []);
      console.log(
        'PASS mascots: all assets load, narrow picker fits, selection persists after reload, legacy uses Mukai.',
      );
      return;
    }
    assert.deepEqual(
      await evaluate(
        'Array.from(document.querySelectorAll(".bot-name-suggestions button")).map(b=>b.textContent)',
      ),
      ['Mukai', 'Scout', 'Nova', 'Atlas'],
    );
    assert.equal(await evaluate('document.querySelector(".bot-editor input").value'), 'Mukai');
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".bot-editor select, .bot-editor input[type=number]").length',
      ),
      0,
    );
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
    if (process.argv.includes('--vm-resources-only')) {
      // Only this disposable fixture uses a VM workspace without launching QEMU.
      api.store.run("UPDATE workspaces SET computer='qemu' WHERE id='default'");
      await new Promise<void>((resolve) => {
        window.webContents.once('did-finish-load', () => resolve());
        window.reload();
      });
      await wait('Boolean(document.querySelector(".composer textarea"))');
      await evaluate('document.querySelector(".rail-settings").click()');
      await wait('Boolean(document.querySelector("#settings-tab-workspace"))');
      await click('Workspace');
      await wait(
        'Boolean(document.querySelector("#vm-memory")) && !document.querySelector("#vm-memory").disabled',
      );
      assert.equal(await evaluate('document.querySelector("#vm-memory").value'), '4');
      assert.equal(await evaluate('document.querySelector("#vm-cpus").value'), '2');
      await capture('vm-resource-settings.png');
      await fill('#vm-memory', '8');
      await fill('#vm-cpus', '4');
      await click('Save resources');
      await wait('Boolean(document.querySelector(".vm-settings-card .ai-notice"))');
      assert.deepEqual(new WorkspaceRepository(api.store).find('default')!.computerResources, {
        memoryMiB: 8192,
        vcpus: 4,
      });
      await new Promise<void>((resolve) => {
        window.webContents.once('did-finish-load', () => resolve());
        window.reload();
      });
      await wait('Boolean(document.querySelector(".composer textarea"))');
      await evaluate('document.querySelector(".rail-settings").click()');
      await wait('Boolean(document.querySelector("#settings-tab-workspace"))');
      await click('Workspace');
      await wait(
        'Boolean(document.querySelector("#vm-memory")) && !document.querySelector("#vm-memory").disabled',
      );
      assert.equal(await evaluate('document.querySelector("#vm-memory").value'), '8');
      assert.equal(await evaluate('document.querySelector("#vm-cpus").value'), '4');
      await fill('#vm-cpus', '1.5');
      assert.equal(
        await evaluate('document.querySelector(".vm-resource-actions button").disabled'),
        true,
      );
      await click('Use defaults');
      await click('Save resources');
      await wait('Boolean(document.querySelector(".vm-settings-card .ai-notice"))');
      assert.deepEqual(new WorkspaceRepository(api.store).find('default')!.computerResources, {
        memoryMiB: 4096,
        vcpus: 2,
      });
      await evaluate("document.documentElement.dataset.mode='dark'");
      await capture('vm-resource-settings-dark.png');
      window.setSize(820, 900);
      await capture('vm-resource-settings-narrow.png');
      assert.equal(
        await evaluate(
          'document.querySelector(".vm-settings-card").scrollWidth <= document.querySelector(".vm-settings-card").clientWidth',
        ),
        true,
      );
      assert.deepEqual(errors, []);
      console.log(
        'PASS VM resource settings: defaults, save, reload, validation, reset, dark and narrow layouts.',
      );
      return;
    }
    if (process.argv.includes('--bot-roles-only')) {
      const mainBot = (await request<Bot[]>('/bots'))[0];
      assert.equal(
        await evaluate(
          `(() => {
            const expected = document.createElement('span');
            expected.style.color = 'var(--theme-text)';
            document.body.append(expected);
            const matches = getComputedStyle(document.querySelector('.bot-conversation-action .main-bot-badge')).color === getComputedStyle(expected).color;
            expected.remove();
            return matches;
          })()`,
        ),
        true,
      );
      assert.equal(
        await evaluate(
          'document.querySelectorAll(".bot-conversation-action .main-bot-badge").length',
        ),
        1,
      );
      assert.equal(
        await evaluate(
          'document.querySelectorAll(".conversation-heading h1 .main-bot-badge").length',
        ),
        1,
      );
      await evaluate(`document.querySelector('button[aria-label="Create a bot"]').click()`);
      await wait('Boolean(document.querySelector(".bot-editor"))');
      await fill('.bot-editor input', 'Ada');
      await fill('.bot-editor label:nth-of-type(2) input', 'Research specialist');
      await evaluate('document.querySelector(".bot-editor form").requestSubmit()');
      await wait('!document.querySelector(".bot-editor")');
      const bots = await request<Bot[]>('/bots');
      const child = bots.find((bot) => bot.name === 'Ada')!;
      assert.equal(child.isMain, false);
      assert.equal(bots.filter((bot) => bot.isMain).length, 1);
      await evaluate(
        `document.querySelector('button[aria-label="New conversation with Ada"]').click()`,
      );
      await wait('document.querySelector(".conversation-heading h1")?.textContent==="Ada"');
      assert.equal(
        await evaluate(
          'document.querySelectorAll(".conversation-heading h1 .main-bot-badge").length',
        ),
        0,
      );
      modelFixture = createServer(async (req, res) => {
        if (req.method === 'GET') {
          res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
          return;
        }
        for await (const chunk of req) void chunk;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          'data: ' +
            JSON.stringify({
              id: 'test',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fixture',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'Task completed.' },
                  finish_reason: 'stop',
                },
              ],
            }) +
            '\n\ndata: [DONE]\n\n',
        );
      });
      await new Promise<void>((resolve) => modelFixture!.listen(0, '127.0.0.1', resolve));
      await request('/providers', 'POST', {
        name: 'Fixture',
        kind: 'compatible',
        baseUrl: `http://127.0.0.1:${(modelFixture.address() as { port: number }).port}/v1`,
        defaultModel: 'fixture',
        supportsImages: false,
        isDefault: true,
        apiKey: '',
      });
      const send = async (bot: Bot) => {
        const response = await fetch(api.url + `/bots/${bot.id}/chat`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: randomUUID(), text: 'Do the work', attachmentIds: [] }),
        });
        assert(response.ok);
        await response.text();
      };
      await send(mainBot);
      await send(child);
      window.reload();
      await wait('document.querySelector(".bot-conversation-parent")?.textContent.trim()==="Ada"');
      await capture('bot-roles-sidebar.png');
      await send(mainBot);
      await wait(
        'document.querySelector(".bot-conversation-parent")?.textContent.trim()==="Mukai"',
      );
      await click('Bot Hierarchy');
      await wait('document.querySelectorAll(".bot-tree-card").length===2');
      assert.equal(
        await evaluate('document.querySelectorAll(".bot-tree-card .main-bot-badge").length'),
        1,
      );
      await capture('bot-roles-hierarchy.png');
      await evaluate(
        `Array.from(document.querySelectorAll('.rail-link')).find(b=>b.textContent.includes('Tools')).click()`,
      );
      await wait('Boolean(document.querySelector(".tool-family-card"))');
      await evaluate(
        `Array.from(document.querySelectorAll('.tool-family-card')).find(b=>b.querySelector('.tool-family-name')?.textContent==='Bots').click()`,
      );
      await wait('document.querySelectorAll(".assignment-row").length===2');
      assert.equal(
        await evaluate(
          'Array.from(document.querySelectorAll(".assignment-row input")).every(e=>e.checked && e.disabled && e.classList.contains("themed-checkbox"))',
        ),
        true,
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".tool-assignments").textContent.includes("delegated sub-bot runs can only list and inspect")',
        ),
        true,
      );
      await capture('bot-roles-assignments.png');
      window.setSize(720, 900);
      await capture('bot-roles-assignments-narrow.png');
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
      assert.deepEqual(errors, []);
      console.log(
        'PASS bot roles UI: unique main bot, stars, recent interaction order, required themed assignments, narrow layout.',
      );
      return;
    }
    if (process.argv.includes('--approvals-only')) {
      let explicit = false;
      let parallel = false;
      let receivedDenialReason = false;
      modelFixture = createServer(async (req, res) => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
          return;
        }
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const input = JSON.parse(raw) as { messages: { role: string }[] };
        const lastUser = input.messages.map((message) => message.role).lastIndexOf('user');
        const completed = input.messages
          .slice(lastUser + 1)
          .some((message) => message.role === 'tool');
        if (completed && JSON.stringify(input.messages).includes('Review the draft first.'))
          receivedDenialReason = true;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const delta = completed
          ? { role: 'assistant', content: 'Approval check complete.' }
          : {
              role: 'assistant',
              tool_calls: Array.from({ length: parallel ? 3 : 1 }, (_, index) => ({
                index,
                id: randomUUID(),
                type: 'function',
                function: {
                  name: explicit ? 'communicate' : 'manage_pursuit',
                  arguments: JSON.stringify(
                    explicit
                      ? { action: 'approval', question: 'May I publish this draft?' }
                      : { action: 'list' },
                  ),
                },
              })),
            };
        res.write(
          `data: ${JSON.stringify({ id: 'approval-check', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: completed ? 'stop' : 'tool_calls' }] })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      });
      await new Promise<void>((resolve) => modelFixture!.listen(0, '127.0.0.1', resolve));
      const address = modelFixture.address();
      if (!address || typeof address === 'string') throw new Error('Fixture failed');
      await request('/providers', 'POST', {
        name: 'Fixture',
        kind: 'compatible',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        defaultModel: 'fixture',
        supportsImages: false,
        isDefault: true,
        apiKey: 'test-only',
      });
      new WorkspaceRepository(api.store).create({
        id: 'isolation',
        name: 'Other workspace',
        folder: null,
        createdAt: new Date().toISOString(),
        computer: 'local',
      });
      await request('/approvals?workspaceId=isolation', 'PUT', { mode: 'ask-for-approval' });
      await request('/bots', 'POST', {
        workspaceId: 'isolation',
        name: 'Other bot',
        role: 'Main Bot/Orchestrator',
        instructions: 'Review pursuits.',
        providerId: null,
        model: null,
        supportsImages: null,
        avatar: 'scout',
      });
      await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
      window.reload();
      await wait(
        'Boolean(document.querySelector(".composer textarea")) && document.querySelector(".approval-mode-trigger")?.textContent.includes("Ask for approval")',
      );
      const send = async (text: string) => {
        await fill('.composer textarea', text);
        await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
      };
      await send('Review pursuits.');
      await wait('Boolean(document.querySelector(".tool-approval-full-access input"))');
      await evaluate(
        `(()=>{const button=document.querySelector('button[aria-label="About Full Access Mode"]');button.focus();button.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));})()`,
      );
      await wait('Boolean(document.querySelector("[role=tooltip]"))');
      await capture('tool-approval-tooltip.png');
      await evaluate(
        'document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))',
      );
      await wait('!document.querySelector("[role=tooltip]")');
      await evaluate('document.querySelector(".tool-approval-full-access input").click()');
      await wait(
        'document.querySelector(".tool-approval-full-access input").checked && !document.querySelector(".tool-approval-full-access input").disabled',
      );
      assert.equal((await request<ApprovalState>('/approvals')).mode, 'full-access');
      assert.equal(
        (await request<ApprovalState>('/approvals?workspaceId=isolation')).mode,
        'ask-for-approval',
      );
      assert.equal((await request<ApprovalState>('/approvals')).pending.length, 1);
      await capture('tool-approval-full-access.png');
      await click('Approve tool call');
      await wait(
        `!document.querySelector('.tool-approval-card') && !document.querySelector('button[aria-label="Stop generation"]')`,
      );
      await evaluate(`document.querySelector('button[aria-label="Choose workspace"]').click()`);
      await wait('Boolean(document.querySelector(".workspace-picker-menu"))');
      await evaluate(
        `Array.from(document.querySelectorAll('.workspace-choice')).find(button=>button.textContent.includes('Other workspace')).click()`,
      );
      await wait(
        'document.querySelector(".approval-mode-trigger")?.textContent.includes("Ask for approval") && !document.querySelector(".approval-mode-trigger").disabled',
      );
      await evaluate(`document.querySelector('button[aria-label="Choose workspace"]').click()`);
      await wait('Boolean(document.querySelector(".workspace-picker-menu"))');
      await evaluate(
        `Array.from(document.querySelectorAll('.workspace-choice')).find(button=>!button.textContent.includes('Other workspace')).click()`,
      );
      await wait(
        'document.querySelector(".approval-mode-trigger")?.textContent.includes("Full access") && !document.querySelector(".approval-mode-trigger").disabled',
      );
      explicit = true;
      await send('Ask for explicit confirmation.');
      await wait('Boolean(document.querySelector(".ask-request-card"))');
      assert.equal(
        await evaluate('document.querySelector(".ask-request-card .themed-checkbox")'),
        null,
      );
      assert.equal((await request<ApprovalState>('/approvals')).mode, 'full-access');
      await capture('explicit-approval-full-access.png');
      await click('Deny');
      await wait(
        `!document.querySelector('.ask-request-card') && !document.querySelector('button[aria-label="Stop generation"]')`,
      );
      await send('Ask for confirmation with a reason.');
      await wait('Boolean(document.querySelector(".ask-request-card"))');
      await click('Deny with reason');
      await wait('Boolean(document.querySelector(\'textarea[aria-label="Reason for denying"]\'))');
      assert.equal(
        await evaluate('document.activeElement.getAttribute("aria-label")'),
        'Reason for denying',
      );
      assert.equal(
        await evaluate(
          'document.querySelector(".ask-request-actions button[type=submit]").disabled',
        ),
        true,
      );
      await click('Cancel');
      assert.equal((await request<ApprovalState>('/approvals')).pending.length, 1);
      assert.equal(await evaluate('document.querySelector(".ask-request-card textarea")'), null);
      await click('Deny with reason');
      await fill('textarea[aria-label="Reason for denying"]', 'Review the draft first.');
      window.setSize(900, 900);
      await capture('ask-deny-reason-narrow.png');
      await evaluate("document.documentElement.dataset.mode='dark'");
      await capture('ask-deny-reason-dark.png');
      await evaluate('document.querySelector(".ask-request-actions button[type=submit]").click()');
      await wait(
        `!document.querySelector('.ask-request-card') && !document.querySelector('button[aria-label="Stop generation"]')`,
      );
      assert.equal(receivedDenialReason, true);
      explicit = false;
      parallel = true;
      await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
      await send('Review three parallel tool calls.');
      await wait('document.querySelectorAll(".tool-approval-card").length===3');
      assert.equal(
        await evaluate(
          'document.querySelectorAll(".tool-approval-full-access .themed-checkbox").length',
        ),
        3,
      );
      await evaluate('document.querySelector(".tool-approval-batch details").open=true');
      window.setSize(900, 900);
      await capture('tool-approval-cards-narrow.png');
      await evaluate("document.documentElement.dataset.mode='dark'");
      await capture('tool-approval-cards-dark.png');
      await click('Approve all');
      await wait(
        `!document.querySelector('.tool-approval-card') && !document.querySelector('button[aria-label="Stop generation"]')`,
      );
      assert.deepEqual(errors, []);
      console.log(
        'PASS approval UI: Full Access checkbox, workspace isolation, pending-call preservation, explicit confirmations, parallel cards, tooltip keyboard handling, dark and narrow layouts.',
      );
      return;
    }
    if (process.argv.includes('--limits-only')) {
      await evaluate('document.querySelector(".rail-settings").click()');
      await wait('Boolean(document.querySelector("#settings-tab-limits"))');
      await click('Limits');
      await wait(
        'document.querySelector("#pursuit-concurrency")?.value==="5" && !document.querySelector("#pursuit-concurrency").disabled',
      );
      assert.equal(await evaluate('document.querySelectorAll(".limits-panel select").length'), 0);
      assert(
        await evaluate(
          'Math.abs(document.querySelector(".limits-card").getBoundingClientRect().left-document.querySelector(".settings-panel-heading").getBoundingClientRect().left)<2',
        ),
      );
      await capture('settings-limits.png');
      await fill('#pursuit-concurrency', '0');
      assert.equal(
        await evaluate('document.querySelector(".limits-form button[type=submit]").disabled'),
        true,
      );
      await fill('#pursuit-concurrency', '7');
      await click('Save limit');
      await wait('Boolean(document.querySelector(".limits-form [role=status]"))');
      assert.equal(
        (await request<{ pursuitConcurrency: number }>('/limits')).pursuitConcurrency,
        7,
      );
      window.reload();
      await wait('Boolean(document.querySelector(".composer textarea"))');
      await evaluate('document.querySelector(".rail-settings").click()');
      await wait('Boolean(document.querySelector("#settings-tab-limits"))');
      await click('Limits');
      await wait(
        'document.querySelector("#pursuit-concurrency")?.value==="7" && !document.querySelector("#pursuit-concurrency").disabled',
      );
      await evaluate(
        `(()=>{const button=document.querySelector('button[aria-label="About the pursuit limit"]');button.focus();button.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));})()`,
      );
      await wait('Boolean(document.querySelector("[role=tooltip]"))');
      assert(
        await evaluate(
          '(()=>{const r=document.querySelector("[role=tooltip]").getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()',
        ),
      );
      await capture('settings-limits-tooltip.png');
      await evaluate(
        'document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))',
      );
      await wait('!document.querySelector("[role=tooltip]")');
      await evaluate("document.documentElement.dataset.mode='dark'");
      await capture('settings-limits-dark.png');
      window.setSize(700, 800);
      await capture('settings-limits-narrow.png');
      assert(
        await evaluate(
          'document.querySelector(".settings-panel").scrollWidth<=document.querySelector(".settings-panel").clientWidth+1',
        ),
      );
      assert.equal(errors.length, 0, errors.join('\n'));
      console.log(
        'PASS Limits UI: default, validation, persistence, left alignment, tooltip keyboard behavior, dark and narrow layouts.',
      );
      return;
    }
    if (process.argv.includes('--workpad-only')) {
      const main = (await request<Bot[]>('/bots'))[0];
      const pursuit = api.pursuits.create(main, {
        name: 'Prepare the supplier shortlist',
        objective: 'Compare suppliers and prepare a shortlist with evidence.',
        successCriteria: 'Three verified candidates within the agreed budget.',
        firstRunAt: new Date(Date.now() + 3600000).toISOString(),
        deadline: null,
      });
      await click('Pursuits');
      await wait(
        'document.querySelector(".pursuit-title h1")?.textContent==="Prepare the supplier shortlist"',
      );
      await click('Workpad');
      await wait('Boolean(document.querySelector(".pursuit-workpad .pursuit-empty-runs"))');
      assert.equal(
        await evaluate('document.querySelectorAll(".pursuit-workpad select").length'),
        0,
      );
      assert.equal(
        await evaluate('document.querySelectorAll(".pursuit-workpad .themed-checkbox").length'),
        1,
      );
      assert.equal(
        await evaluate('document.querySelectorAll(".pursuit-workpad .dropdown-trigger").length'),
        2,
      );
      assert(
        await evaluate(
          'Math.abs(document.querySelector(".pursuit-workpad").getBoundingClientRect().left-document.querySelector(".pursuit-content").getBoundingClientRect().left-parseFloat(getComputedStyle(document.querySelector(".pursuit-content")).paddingLeft))<2',
        ),
      );
      await capture('pursuit-workpad-empty.png');
      const repository = new PursuitRepository(api.store);
      const run = repository.claim(pursuit.id, 'manual', Date.now())!;
      const decision = api.pursuits.addEntryOwned(
        main,
        pursuit.id,
        {
          type: 'decision',
          title: 'Prioritize local delivery',
          content:
            'Prefer suppliers with delivery within five business days. This keeps the launch on schedule.',
          links: [{ kind: 'conversation', target: 'bot-' + main.id, label: 'Original request' }],
        },
        run.conversationId,
      );
      const active = api.pursuits.addEntryOwned(
        main,
        pursuit.id,
        {
          type: 'work_item',
          title: 'Compare the remaining two suppliers',
          status: 'in_progress',
          content:
            'Verify shipping terms and compare the final quotes against the **$2,000 budget**.',
          links: [
            {
              kind: 'file',
              target: 'research/supplier-comparison.csv',
              label: 'Supplier comparison',
            },
            { kind: 'entry', target: decision.id, label: 'Delivery decision' },
          ],
        },
        run.conversationId,
      );
      api.pursuits.addEntryOwned(
        main,
        pursuit.id,
        {
          type: 'blocker',
          title: 'Need the delivery address',
          content:
            'The suppliers need a destination postal code to confirm shipping costs. Ask the user before finalizing the total.',
        },
        run.conversationId,
      );
      api.pursuits.addEntryOwned(
        main,
        pursuit.id,
        {
          type: 'work_item',
          title: 'Verify the first supplier',
          content: 'Confirmed stock, minimum order quantity, and a three-day dispatch window.',
          status: 'done',
          links: [
            { kind: 'url', target: 'https://example.com/supplier', label: 'Supplier source' },
          ],
        },
        run.conversationId,
      );
      api.pursuits.addEntryOwned(
        main,
        pursuit.id,
        {
          type: 'reference',
          title: 'Shortlist research',
          content: 'Use this comparison when drafting the recommendation.',
          links: [{ kind: 'file', target: 'research/shortlist.md', label: 'Shortlist notes' }],
        },
        run.conversationId,
      );
      api.pursuits.addEntryOwned(
        main,
        pursuit.id,
        {
          type: 'note',
          title: 'Pricing excludes tax',
          content: 'All three quotes exclude tax. Compare suppliers using the same basis.',
        },
        run.conversationId,
      );
      api.pursuits.addEntryOwned(
        main,
        pursuit.id,
        {
          type: 'note',
          title: 'Old shipping estimate',
          content: 'Superseded by the current quotes.',
          status: 'archived',
        },
        run.conversationId,
      );
      repository.finish(
        run.id,
        'complete',
        'Compared suppliers and recorded current work.',
        null,
        'waiting_for_you',
        Date.now(),
      );
      await wait('document.querySelectorAll(".workpad-entry").length===6');
      await evaluate('document.querySelectorAll(".workpad-entry summary")[1].click()');
      await capture('pursuit-workpad.png');
      await evaluate(`document.querySelector('button[aria-label="Workpad entry type"]').click()`);
      await wait(
        `document.querySelector('button[aria-label="Workpad entry type"]').getAttribute('aria-expanded')==='true'`,
      );
      await evaluate(
        'Array.from(document.querySelectorAll(".dropdown-option")).find(e=>e.textContent.trim()==="Blocker").click()',
      );
      await wait('document.querySelectorAll(".workpad-entry").length===1');
      assert.equal(
        await evaluate(
          'Array.from(document.querySelectorAll(".workpad-filter:nth-child(2) .dropdown-option")).some(e=>e.textContent.trim()==="To do")',
        ),
        false,
      );
      await click('Clear filters');
      await wait('document.querySelectorAll(".workpad-entry").length===6');
      await evaluate('document.querySelector(".workpad-archive-toggle input").click()');
      await wait('document.querySelectorAll(".workpad-entry").length===7');
      await evaluate('document.querySelector(".workpad-archive-toggle input").click()');
      await wait('document.querySelectorAll(".workpad-entry").length===6');
      await evaluate('document.querySelectorAll(".workpad-entry summary")[1].click()');
      await click('Delivery decision');
      await wait('Boolean(document.querySelector("dialog[open]"))');
      assert.equal(
        await evaluate('document.querySelector("dialog[open] h2").textContent'),
        'Prioritize local delivery',
      );
      await click('Original request');
      await wait('document.querySelector("dialog[open] h2")?.textContent==="Original request"');
      assert.equal(await evaluate('document.querySelectorAll("dialog[open]").length'), 1);
      await evaluate(
        `document.querySelector('dialog[open] button[aria-label="Close dialog"]').click()`,
      );
      api.pursuits.updateEntryOwned(
        main,
        pursuit.id,
        active.id,
        {
          status: 'done',
          content: 'Verified shipping and final quotes. Both are within the agreed budget.',
        },
        active.revision,
      );
      await wait(
        'document.querySelector(".pursuit-workpad").textContent.includes("Verified shipping and final quotes")',
      );
      await evaluate('document.documentElement.dataset.mode="dark"');
      assert(
        await evaluate(`(()=>{
        const luminance=color=>{
          const channels=color.match(/[\\d.]+/g).slice(0,3).map(Number).map(value=>value/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4);
          return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
        };
        const foreground=luminance(getComputedStyle(document.querySelector('.workpad-links button')).color);
        const background=luminance(getComputedStyle(document.querySelector('.workpad-entry')).backgroundColor);
        return (Math.max(foreground,background)+0.05)/(Math.min(foreground,background)+0.05)>=4.5;
      })()`),
      );
      await capture('pursuit-workpad-dark.png');
      await evaluate('document.documentElement.dataset.mode="light"');
      window.setSize(900, 800);
      await capture('pursuit-workpad-narrow.png');
      assert(
        await evaluate(
          'document.querySelector(".pursuit-content").scrollWidth<=document.querySelector(".pursuit-content").clientWidth+1',
        ),
      );
      window.setSize(700, 800);
      await capture('pursuit-workpad-compact.png');
      assert(
        await evaluate(
          'document.querySelector(".pursuit-content").scrollWidth<=document.querySelector(".pursuit-content").clientWidth+1',
        ),
      );
      window.setSize(1480, 980);
      await evaluate(
        'document.querySelector(".workpad-entry[open] .workpad-provenance button").click()',
      );
      await wait('Boolean(document.querySelector(".pursuit-run-context"))');
      await click('All runs');
      await wait('Boolean(document.querySelector(".pursuit-workpad"))');
      assert.deepEqual(errors, []);
      console.log(
        'PASS Workpad UI: shared controls, left alignment, empty state, entries, type-aware filters, archives, linked entries, live updates, run provenance, dark mode and narrow layout.',
      );
      return;
    }
    if (process.argv.includes('--notifications-only')) {
      const main = (await request<Bot[]>('/bots'))[0];
      assert.equal(
        await evaluate('Boolean(document.querySelector(".rail-link .lucide-bell"))'),
        false,
      );
      const source = new ConversationRepository(api.store).create(main.workspaceId, {
        name: 'Autonomous review',
        description: '',
        botIds: [main.id],
      });
      api.store.run("UPDATE conversations SET kind='pursuit_run' WHERE id=?", source.id);
      const messageId = randomUUID();
      api.store.run(
        "INSERT INTO messages(id,conversation_id,bot_id,request_id,role,content,status,created_at) VALUES(?,?,?,?,'assistant','','complete',?)",
        messageId,
        source.id,
        main.id,
        randomUUID(),
        new Date().toISOString(),
      );
      api.notifications.notify(main, messageId, 'notification-smoke', {
        title: 'Review is ready',
        message:
          'I checked the export and verified **all 12 records**.\n\nThe results are ready for your review.',
      });
      await wait('Boolean(document.querySelector(".rail-link .lucide-bell"))');
      await evaluate('document.querySelector(".rail-link .lucide-bell").closest("button").click()');
      await wait('Boolean(document.querySelector(".notification-card"))');
      assert.equal(
        await evaluate(
          'document.querySelector(".notification-meta").textContent.includes("Pursuit update")',
        ),
        true,
      );
      assert.equal(await evaluate('document.querySelector(".workspace-sidebar") === null'), true);
      await capture('notifications-inbox.png');
      const previousMode = await evaluate<string>('document.documentElement.dataset.mode');
      await evaluate("document.documentElement.dataset.mode='dark'");
      await capture('notifications-inbox-dark.png');
      window.setSize(820, 900);
      await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
      assert.equal(
        await evaluate(
          'document.querySelector(".notification-card").getBoundingClientRect().right <= window.innerWidth',
        ),
        true,
      );
      await capture('notifications-inbox-narrow.png');
      window.setSize(1480, 980);
      await evaluate(`document.documentElement.dataset.mode=${JSON.stringify(previousMode)}`);
      await evaluate('document.querySelector(".notification-card-summary").click()');
      await click('Continue in chat');
      await wait(
        'Boolean(document.querySelector(".composer textarea")) && document.querySelector(".ai-message-feed").textContent.includes("all 12 records")',
      );
      const inbox = await request<NotificationInbox>('/notifications');
      assert.equal(inbox.items[0].readAt !== null, true);
      assert.equal(inbox.items[0].conversationId !== source.id, true);
      assert.equal(
        api.store.all(
          'SELECT * FROM messages WHERE conversation_id=?',
          inbox.items[0].conversationId!,
        ).length,
        1,
      );
      await capture('notification-conversation.png');
      await evaluate('document.querySelector(".rail-link .lucide-bell").closest("button").click()');
      await wait('Boolean(document.querySelector(".notification-card"))');
      await evaluate('document.querySelector(".notification-card-summary").click()');
      await click('Open conversation');
      await wait('Boolean(document.querySelector(".composer textarea"))');
      assert.equal(
        (await request<NotificationInbox>('/notifications')).items[0].conversationId,
        inbox.items[0].conversationId,
      );
      await evaluate('document.querySelector(".rail-link .lucide-bell").closest("button").click()');
      await wait('Boolean(document.querySelector(".notification-card"))');
      await evaluate('document.querySelector(".notification-card-summary").click()');
      await click('Dismiss');
      await wait(
        '!document.querySelector(".rail-link .lucide-bell") && !document.querySelector(".notification-card")',
      );
      assert.deepEqual(errors, []);
      console.log(
        'PASS notification UI: conditional bell, pursuit update, unread state, continuation, reopen and dismissal.',
      );
      return;
    }
    assert.equal(await evaluate('document.querySelector(".send-button").textContent.trim()'), '');
    assert.equal(
      await evaluate('getComputedStyle(document.querySelector(".send-button")).borderRadius'),
      '50%',
    );
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
        'document.querySelector(".bot-conversation-groups").textContent.includes("Reports to")',
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
    console.log('Bot UI: checking custom tool assignments.');
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
      permissionMode: 'user_approval',
    });
    console.log('Bot UI: custom tool registered.');
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
    let approvalFixture = false;
    let parallelFixture = false;
    let askFixture: 'clarification' | 'approval' | null = null;
    let delegationFixture = '';
    modelFixture = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body) as {
        model: string;
        messages: { role: string; content?: string }[];
      };
      sentModels.push(input.model);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (
        delegationFixture &&
        !input.messages.some((message) => message.role === 'tool') &&
        !input.messages.some((message) =>
          message.content?.includes('This message is coming from another bot'),
        )
      ) {
        res.write(
          `data: ${JSON.stringify({
            id: 'delegation-ui',
            object: 'chat.completion.chunk',
            created: 1,
            model: input.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'delegation-ui-call',
                      type: 'function',
                      function: {
                        name: 'manage_bot',
                        arguments: JSON.stringify({
                          action: 'send_message',
                          botId: delegationFixture,
                          mode: 'wait',
                          message: 'Review and ask for permission.',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      if (approvalFixture || askFixture) {
        const completed = input.messages.some((message) => message.role === 'tool');
        res.write(
          `data: ${JSON.stringify({
            id: 'approval-ui',
            object: 'chat.completion.chunk',
            created: 1,
            model: input.model,
            choices: [
              {
                index: 0,
                delta: completed
                  ? { content: 'Approval fixture finished.' }
                  : {
                      tool_calls: Array.from({ length: parallelFixture ? 3 : 1 }, (_, index) => ({
                        index,
                        id: `approval-ui-call-${index}`,
                        type: 'function',
                        function: {
                          name: askFixture ? 'communicate' : 'echo',
                          arguments: askFixture
                            ? JSON.stringify({
                                action: askFixture,
                                question:
                                  askFixture === 'clarification'
                                    ? 'Which audience should I focus on?'
                                    : 'May I publish this draft?',
                                ...(askFixture === 'clarification'
                                  ? {
                                      options: [
                                        {
                                          label: 'New customers',
                                          description: 'Reach a wider audience.',
                                          recommended: true,
                                        },
                                        {
                                          label: 'Existing customers',
                                          description: 'Focus on retention.',
                                          recommended: false,
                                        },
                                      ],
                                    }
                                  : {}),
                              })
                            : '{}',
                        },
                      })),
                    },
                finish_reason: completed ? 'stop' : 'tool_calls',
              },
            ],
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }
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
      models: [
        {
          id: 'fixture-default',
          name: 'fixture-default',
          contextWindowTokens: 32768,
          maxOutputTokens: 8192,
          supportsImages: false,
        },
        {
          id: 'fixture-alternate',
          name: 'fixture-alternate',
          contextWindowTokens: 65536,
          maxOutputTokens: 4096,
          supportsImages: false,
        },
      ],
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
    await wait('Boolean(document.querySelector(".bot-model-menu"))');
    assert.equal(await evaluate('Boolean(document.querySelector(".bot-model-sheet"))'), false);
    assert.equal(
      await evaluate('document.querySelector(".bot-model-group h4").textContent'),
      'Model fixture',
    );
    assert.equal(
      await evaluate(
        'getComputedStyle(document.querySelector(".bot-model-menu > small")).position',
      ),
      'sticky',
    );
    await capture('bot-model-picker.png');
    await click('fixture-alternate');
    await wait('!document.querySelector(".bot-model-menu")');
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
    await wait('Boolean(document.querySelector(".bot-model-menu"))');
    await evaluate(`document.querySelector('.bot-model-menu > button').click()`);
    await wait('!document.querySelector(".bot-model-menu")');
    assert.equal((await request<Bot[]>('/bots')).find((bot) => bot.id === main.id)?.model, null);
    await fill('.composer textarea', 'Use the provider default again.');
    await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
    await wait(
      'document.querySelectorAll(".ai-message--assistant").length===2 && !document.querySelector(".ai-model-picker").disabled',
    );
    assert.deepEqual(sentModels, ['fixture-alternate', 'fixture-default']);
    assert.equal((await request<Bot[]>('/bots')).find((bot) => bot.id === child.id)?.model, null);
    await capture('bot-name-only-sidebar.png');
    // Exercise the global dropup and real custom-tool pause/approve/reject flow.
    approvalFixture = true;
    await wait('!document.querySelector(".approval-mode-trigger").disabled');
    await evaluate('document.querySelector(".approval-mode-trigger").click()');
    await wait('Boolean(document.querySelector(".approval-mode-menu"))');
    assert.deepEqual(
      await evaluate(
        'Array.from(document.querySelectorAll(".approval-mode-menu strong")).map(e=>e.textContent)',
      ),
      ['Ask for approval', 'Full access'],
    );
    assert(
      await evaluate(
        'document.querySelector(".approval-mode-menu").getBoundingClientRect().bottom < document.querySelector(".approval-mode-trigger").getBoundingClientRect().top',
      ),
    );
    await capture('tool-approval-menu.png');
    await evaluate('document.querySelector(".approval-mode-menu [role=menuitemradio]").click()');
    await wait(
      'document.querySelector(".approval-mode-trigger").textContent.includes("Ask for approval") && !document.querySelector(".approval-mode-trigger").disabled',
    );
    assert.equal((await request<ApprovalState>('/approvals')).mode, 'ask-for-approval');
    await fill('.composer textarea', 'Run the approval fixture.');
    await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
    await wait('Boolean(document.querySelector(".tool-approval-card"))');
    await wait('Boolean(document.querySelector(".bot-pending-approvals"))');
    assert.equal(
      await evaluate(
        `document.querySelector('.rail-link:nth-child(1) .rail-notification') !== null`,
      ),
      true,
    );
    assert.equal(
      await evaluate(`document.querySelector('.rail-link:nth-child(3) .rail-notification')`),
      null,
    );
    assert.equal(
      await evaluate(
        `getComputedStyle(document.querySelector('.bot-pending-approvals')).animationName`,
      ),
      'approval-border-orbit',
    );
    const pendingChat = (await request<ApprovalState>('/approvals')).pending[0];
    // Background cards must never leak into another bot or another chat of the same bot.
    await evaluate(
      `document.querySelector('button[aria-label="New conversation with Scout"]').click()`,
    );
    await wait('document.querySelector(".conversation-header h1")?.textContent==="Scout"');
    assert.equal(await evaluate('document.querySelector(".tool-approval-card")'), null);
    await evaluate(
      `document.querySelector('button[aria-label="New conversation with Mukai"]').click()`,
    );
    await wait('document.querySelector(".conversation-header h1")?.textContent==="Mukai"');
    assert.equal(await evaluate('document.querySelector(".tool-approval-card")'), null);
    await evaluate('document.querySelector(".bot-pending-approvals").click()');
    await wait('Boolean(document.querySelector(".pending-approvals-page"))');
    assert.equal(await evaluate('document.querySelectorAll(".pending-approval-tile").length'), 1);
    assert.equal(
      await evaluate(
        'getComputedStyle(document.querySelector(".pending-approvals-header h1")).fontSize',
      ),
      '22px',
    );
    assert.equal(
      await evaluate(
        'getComputedStyle(document.querySelector(".pending-approvals-header")).backgroundImage',
      ),
      'none',
    );
    assert.equal(
      await evaluate(
        'getComputedStyle(document.querySelector(".pending-approval-tile")).backgroundImage',
      ),
      'none',
    );
    assert(
      await evaluate(
        'document.querySelector(".pending-approval-tile").getBoundingClientRect().height < 100',
      ),
    );
    await capture('pending-approvals-page.png');
    await evaluate(`document.documentElement.dataset.mode='dark'`);
    await capture('pending-approvals-page-dark.png');
    await evaluate(`document.documentElement.dataset.mode='light'`);
    await evaluate('document.querySelector(".pending-approval-tile").click()');
    await wait(
      'Boolean(document.querySelector(".tool-approval-card")) && Boolean(document.querySelector(".composer"))',
    );
    assert.equal(
      await evaluate(`localStorage.getItem('mukai.active-conversation.${main.id}')`),
      pendingChat.conversationId,
    );
    assert.equal(api.store.all('SELECT * FROM capability_runs').length, 0);
    assert(
      await evaluate(`Boolean(document.querySelector('button[aria-label="Stop generation"]'))`),
    );
    assert(
      await evaluate(
        'document.querySelector(".tool-approval-card").getBoundingClientRect().bottom <= document.querySelector(".composer").getBoundingClientRect().top',
      ),
    );
    await evaluate('document.querySelector(".tool-approval-card details").open=true');
    await evaluate(
      `(()=>{const button=document.querySelector('button[aria-label="About Full Access Mode"]');button.focus();button.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));})()`,
    );
    await wait('Boolean(document.querySelector("[role=tooltip]"))');
    assert(
      await evaluate(
        'document.querySelector("[role=tooltip]").textContent.includes("Other workspaces are unaffected")',
      ),
    );
    await capture('tool-approval-tooltip.png');
    await evaluate(
      'document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))',
    );
    await wait('!document.querySelector("[role=tooltip]")');
    new WorkspaceRepository(api.store).create({
      id: 'approval-isolation',
      name: 'Separate workspace',
      folder: null,
      createdAt: new Date().toISOString(),
      computer: 'local',
    });
    await request('/approvals?workspaceId=approval-isolation', 'PUT', { mode: 'ask-for-approval' });
    await evaluate('document.querySelector(".tool-approval-full-access input").click()');
    await wait(
      'document.querySelector(".tool-approval-full-access input").checked && !document.querySelector(".tool-approval-full-access input").disabled',
    );
    assert.equal((await request<ApprovalState>('/approvals')).mode, 'full-access');
    assert.equal(
      (await request<ApprovalState>('/approvals?workspaceId=approval-isolation')).mode,
      'ask-for-approval',
    );
    assert.equal((await request<ApprovalState>('/approvals')).pending[0].id, pendingChat.id);
    await capture('tool-approval-full-access.png');
    await evaluate('document.querySelector(".tool-approval-full-access input").click()');
    await wait(
      '!document.querySelector(".tool-approval-full-access input").checked && !document.querySelector(".tool-approval-full-access input").disabled',
    );
    await capture('tool-approval-card.png');
    window.setSize(900, 800);
    await capture('tool-approval-card-narrow.png');
    window.setSize(1480, 980);
    window.reload();
    await wait(
      'Boolean(document.querySelector(".tool-approval-card")) && !document.querySelector(".approval-mode-trigger").disabled',
    );
    assert.equal(api.store.all('SELECT * FROM capability_runs').length, 0);
    await click('Approve tool call');
    await wait(
      `!document.querySelector('.tool-approval-card') && !document.querySelector('button[aria-label="Stop generation"]')`,
    );
    assert.equal(api.store.all('SELECT * FROM capability_runs').length, 1);
    await wait(
      '!document.querySelector(".bot-pending-approvals") && !document.querySelector(".rail-link:nth-child(1) .rail-notification")',
    );
    assert(
      await evaluate(
        'document.querySelector(".ai-message-feed").textContent.includes("Approval fixture finished.")',
      ),
    );
    await fill('.composer textarea', 'Reject the next approval fixture.');
    await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
    await wait('Boolean(document.querySelector(".tool-approval-card"))');
    await click('Reject');
    await wait(
      `!document.querySelector('.tool-approval-card') && !document.querySelector('button[aria-label="Stop generation"]')`,
    );
    assert.equal(api.store.all('SELECT * FROM capability_runs').length, 1);
    await evaluate('document.querySelector(".approval-mode-trigger").click()');
    await wait('Boolean(document.querySelector(".approval-mode-menu"))');
    await evaluate(
      'document.querySelectorAll(".approval-mode-menu [role=menuitemradio]")[1].click()',
    );
    await wait(
      'document.querySelector(".approval-mode-trigger").textContent.includes("Full access") && !document.querySelector(".approval-mode-trigger").disabled',
    );
    await fill('.composer textarea', 'Run with full access.');
    await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
    // Explicit user-approval tools still wait in Full access mode.
    await wait('Boolean(document.querySelector(".tool-approval-card"))');
    assert.equal(api.store.all('SELECT * FROM capability_runs').length, 1);
    await click('Approve tool call');
    await wait(
      `document.querySelectorAll('.ai-message--assistant').length===5 && !document.querySelector('button[aria-label="Stop generation"]')`,
    );
    assert.equal(api.store.all('SELECT * FROM capability_runs').length, 2);
    assert.equal(await evaluate('document.querySelector(".tool-approval-card")'), null);
    // Pending pursuit approvals must open the exact run, not its overview.
    await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
    const pursuit = api.pursuits.create(main, {
      name: 'Approval navigation',
      objective: 'Check the custom tool',
      successCriteria: 'Verified result',
      firstRunAt: null,
      deadline: null,
    });
    const pendingRun = api.pursuits.runNow(pursuit.id);
    await wait('Boolean(document.querySelector(".bot-pending-approvals"))');
    await evaluate('document.querySelector(".bot-pending-approvals").click()');
    await wait('Boolean(document.querySelector(".pending-approval-tile"))');
    assert(
      await evaluate(
        'document.querySelector(".pending-approval-tile").textContent.includes("Pursuit run")',
      ),
    );
    await evaluate('document.querySelector(".pending-approval-tile").click()');
    await wait(
      'Boolean(document.querySelector("button")) && document.querySelector(".pursuit-title h1")?.textContent==="Approval navigation" && Boolean(document.querySelector(".tool-approval-card"))',
    );
    assert(
      (await request<ApprovalState>('/approvals')).pending.some(
        (item) => item.target?.runId === pendingRun.id,
      ),
    );
    await capture('pending-approval-pursuit-run.png');
    await click('Stop run');
    await wait('!document.querySelector(".tool-approval-card")');
    await request('/approvals', 'PUT', { mode: 'full-access' });
    await evaluate(
      `Array.from(document.querySelectorAll('.rail-link')).find(b=>b.textContent.trim()==='Bots').click()`,
    );
    await wait('Boolean(document.querySelector(".composer"))');
    // Workspace and approval pickers use the same native floating surface.
    await evaluate('document.querySelector(".workspace-switcher > button").click()');
    await wait('Boolean(document.querySelector(".workspace-picker-menu"))');
    assert(
      await evaluate(
        'document.querySelector(".workspace-picker-menu").classList.contains("popup-menu")',
      ),
    );
    await capture('workspace-picker-menu.png');
    await evaluate(
      `document.querySelector('.workspace-picker-menu [role=menuitemradio]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`,
    );
    await wait('!document.querySelector(".workspace-picker-menu")');
    // Three simultaneous calls share one compact accordion, with individual and bulk grants.
    await request('/approvals', 'PUT', { mode: 'ask-for-approval' });
    parallelFixture = true;
    await evaluate(
      `document.querySelector('button[aria-label="New conversation with Mukai"]').click()`,
    );
    await wait(
      'document.querySelectorAll(".ai-message--assistant").length===0 && Boolean(document.querySelector(".composer textarea"))',
    );
    const runsBeforeBatch = api.store.all('SELECT * FROM capability_runs').length;
    await fill('.composer textarea', 'Run parallel approval tools.');
    await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
    await wait('document.querySelectorAll(".tool-approval-batch .tool-approval-card").length===3');
    assert.equal(await evaluate('document.querySelectorAll(".tool-approval-batch").length'), 1);
    assert.equal(
      await evaluate('document.querySelector(".tool-approval-batch > details").open'),
      false,
    );
    assert.equal(api.store.all('SELECT * FROM capability_runs').length, runsBeforeBatch);
    // Rotating icons must not alter scroll bounds on any animation frame.
    const scrollSizes = await evaluate<number[]>(`new Promise(resolve=>{
      const values=[]; let start;
      function sample(time) {
        start ??= time;
        const e=document.querySelector('.response-tool-group-content');
        values.push(e.scrollHeight);
        if(time-start<1400) requestAnimationFrame(sample); else resolve(values);
      }
      requestAnimationFrame(sample);
    })`);
    assert.equal(new Set(scrollSizes).size, 1);
    await evaluate('document.querySelector(".bot-pending-approvals").click()');
    await wait('Boolean(document.querySelector(".pending-approvals-page"))');
    assert.equal(await evaluate('document.querySelectorAll(".pending-approval-tile").length'), 1);
    assert.equal(
      await evaluate('document.querySelectorAll(".pending-approval-tools > span").length'),
      3,
    );
    await capture('pending-approvals-grouped.png');
    await evaluate('document.querySelector(".pending-approval-tile").click()');
    await wait('Boolean(document.querySelector(".tool-approval-batch"))');
    await capture('parallel-approvals-collapsed.png');
    await evaluate('document.querySelector(".tool-approval-batch > details > summary").click()');
    await evaluate('document.querySelector(".tool-approval-card details").open=true');
    await capture('parallel-approvals-expanded.png');
    await evaluate('document.querySelector(".tool-approval-card .button--primary").click()');
    await wait('document.querySelectorAll(".tool-approval-batch .tool-approval-card").length===2');
    assert.equal(api.store.all('SELECT * FROM capability_runs').length, runsBeforeBatch + 1);
    assert(
      await evaluate('Boolean(document.querySelector(\'button[aria-label="Stop generation"]\'))'),
    );
    await click('Approve all');
    await wait(
      '!document.querySelector(".tool-approval-batch") && !document.querySelector(\'button[aria-label="Stop generation"]\')',
    );
    assert.equal(api.store.all('SELECT * FROM capability_runs').length, runsBeforeBatch + 3);
    parallelFixture = false;
    await request('/approvals', 'PUT', { mode: 'full-access' });
    approvalFixture = false;
    // Ask uses the same pending flow in Full access, without a second permission prompt.
    console.log('Bot UI: checking ask clarification and approval cards.');
    askFixture = 'clarification';
    await evaluate(
      `document.querySelector('button[aria-label="New conversation with Mukai"]').click()`,
    );
    await wait('document.querySelectorAll(".ai-message--assistant").length===0');
    await fill('.composer textarea', 'Ask me who to focus on.');
    await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
    await wait('Boolean(document.querySelector(".ask-request-card"))');
    assert.equal(await evaluate('document.querySelectorAll(".tool-approval-card").length'), 0);
    assert.equal(await evaluate('document.querySelectorAll(".ask-recommended").length'), 1);
    assert.equal(
      await evaluate('document.querySelectorAll(".ask-option input:checked").length'),
      0,
    );
    assert.equal(
      await evaluate('document.querySelector(".ask-request-card button[type=submit]").disabled'),
      true,
    );
    await evaluate('document.querySelector(".bot-pending-approvals").click()');
    await wait('Boolean(document.querySelector(".pending-approval-tile"))');
    assert(
      await evaluate(
        'document.querySelector(".pending-approval-tile").textContent.includes("Clarification")',
      ),
    );
    await capture('ask-pending-page.png');
    await evaluate('document.querySelector(".pending-approval-tile").click()');
    await wait('Boolean(document.querySelector(".ask-request-card"))');
    assert.equal(await evaluate('document.querySelector(".composer")'), null);
    await capture('ask-clarification-card.png');
    await evaluate(`document.documentElement.dataset.mode='dark'`);
    await capture('ask-clarification-card-dark.png');
    await evaluate(`document.documentElement.dataset.mode='light'`);
    await evaluate('document.querySelectorAll(".ask-option input")[1].click()');
    await click('Submit');
    await wait(
      '!document.querySelector(".ask-request-card") && !document.querySelector(\'button[aria-label="Stop generation"]\')',
    );
    assert(
      await evaluate(
        'document.querySelector(".ai-message-feed").textContent.includes("Answered question")',
      ),
    );
    assert(await evaluate('Boolean(document.querySelector(".composer textarea"))'));
    // A typed answer is also accepted after reloading the UI.
    await evaluate(
      `document.querySelector('button[aria-label="New conversation with Mukai"]').click()`,
    );
    await wait('document.querySelectorAll(".ai-message--assistant").length===0');
    await fill('.composer textarea', 'Ask me again.');
    await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
    await wait('Boolean(document.querySelector(".ask-request-card"))');
    const questionId = (await request<ApprovalState>('/approvals')).pending[0].id;
    window.reload();
    await wait('Boolean(document.querySelector(".ask-request-card"))');
    assert.equal((await request<ApprovalState>('/approvals')).pending[0].id, questionId);
    await fill('.ask-answer-field textarea', 'Focus on partners instead.');
    window.setSize(900, 800);
    await capture('ask-clarification-card-narrow.png');
    assert(
      await evaluate(
        'document.querySelector(".ask-request-card button[type=submit]").getBoundingClientRect().bottom <= document.querySelector(".ask-composer").getBoundingClientRect().bottom',
      ),
    );
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    window.setSize(1480, 980);
    await click('Submit');
    await wait(
      '!document.querySelector(".ask-request-card") && !document.querySelector(\'button[aria-label="Stop generation"]\')',
    );
    // Multiple questions replace the composer with a pager and preserve answers between pages.
    parallelFixture = true;
    await evaluate(
      'document.querySelector(\'button[aria-label="New conversation with Mukai"]\').click()',
    );
    await wait('document.querySelectorAll(".ai-message--assistant").length===0');
    await fill('.composer textarea', 'Ask three questions.');
    await evaluate('document.querySelector(\'button[aria-label="Send message"]\').click()');
    await wait('document.querySelectorAll(".ask-request-card").length === 3');
    const activeQuestion = '.ask-composer > div:not([hidden])';
    assert.equal(await evaluate('document.querySelector(".composer")'), null);
    await fill(activeQuestion + ' textarea', 'Keep my first answer.');
    await evaluate('document.querySelector(\'button[aria-label="Collapse question"]\').click()');
    assert.equal(await evaluate('document.querySelector(".ask-request-content").hidden'), true);
    await evaluate('document.querySelector(\'button[aria-label="Expand question"]\').click()');
    await evaluate('document.querySelector(\'button[aria-label="Next question"]\').click()');
    assert.equal(await evaluate('document.querySelector(".ask-request-count").textContent'), '2/3');
    await fill(activeQuestion + ' textarea', 'Keep my second answer.');
    await evaluate('document.querySelector(\'button[aria-label="Previous question"]\').click()');
    assert.equal(await evaluate('document.querySelector(".ask-request-count").textContent'), '1/3');
    assert.equal(
      await evaluate('document.querySelector(".ask-request-content textarea").value'),
      'Keep my first answer.',
    );
    await capture('ask-questions-pager.png');
    await click('Skip');
    await wait('document.querySelectorAll(".ask-request-card").length === 2');
    assert.equal(
      await evaluate('document.querySelector(".ask-request-content textarea").value'),
      'Keep my second answer.',
    );
    await click('Submit');
    await wait('document.querySelectorAll(".ask-request-card").length === 1');
    await evaluate('document.querySelectorAll(".ask-option input")[1].click()');
    await click('Submit');
    await wait(
      '!document.querySelector(".ask-request-card") && !document.querySelector(\'button[aria-label="Stop generation"]\')',
    );
    assert(await evaluate('Boolean(document.querySelector(".composer textarea"))'));
    parallelFixture = false;
    // Approval questions keep immediate Approve/Deny alongside the optional reason flow.
    askFixture = 'approval';
    for (const choice of ['Deny', 'Approve']) {
      await evaluate(
        `document.querySelector('button[aria-label="New conversation with Mukai"]').click()`,
      );
      await wait('document.querySelectorAll(".ai-message--assistant").length===0');
      await fill('.composer textarea', 'Ask permission to publish.');
      await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
      await wait('Boolean(document.querySelector(".ask-request-card"))');
      assert.deepEqual(
        await evaluate(
          'Array.from(document.querySelectorAll(".ask-request-actions button")).map(button=>button.textContent)',
        ),
        ['Deny', 'Deny with reason', 'Approve'],
      );
      assert.equal(await evaluate('document.querySelector(".ask-request-card textarea")'), null);
      if (choice === 'Deny') await capture('ask-approval-card.png');
      await click(choice);
      await wait(
        '!document.querySelector(".ask-request-card") && !document.querySelector(\'button[aria-label="Stop generation"]\')',
      );
    }
    // The close control cancels the waiting response and restores the normal composer.
    await evaluate(
      'document.querySelector(\'button[aria-label="New conversation with Mukai"]\').click()',
    );
    await wait('document.querySelectorAll(".ai-message--assistant").length===0');
    await fill('.composer textarea', 'Ask, then cancel.');
    await evaluate('document.querySelector(\'button[aria-label="Send message"]\').click()');
    await wait('Boolean(document.querySelector(".ask-request-card"))');
    await evaluate('document.querySelector(\'button[aria-label="Stop response"]\').click()');
    await wait(
      '!document.querySelector(".ask-request-card") && Boolean(document.querySelector(".composer textarea"))',
    );
    assert.equal((await request<ApprovalState>('/approvals')).pending.length, 0);
    askFixture = null;
    const specialistInput = {
      name: 'Ada',
      role: 'Code architect',
      instructions: 'Design and delegate implementation work.',
      providerId: null,
      model: null,
      supportsImages: null,
      contextWindowTokens: null,
    };
    const architect = await api.botManagement.create(main, specialistInput, ['manage_bot']);
    const engineer = await api.botManagement.create(main, {
      ...specialistInput,
      name: 'Nova',
      role: 'Software engineer',
      reportsToBotId: architect.id,
    });
    await api.botManagement.create(main, {
      ...specialistInput,
      name: 'Atlas',
      role: 'Research analyst',
    });
    await click('Bot Hierarchy');
    await wait('document.querySelectorAll(".bot-tree-card").length===5');
    assert.equal(
      await evaluate(
        'document.querySelector(".sidebar-hierarchy-link").getAttribute("aria-current")',
      ),
      'page',
    );
    assert.equal(
      await evaluate('document.querySelector(".bot-tree-card.is-main strong").textContent'),
      'Mukai',
    );
    assert.deepEqual(
      await evaluate(
        `Array.from(document.querySelectorAll('ul[aria-label="Bots created by Ada"] > li > button .bot-tree-copy strong')).map(e=>e.textContent)`,
      ),
      ['Nova'],
    );
    assert.equal(await evaluate('document.querySelectorAll(".bot-tree-root").length'), 1);
    assert.equal(
      await evaluate('document.querySelector(".conversation-heading h1").textContent'),
      'Bot Hierarchy',
    );
    assert.equal(await evaluate('document.querySelector(".bot-tree-card").offsetHeight'), 76);
    await evaluate(`document.querySelector('button[aria-label="Zoom in"]').click()`);
    await wait('document.querySelector(".bot-hierarchy-zoom-value").textContent==="110%"');
    await evaluate(`document.querySelector('button[aria-label="Zoom out"]').click()`);
    await wait('document.querySelector(".bot-hierarchy-zoom-value").textContent==="100%"');
    await evaluate(
      `document.querySelector('.bot-hierarchy-canvas').dispatchEvent(new WheelEvent('wheel',{deltaY:-100,ctrlKey:true,bubbles:true,cancelable:true}))`,
    );
    await wait('document.querySelector(".bot-hierarchy-zoom-value").textContent!=="100%"');
    await evaluate(`document.querySelector('button[aria-label="Reset zoom"]').click()`);
    await wait('document.querySelector(".bot-hierarchy-zoom-value").textContent==="100%"');
    await evaluate(
      `Array.from(document.querySelectorAll('.bot-tree-toggle')).find(e=>e.getAttribute('aria-label').startsWith('Collapse Ada')).click()`,
    );
    await wait('document.querySelectorAll(".bot-tree-card").length===4');
    await evaluate(
      `Array.from(document.querySelectorAll('.bot-tree-toggle')).find(e=>e.getAttribute('aria-label').startsWith('Expand Ada')).click()`,
    );
    await wait('document.querySelectorAll(".bot-tree-card").length===5');
    await evaluate(
      `(()=>{const zoom=document.querySelector('button[aria-label="Zoom in"]');for(let i=0;i<10;i++)zoom.click();})()`,
    );
    await wait('document.querySelector(".bot-hierarchy-zoom-value").textContent==="200%"');
    const panStart = await evaluate<{ x: number; y: number; left: number }>(
      `(()=>{const e=document.querySelector('.bot-hierarchy-canvas'),r=e.getBoundingClientRect();return {x:Math.round(r.left+150),y:Math.round(r.top+15),left:e.scrollLeft};})()`,
    );
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      x: panStart.x,
      y: panStart.y,
      button: 'left',
      clickCount: 1,
    });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: panStart.x - 80, y: panStart.y });
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      x: panStart.x - 80,
      y: panStart.y,
      button: 'left',
      clickCount: 1,
    });
    await wait(
      `document.querySelector('.bot-hierarchy-canvas').scrollLeft > ${panStart.left + 50}`,
    );
    await evaluate(`document.querySelector('button[aria-label="Center view"]').click()`);
    assert.equal(
      await evaluate(
        `(()=>{const e=document.querySelector('.bot-hierarchy-canvas');return Math.abs(e.scrollLeft-(e.scrollWidth-e.clientWidth)/2)<2;})()`,
      ),
      true,
    );
    await evaluate(`document.querySelector('button[aria-label="Reset zoom"]').click()`);
    await wait('document.querySelector(".bot-hierarchy-zoom-value").textContent==="100%"');
    await capture('bot-hierarchy.png');
    await evaluate(
      `document.querySelector('button[aria-label="Open Nova, Software engineer"]').click()`,
    );
    await wait(`document.querySelector('.conversation-heading h1')?.textContent==='Nova'`);
    await evaluate(`document.querySelector('button[aria-label="Bot details"]').click()`);
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('.ai-details dt')).find(e=>e.textContent==='Reports to').nextElementSibling.textContent.trim()`,
      ),
      'Ada',
    );
    assert.equal(engineer.createdBy, architect.id);
    await click('Bot Hierarchy');
    await wait('Boolean(document.querySelector(".bot-hierarchy-canvas"))');
    window.setSize(720, 900);
    await capture('bot-hierarchy-narrow.png');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    window.setSize(1480, 980);
    console.log('Bot UI: checking pair conversations and their read-only viewer.');
    assert(api.access.allowed(engineer, 'manage_bot'));
    const pairSignal = new AbortController().signal;
    const pairThread = await api.botManagement.sendMessage(
      main,
      engineer.id,
      'Review the architecture.',
      pairSignal,
    );
    await api.botManagement.sendMessage(
      main,
      engineer.id,
      'Continue the architecture review.',
      pairSignal,
      pairThread.conversationId,
    );
    await api.botManagement.sendMessage(main, engineer.id, 'Start a separate review.', pairSignal);
    await evaluate(
      `Array.from(document.querySelectorAll('.rail-link')).find(b=>b.textContent.trim()==='Bots').click()`,
    );
    await wait(
      'document.querySelector(".workspace-sidebar").textContent.includes("Bot conversations")',
    );
    assert.equal(
      await evaluate(
        'document.querySelector(".workspace-sidebar").textContent.includes("Your bots")',
      ),
      false,
    );
    const pairTitle = [main, engineer]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((bot) => bot.name)
      .join('/');
    await wait(
      `Boolean(document.querySelector('button[aria-label=${JSON.stringify(pairTitle)}]'))`,
    );
    await evaluate(
      `document.querySelector('button[aria-label=${JSON.stringify(pairTitle)}]').click()`,
    );
    await wait(
      `document.querySelector('button[aria-label=${JSON.stringify(pairTitle)}]').closest('section').querySelectorAll('.bot-conversation-row').length===2`,
    );
    await evaluate(`document.querySelector('button[title="Review the architecture."]').click()`);
    await wait('document.querySelectorAll(".ai-message").length===4');
    assert.equal(await evaluate('document.querySelector(".composer")'), null);
    assert.equal(await evaluate('document.querySelector("textarea")'), null);
    assert.equal(
      await evaluate('document.querySelector(\'button[aria-label="Send message"]\')'),
      null,
    );
    assert.equal(
      await evaluate('document.querySelector(".conversation-heading h1").textContent'),
      pairTitle,
    );
    assert.deepEqual(
      await evaluate(
        'Array.from(document.querySelectorAll(".ai-message-meta strong")).map(e=>e.textContent)',
      ),
      ['Mukai', 'Nova', 'Mukai', 'Nova'],
    );
    assert.equal(
      await evaluate('document.querySelectorAll(".ai-message-meta .bot-badge").length'),
      4,
    );
    assert.equal(
      await evaluate('document.querySelectorAll(".heading-identity .avatar").length'),
      2,
    );
    await capture('bot-pair-conversation.png');
    await api.botManagement.sendMessage(
      main,
      engineer.id,
      'Follow up while the viewer is open.',
      pairSignal,
      pairThread.conversationId,
    );
    await wait('document.querySelectorAll(".ai-message").length===6');
    await evaluate(`document.querySelector('button[title="Start a separate review."]').click()`);
    await wait('document.querySelectorAll(".ai-message").length===2');
    askFixture = 'approval';
    const pairApproval = api.botManagement.sendMessage(
      main,
      child.id,
      'Review with approval required.',
      pairSignal,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('.rail-link')).find(b=>b.textContent.trim()==='Bots').click()`,
    );
    await wait('Boolean(document.querySelector(".bot-pending-approvals"))');
    const pendingPairRequest = (await request<ApprovalState>('/approvals')).pending[0];
    assert.equal(pendingPairRequest.target?.kind, 'bot');
    await evaluate('document.querySelector(".bot-pending-approvals").click()');
    await wait('Boolean(document.querySelector(".pending-approval-tile"))');
    await evaluate('document.querySelector(".pending-approval-tile").click()');
    await wait('Boolean(document.querySelector(".ask-request-card"))');
    assert.equal(await evaluate('document.querySelector(".composer")'), null);
    assert.equal(
      await evaluate('document.querySelector(\'button[aria-label="Send message"]\')'),
      null,
    );
    await click('Approve');
    assert.equal((await pairApproval).status, 'complete');
    askFixture = null;
    await wait('!document.querySelector(".ask-request-card")');
    console.log('Bot UI: checking parent navigation and child approvals.');
    window.setSize(1480, 980);
    delegationFixture = child.id;
    askFixture = 'approval';
    await evaluate(
      `Array.from(document.querySelectorAll('.rail-link')).find(b=>b.textContent.trim()==='Bots').click()`,
    );
    await wait(
      'Boolean(document.querySelector(\'button[aria-label="New conversation with Mukai"]\'))',
    );
    await evaluate(
      'document.querySelector(\'button[aria-label="New conversation with Mukai"]\').click()',
    );
    await wait(
      'Boolean(document.querySelector(".composer textarea")) && document.querySelector(".conversation-heading h1").textContent==="Mukai"',
    );
    await wait('document.querySelectorAll(".ai-message--assistant").length===0');
    await fill('.composer textarea', 'Delegate this review.');
    await evaluate('document.querySelector(\'button[aria-label="Send message"]\').click()');
    await wait('Boolean(document.querySelector(".ask-request-card"))');
    assert(
      (
        await evaluate<string>('document.querySelector(".ask-request-header").textContent')
      ).includes(`Approval from sub-bot ${child.name}`),
    );
    assert(
      (await evaluate<string>('document.querySelector(".ask-request-card").textContent')).includes(
        `Your bot is waiting for ${child.name}`,
      ),
    );
    const parentApproval = (await request<ApprovalState>('/approvals')).pending[0];
    assert(parentApproval.blockedParents?.some((parent) => parent.botId === main.id));
    await wait('Boolean(document.querySelector(".response-delegation-link"))');
    await capture('bot-delegation-parent-approval.png');
    window.setSize(720, 900);
    await capture('bot-delegation-parent-narrow.png');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    await evaluate('document.querySelector(".response-delegation-link").click()');
    await wait(
      'document.querySelectorAll(".ai-message").length===2 && Boolean(document.querySelector(".ask-request-card")) && !document.querySelector(".composer")',
    );
    assert.equal(
      await evaluate(
        'document.querySelector(".ask-request-header").textContent.includes("sub-bot")',
      ),
      false,
    );
    assert.equal(
      await evaluate(
        'document.querySelector(".conversation-heading h1").textContent.includes("/")',
      ),
      true,
    );
    await click('Approve');
    await wait('!document.querySelector(".ask-request-card")');
    await evaluate(
      `Array.from(document.querySelectorAll('.rail-link')).find(b=>b.textContent.trim()==='Bots').click()`,
    );
    await wait(
      'document.querySelector(".conversation-heading h1")?.textContent==="Mukai" && !document.querySelector(\'button[aria-label="Stop generation"]\')',
    );
    assert.equal((await request<ApprovalState>('/approvals')).pending.length, 0);
    delegationFixture = '';
    askFixture = null;
    window.setSize(720, 900);
    await capture('bot-pair-conversation-narrow.png');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
    // Configure a second provider and its models through the settings UI.
    window.setSize(1480, 980);
    await evaluate('document.querySelector(".ai-model-picker").click()');
    await wait('Boolean(document.querySelector(".bot-model-menu"))');
    await click('Configure models');
    await wait('Boolean(document.querySelector("#settings-tab-providers[aria-selected=true]"))');
    await wait(
      `Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='Add provider' && !button.disabled)`,
    );
    await click('Add provider');
    await wait(
      `Boolean(document.querySelector('button[aria-label="Add OpenAI-compatible / local"]'))`,
    );
    await evaluate(
      `document.querySelector('button[aria-label="Add OpenAI-compatible / local"]').click()`,
    );
    await wait('Boolean(document.querySelector(".provider-panel input[type=url]"))');
    await fill('.provider-panel input[maxlength="80"]', 'GLM');
    await fill('.provider-panel input[type="url"]', 'http://127.0.0.1:11434/v1');
    assert.equal(await evaluate('Boolean(document.querySelector(".provider-models"))'), false);
    await click('Save connection');
    await wait('Boolean(document.querySelector(".provider-models"))');
    await click('Add model');
    await wait('Boolean(document.querySelector(".provider-model-editor"))');
    assert.equal(
      await evaluate('Boolean(document.querySelector("dialog.provider-model-sheet[open]"))'),
      true,
    );
    assert.equal(
      await evaluate(
        'Boolean(document.querySelector(".provider-model-editor .checkbox-control .themed-checkbox"))',
      ),
      true,
    );
    await fill('.provider-model-editor input[maxlength="150"]', 'glm-test');
    await fill('.provider-model-editor label:nth-of-type(2) input', 'GLM Test');
    await fill('.provider-model-editor input[type="number"]', '131072');
    await capture('provider-model-sheet.png');
    await click('Save model');
    await wait('!document.querySelector(".provider-model-editor")');
    const glm = (await request<{ name: string; models: { id: string }[] }[]>('/providers')).find(
      (provider) => provider.name === 'GLM',
    );
    assert.deepEqual(
      glm?.models.map((model) => model.id),
      ['glm-test'],
    );
    await capture('provider-model-settings.png');
    await evaluate(
      `Array.from(document.querySelectorAll('.rail-link')).find(b=>b.textContent.trim()==='Bots').click()`,
    );
    await wait('Boolean(document.querySelector(".ai-model-picker"))');
    await evaluate('document.querySelector(".ai-model-picker").click()');
    await wait('Boolean(document.querySelector(".bot-model-menu"))');
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('.bot-model-group h4')).some(e=>e.textContent==='GLM')`,
      ),
      true,
    );
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('.bot-model-group button')).some(e=>e.textContent==='GLM Test')`,
      ),
      true,
    );
    await evaluate(
      `document.querySelector('.ai-model-picker').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS bot UI: onboarding, assignments, models, approvals, exact chat and pursuit links, reload recovery, nested hierarchy, read-only bot pair threads, live follow-ups, parent delegation navigation, child approval identity, and narrow layout.',
    );
  } catch (error) {
    console.error('Bot UI failed before cleanup:', error);
    await capture('workspace-smoke-failure.png');
    if (api.workspaces.list().some((workspace) => workspace.id === 'default'))
      console.error('Smoke approvals:', JSON.stringify(await request('/approvals')));
    console.error(
      'Smoke final message:',
      JSON.stringify(
        api.store.get(
          "SELECT bot_id,content,status,error,activity_json FROM messages WHERE role='assistant' ORDER BY sequence DESC LIMIT 1",
        ),
      ),
    );
    throw error;
  } finally {
    window.destroy();
    await api.shutdown();
    api.server.closeAllConnections();
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
