import { app, BrowserWindow, ipcMain } from 'electron';
import { createServer, type ServerResponse } from 'node:http';
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { startApiServer } from '../src/server/app';
import { seedTestWorkspace } from '../src/server/testFixtures';
import { scoutBot } from '../src/server/services/botService';
import { BotRepository } from '../src/server/repositories/botRepository';
import { ConversationRepository } from '../src/server/repositories/conversationRepository';
import { ArtifactRepository } from '../src/server/repositories/artifactRepository';
import { FileChangeRepository } from '../src/server/repositories/fileChangeRepository';
import { MukaiBrowserHost } from '../src/main/embeddedBrowserHost';
import { IPC } from '../src/shared/contracts';
import type { ChatActivity } from '../src/shared/ai';
import type { BrowserBounds } from '../src/shared/runtime';

async function main() {
  const dir = process.env.MUKAI_ACTIVITY_SMOKE_DIR;
  if (!dir) throw new Error('Disposable activity smoke directory required.');
  app.setPath('userData', dir);
  await app.whenReady();
  const host = new MukaiBrowserHost();
  const api = await startApiServer(0, {
    dataDir: join(dir, 'api'),
    embeddedBrowser: host,
    memoryExtractor: async () => ({ facts: [] }),
    memoryReviewIdleMs: 0,
  });
  seedTestWorkspace(api.store);
  const bots = new BotRepository(api.store);
  bots.create(scoutBot());
  for (const [id, name, avatar] of [
    ['nova', 'Nova', 'nova'],
    ['atlas', 'Atlas', 'atlas'],
  ] as const)
    bots.create({
      ...scoutBot('default', id),
      name,
      avatar,
      role: 'Project builder',
      isMain: false,
      createdBy: 'scout',
    });
  const conversations = new ConversationRepository(api.store);
  const conversation = conversations.createPrivate('default', 'scout');
  const atlasChat = conversations.createPrivate('default', 'atlas');
  const pair = conversations.createBotChat('default', 'scout', 'nova', 'Build the project preview');
  const space = conversations.create('default', {
    name: 'Project studio',
    description: 'Shared project work',
    botIds: ['scout', 'nova'],
  });
  api.store.run('UPDATE workspaces SET folder=? WHERE id=?', dir, 'default');
  const owner = { workspaceId: 'default', botId: 'scout', conversationId: conversation.id };
  writeFileSync(
    join(dir, 'server.cjs'),
    `const http=require('node:http');const s=http.createServer((q,r)=>r.end('<title>Project preview</title><h1>Preview is running</h1>'));s.listen(0,'127.0.0.1',()=>console.log('Local: http://localhost:'+s.address().port+'/'));`,
  );
  const session = await api.processes.run(
    owner,
    dir,
    { command: 'node server.cjs', background: true, yieldMs: 500 },
    new AbortController().signal,
  );
  const activity: ChatActivity[] = [
    {
      id: randomUUID(),
      tool: 'terminal',
      action: 'run',
      status: 'complete',
      path: 'node server.cjs',
      summary: '',
      processSessionId: session.id,
    },
    {
      id: randomUUID(),
      tool: 'bots',
      action: 'send_message',
      status: 'complete',
      path: 'Nova',
      summary: 'Done',
      delegation: {
        botId: 'nova',
        botName: 'Nova',
        conversationId: pair.id,
        requestId: randomUUID(),
      },
    },
    {
      id: randomUUID(),
      tool: 'bots',
      action: 'create',
      status: 'complete',
      path: 'Atlas',
      summary: 'Created Atlas',
      createdBotId: 'atlas',
    },
  ];
  const addMessage = (
    id: string,
    conversationId: string,
    role: string,
    content: string,
    botId: string | null,
    activities: ChatActivity[] = [],
  ) =>
    api.store.run(
      'INSERT INTO messages(id,bot_id,request_id,role,content,status,created_at,conversation_id,activity_json) VALUES(?,?,?,?,?,?,?,?,?)',
      id,
      botId,
      randomUUID(),
      role,
      content,
      'complete',
      new Date().toISOString(),
      conversationId,
      JSON.stringify(activities),
    );
  const telegramMessageId = randomUUID();
  addMessage(
    telegramMessageId,
    conversation.id,
    'user',
    'Build a project preview and ask Nova to review it.',
    null,
  );
  api.store.run("UPDATE messages SET source='telegram' WHERE id=?", telegramMessageId);
  const messageId = randomUUID();
  const png = await sharp({
    create: { width: 320, height: 240, channels: 3, background: '#0088cc' },
  })
    .png()
    .toBuffer();
  writeFileSync(join(dir, 'render.png'), png);
  const screenshotId = randomUUID();
  const screenshotFolder = join(dir, '.mukai', 'artifacts', 'screenshots');
  mkdirSync(screenshotFolder, { recursive: true });
  const screenshotPath = join(screenshotFolder, screenshotId + '.png');
  writeFileSync(screenshotPath, png);
  activity.push(
    {
      id: randomUUID(),
      tool: 'image',
      action: 'view',
      status: 'complete',
      path: join(dir, 'render.png'),
      summary: '{}',
    },
    {
      id: randomUUID(),
      tool: 'computer_use',
      action: 'screenshot',
      status: 'complete',
      path: '',
      summary: JSON.stringify({ artifactId: screenshotId }),
    },
  );
  addMessage(
    messageId,
    conversation.id,
    'assistant',
    'The project preview is ready. Nova reviewed the layout, and Atlas is available to help with the next step.',
    'scout',
    activity,
  );
  addMessage(
    randomUUID(),
    conversation.id,
    'user',
    'Thanks, keep that handy for the next turn.',
    null,
  );
  addMessage(randomUUID(), conversation.id, 'assistant', 'Ready whenever you are.', 'scout');
  addMessage(
    randomUUID(),
    pair.id,
    'assistant',
    'Nova review complete. The preview looks good.',
    'nova',
  );
  addMessage(randomUUID(), atlasChat.id, 'assistant', 'Atlas existing conversation.', 'atlas');
  const sharedMessage = randomUUID();
  addMessage(sharedMessage, space.id, 'assistant', 'Shared project update.', 'scout', [
    activity[1],
  ]);
  writeFileSync(join(dir, 'project-notes.md'), '# Project notes\nThe preview is ready.');
  new ArtifactRepository(api.store).save({
    id: randomUUID(),
    botId: 'scout',
    messageId,
    path: 'project-notes.md',
    name: 'project-notes.md',
    createdAt: new Date().toISOString(),
  });
  new ArtifactRepository(api.store).save({
    id: screenshotId,
    botId: 'scout',
    messageId,
    kind: 'image',
    name: screenshotId + '.png',
    path: screenshotPath,
    createdAt: new Date().toISOString(),
  });
  const changes = new FileChangeRepository(api.store);
  changes.record('scout', messageId, {
    path: 'src/Project.tsx',
    before: 'export const title = "Hello";\n',
    after: 'export const title = "Project preview";\nexport const ready = true;\n',
  });
  changes.record('scout', sharedMessage, {
    path: 'README.md',
    before: null,
    after: '# Shared project\n',
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
  host.attach(window);
  ipcMain.handle(IPC.apiConnection, () => ({ url: api.url, token: api.token }));
  ipcMain.handle(IPC.health, () => ({ status: 'ok' }));
  ipcMain.handle(IPC.browserBounds, (_event, bounds: BrowserBounds | null) => host.bounds(bounds));
  const evaluate = async <T>(code: string): Promise<T> => {
    try {
      return await window.webContents.executeJavaScript(code);
    } catch (error) {
      console.error('Renderer expression failed:', code);
      throw error;
    }
  };
  const wait = async (code: string) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await evaluate<boolean>(code)) return;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(
      'Activity UI did not settle: ' + code + '\n' + (await evaluate('document.body.innerText')),
    );
  };
  const click = (selector: string) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const capture = async (name: string) => {
    await evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    mkdirSync(join(process.cwd(), 'artifacts'), { recursive: true });
    writeFileSync(
      join(process.cwd(), 'artifacts', name + '.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
  };
  const errors: string[] = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  try {
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await evaluate(
      `localStorage.setItem('mukai.active-conversation.scout',${JSON.stringify(conversation.id)});`,
    );
    await window.reload();
    await wait('document.querySelectorAll(".chat-activity-row").length===6');
    assert.equal(await evaluate('document.querySelectorAll(".message-telegram-source").length'), 1);
    assert(
      await evaluate(
        `document.querySelector('.message-telegram-source').closest('.ai-message').textContent.includes('Build a project preview')`,
      ),
    );
    assert.equal(
      await evaluate(
        'document.querySelector(".message-telegram-source").getAttribute("aria-label")',
      ),
      'Sent from Telegram',
    );
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".ai-message--assistant .message-telegram-source").length',
      ),
      0,
    );
    assert(
      await evaluate(
        `getComputedStyle(document.querySelector('.conversation')).backgroundColor===getComputedStyle(document.querySelector('.chat-activity-drawer')).backgroundColor`,
      ),
    );
    assert(
      await evaluate(
        `document.querySelector('.conversation').getBoundingClientRect().right<=document.querySelector('.chat-activity-drawer').getBoundingClientRect().left+1`,
      ),
    );
    assert.deepEqual(
      await evaluate(
        `Array.from(document.querySelectorAll('.chat-activity-section')).map(section=>section.getAttribute('aria-label'))`,
      ),
      ['Bots', 'Links', 'Outputs', 'Changes'],
    );
    await capture('chat-activity-light');
    // Both image actions use the shared modal rather than a JSON disclosure.
    await click('.response-work > summary');
    await click('.response-tool-group > summary');
    for (let index = 0; index < 2; index++) {
      await evaluate(`document.querySelectorAll('.response-tool-image')[${index}].click()`);
      await wait('Boolean(document.querySelector("dialog .artifact-image-preview")?.naturalWidth)');
      assert.equal(
        await evaluate('document.querySelector("dialog .artifact-image-preview").naturalWidth'),
        320,
      );
      assert(await evaluate('document.querySelector("dialog").open'));
      assert(await evaluate('document.querySelector("dialog").getBoundingClientRect().width > 0'));
      if (!index) await capture('chat-activity-image');
      await click('dialog button[aria-label="Close dialog"]');
    }
    await click('.chat-activity-section[aria-label="Changes"] button');
    await wait('Boolean(document.querySelector(".diff-file"))');
    assert(
      await evaluate(
        'document.querySelector(".diff-file").textContent.includes("Project preview")',
      ),
    );
    await click('.diff-drawer button[aria-label="Close dialog"]');
    await click('button[aria-label="Preview project-notes.md"]');
    await wait('Boolean(document.querySelector(".artifact-preview pre"))');
    assert(
      await evaluate(
        'document.querySelector(".artifact-preview pre").textContent.includes("The preview is ready")',
      ),
    );
    await click('dialog button[aria-label="Close dialog"]');
    await click('.chat-activity-section[aria-label="Bots"] button');
    await wait('document.body.textContent.includes("Nova review complete")');
    await click('button[aria-label="Go back"]');
    await wait('document.querySelectorAll(".chat-activity-row").length===6');
    await click('.chat-activity-section[aria-label="Bots"] button:last-child');
    await wait('document.body.textContent.includes("Atlas existing conversation")');
    assert.equal(
      conversations.privateChats('default').filter((chat) => chat.ownerBotId === 'atlas').length,
      1,
    );
    assert.equal(
      await evaluate(`document.querySelector('button[aria-label="Show chat activity"]')`),
      null,
    );
    await click('button[aria-label="Go back"]');
    await wait('Boolean(document.querySelector(".chat-activity-drawer a"))');
    await click('.chat-activity-drawer a');
    await wait(
      'Boolean(document.querySelector("#browser-panel")?.textContent.includes("Project preview"))',
    );
    assert.equal(api.browsers.list('default')[0]?.title, 'Project preview');
    await click('#browser-panel button[aria-label="Close browser tab"]');
    await wait('!document.querySelector("#browser-panel")');
    await click('button[aria-label="Close chat activity"]');
    await window.reload();
    await wait(`Boolean(document.querySelector('button[aria-label="Show chat activity"]'))`);
    assert.equal(await evaluate('document.querySelector(".chat-activity-drawer")'), null);
    await click('button[aria-label="Show chat activity"]');
    await wait('document.querySelectorAll(".chat-activity-row").length===6');
    const appearance = await fetch(api.url + '/settings/appearance', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'dark', theme: 'mukai' }),
    });
    assert(appearance.ok, await appearance.clone().text());
    await window.reload();
    await wait(
      'document.querySelectorAll(".chat-activity-row").length===6 && document.documentElement.dataset.mode==="dark"',
    );
    await capture('chat-activity-dark');
    window.setSize(740, 880);
    await wait('document.querySelector(".workspace-navigation").getBoundingClientRect().width<=77');
    await wait('getComputedStyle(document.querySelector(".conversation")).display!=="none"');
    assert(
      await evaluate(
        `document.querySelector('.conversation').getBoundingClientRect().height > document.querySelector('.conversation-layout').getBoundingClientRect().height * .65`,
      ),
    );
    assert(
      await evaluate(
        `document.querySelector('.conversation').getBoundingClientRect().bottom <= document.querySelector('.chat-activity-drawer').getBoundingClientRect().top + 1`,
      ),
    );
    await capture('chat-activity-narrow');
    assert(
      await evaluate(
        `document.querySelector('.chat-activity-drawer').scrollWidth<=document.querySelector('.chat-activity-drawer').clientWidth+1`,
      ),
    );
    await click('button[aria-label="Close chat activity"]');
    await wait('getComputedStyle(document.querySelector(".conversation")).display!=="none"');
    window.setSize(1480, 980);
    await evaluate(
      `Array.from(document.querySelectorAll('.rail-link')).find(b=>b.textContent.trim()==='Spaces').click()`,
    );
    await wait('document.querySelectorAll(".chat-activity-row").length===2');
    assert(await evaluate('document.body.textContent.includes("Shared project update")'));
    await capture('chat-activity-space');
    await click('.chat-activity-section[aria-label="Bots"] button');
    await wait('document.body.textContent.includes("Nova review complete")');
    // Return to the private chat and keep the final provider response open while
    // a real file tool completes. No page reload is involved in these updates.
    await click('button[aria-label="Go back"]');
    await evaluate(
      `Array.from(document.querySelectorAll('.rail-link')).find(b=>b.textContent.trim()==='Bots').click()`,
    );
    await wait(`Boolean(document.querySelector('button[aria-label="Show chat activity"]'))`);
    await click('button[aria-label="Show chat activity"]');
    await wait('document.querySelectorAll(".chat-activity-row").length===6');
    await click('button[aria-label="Close chat activity"]');
    let finalResponse: ServerResponse | undefined;
    const fixture = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (
        body.messages.some(
          (message: { tool_call_id?: string }) => message.tool_call_id === 'live-write',
        )
      ) {
        finalResponse = response;
        return;
      }
      response.write(
        'data: ' +
          JSON.stringify({
            id: 'live',
            model: 'fixture',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'live-write',
                      type: 'function',
                      function: {
                        name: 'file_operations',
                        arguments: JSON.stringify({
                          action: 'write_file',
                          path: 'live-draft.md',
                          content: '# Live draft',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }) +
          '\n\n',
      );
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
    try {
      const headers = { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' };
      const provider = await fetch(api.url + '/providers', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Live activity fixture',
          kind: 'compatible',
          baseUrl: `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`,
          defaultModel: 'fixture',
          models: [
            {
              id: 'fixture',
              name: 'Fixture',
              contextWindowTokens: 32768,
              maxOutputTokens: 4096,
              supportsImages: false,
            },
          ],
          supportsImages: false,
          isDefault: true,
        }),
      });
      assert.equal(provider.status, 201);
      assert(
        (
          await fetch(api.url + '/approvals', {
            method: 'PUT',
            headers,
            body: JSON.stringify({ mode: 'full-access' }),
          })
        ).ok,
      );
      // Refresh the configured provider, then let the renderer send the live turn.
      await window.reload();
      await wait(`Boolean(document.querySelector('button[aria-label="Send message"]'))`);
      await evaluate(
        `(() => { const input = document.querySelector('.ai-composer-area .composer > textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Create a live draft.'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await click('button[aria-label="Send message"]');
      await wait('Boolean(document.querySelector(".chat-activity-drawer"))');
      await wait(`Boolean(document.querySelector('button[aria-label="Preview live-draft.md"]'))`);
      await wait(
        `document.querySelector('.chat-activity-section[aria-label="Changes"]').textContent.includes('live-draft.md')`,
      );
      assert(
        await evaluate(`Boolean(document.querySelector('button[aria-label="Stop generation"]'))`),
      );
      await capture('chat-activity-live');
      await click('button[aria-label="Close chat activity"]');
      await new Promise((done) => setTimeout(done, 150));
      assert.equal(await evaluate('document.querySelector(".chat-activity-drawer")'), null);
      for (let attempt = 0; !finalResponse && attempt < 100; attempt++)
        await new Promise((done) => setTimeout(done, 50));
      assert(finalResponse);
      finalResponse.end(
        'data: ' +
          JSON.stringify({
            id: 'live',
            model: 'fixture',
            choices: [
              { index: 0, delta: { content: 'The live draft is ready.' }, finish_reason: 'stop' },
            ],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
      await wait(`!document.querySelector('button[aria-label="Stop generation"]')`);
      assert.equal(await evaluate('document.querySelector(".chat-activity-drawer")'), null);
    } finally {
      fixture.closeAllConnections();
      await new Promise<void>((done) => fixture.close(() => done()));
    }
    assert.deepEqual(errors, []);
    console.log(
      'Chat activity: outputs open real preview, diffs, artifact previews, bot navigation, spaces, persistence, themes and narrow layout passed.',
    );
  } finally {
    await api.shutdown();
    window.destroy();
    api.server.closeAllConnections();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    api.dispose();
    app.quit();
  }
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
