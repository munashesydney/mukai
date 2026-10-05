import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { startApiServer } from '../src/server/app';
import { IPC } from '../src/shared/contracts';
import type { Bot } from '../src/shared/ai';
import type { ApprovalState } from '../src/shared/approvals';

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
                          name: askFixture ? 'ask' : 'echo',
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
    // Approval questions offer just Approve and Deny, and report both outcomes.
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
        ['Deny', 'Approve'],
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
      avatar: 'atlas' as const,
      instructions: 'Design and delegate implementation work.',
      providerId: null,
      model: null,
      supportsImages: null,
      contextWindowTokens: null,
    };
    const architect = await api.botManagement.create(main, specialistInput, ['manage_bot']);
    const engineer = await api.botManagement.create(architect, {
      ...specialistInput,
      name: 'Nova',
      role: 'Software engineer',
      avatar: 'nova',
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
        `Array.from(document.querySelectorAll('.ai-details dt')).find(e=>e.textContent==='Created by').nextElementSibling.textContent.trim()`,
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
      `Array.from(document.querySelectorAll('.rail-link')).find(b=>b.textContent.trim()==='Spaces').click()`,
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
    await wait('document.querySelectorAll(".bot-conversation-row").length===2');
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
    await wait(`Boolean(document.querySelector('button[aria-label="Provider type"]'))`);
    await evaluate(`document.querySelector('button[aria-label="Provider type"]').click()`);
    await wait(`Boolean(document.querySelector('[role=option]'))`);
    await evaluate(
      `Array.from(document.querySelectorAll('[role=option]')).find(e=>e.textContent==='OpenAI-compatible / local').click()`,
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
    await click('Keep model');
    await wait('!document.querySelector(".provider-model-editor")');
    await click('Save connection');
    await wait('!document.querySelector(".provider-panel button[type=submit]").disabled');
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
    console.error('Smoke approvals:', JSON.stringify(await request('/approvals')));
    console.error(
      'Smoke final message:',
      JSON.stringify(
        api.store.get(
          "SELECT bot_id,content,status,error,activity_json FROM messages WHERE role='assistant' ORDER BY sequence DESC LIMIT 1",
        ),
      ),
    );
    console.error('Bot UI failed before cleanup:', error);
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
