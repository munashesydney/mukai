import { app, BrowserWindow, ipcMain } from 'electron';
import { createServer, type ServerResponse } from 'node:http';
import sharp from 'sharp';
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
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
  const imageRequests: string[] = [];
  const originalReference = api.conversationArtifacts.reference.bind(api.conversationArtifacts);
  api.conversationArtifacts.reference = (...args) => {
    if (args[2]) imageRequests.push(args[1]);
    return originalReference(...args);
  };
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
  const upload = await fetch(api.url + `/conversations/${conversation.id}/attachments`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + api.token, 'X-Filename': 'render.png' },
    body: new Uint8Array(png),
  });
  assert.equal(upload.status, 201);
  const attachment = (await upload.json()) as { id: string };
  api.store.run('UPDATE attachments SET message_id=? WHERE id=?', telegramMessageId, attachment.id);
  const screenshotId = randomUUID();
  const screenshotFolder = join(dir, '.mukai', 'artifacts', 'screenshots');
  mkdirSync(screenshotFolder, { recursive: true });
  const screenshotPath = join(screenshotFolder, screenshotId + '.png');
  writeFileSync(screenshotPath, png);
  activity.push(
    {
      id: randomUUID(),
      tool: 'media',
      action: 'view_image',
      status: 'complete',
      path: 'render.png',
      attachmentId: attachment.id,
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
  const richMessageId = randomUUID();
  addMessage(richMessageId, conversation.id, 'assistant', 'Ready whenever you are.', 'scout');
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
  const notesArtifact = new ArtifactRepository(api.store).save({
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
  const copiedPng = await sharp(randomBytes(600 * 600 * 3), {
    raw: { width: 600, height: 600, channels: 3 },
  })
    .png()
    .toBuffer();
  assert(copiedPng.length > 256 * 1024);
  for (const [name, metadata] of [
    ['copied-image.png', { mediaType: 'image/png', size: copiedPng.length }],
    ['legacy-copy.png', {}],
  ] as const) {
    writeFileSync(join(dir, name), copiedPng);
    new ArtifactRepository(api.store).save({
      id: randomUUID(),
      botId: 'scout',
      messageId,
      path: name,
      name,
      createdAt: new Date().toISOString(),
      ...metadata,
    });
  }
  const chart = {
    version: 1,
    type: 'bar',
    title: 'Example revenue',
    xKey: 'month',
    series: [{ key: 'revenue', label: 'Revenue' }],
    data: [
      { month: 'Jan', revenue: 9 },
      { month: 'Feb', revenue: -2 },
      { month: 'Mar', revenue: 14 },
    ],
  };
  writeFileSync(
    join(dir, 'chart.json'),
    JSON.stringify({ ...chart, type: 'line', title: 'Saved revenue' }),
  );
  api.store.run(
    'UPDATE messages SET content=? WHERE id=?',
    [
      'Ready whenever you are. The following charts use illustrative data.',
      `[Saved notes](mukai://artifact/${notesArtifact.id}#L2) · [Relative notes](project-notes.md#L2)`,
      `![Uploaded preview](mukai://attachment/${attachment.id})`,
      '![Workspace preview](copied-image.png)',
      `[Upload again](mukai://attachment/${attachment.id}) · [Workspace again](./copied-image.png)`,
      '```mukai-chart\n' + JSON.stringify(chart) + '\n```',
      '```mukai-chart\n' +
        JSON.stringify({ ...chart, type: 'line', title: 'Revenue trend' }) +
        '\n```',
      '```mukai-chart\n{"version":1,"source":"chart.json"}\n```',
    ].join('\n\n'),
    richMessageId,
  );
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
  ipcMain.handle(IPC.updateState, () => ({
    status: 'disabled',
    currentVersion: app.getVersion(),
    automaticUpdates: false,
  }));
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
  const click = async (selector: string) => {
    await wait(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const checkChartTooltip = async (chartIndex: number, x: number, y: number) => {
    const pointer = await evaluate<{ x: number; y: number }>(`(() => {
      const svg=document.querySelectorAll('.response-chart-plot > svg')[${chartIndex}];
      svg.scrollIntoView({block:'center'});
      const point=new DOMPoint(${x},${y}).matrixTransform(svg.getScreenCTM());
      svg.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:point.x,clientY:point.y}));
      return {x:point.x,y:point.y};
    })()`);
    await wait(
      `Boolean(document.querySelectorAll('.response-chart')[${chartIndex}].querySelector('[role="tooltip"]'))`,
    );
    const bounds = await evaluate<{
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      plotLeft: number;
      plotRight: number;
      plotTop: number;
      plotBottom: number;
    }>(`(() => {
      const plot=document.querySelectorAll('.response-chart-plot')[${chartIndex}];
      const card=plot.querySelector('[role="tooltip"]').getBoundingClientRect(),bounds=plot.getBoundingClientRect();
      return {left:card.left,top:card.top,right:card.right,bottom:card.bottom,width:card.width,plotLeft:bounds.left,plotRight:bounds.right,plotTop:bounds.top,plotBottom:bounds.bottom};
    })()`);
    assert(bounds.width <= 181, 'Chart tooltip should be compact');
    assert(
      bounds.left >= bounds.plotLeft && bounds.right <= bounds.plotRight + 1,
      'Tooltip must stay inside chart horizontally',
    );
    assert(
      bounds.top >= bounds.plotTop && bounds.bottom <= bounds.plotBottom + 1,
      'Tooltip must stay inside chart vertically',
    );
    assert(
      pointer.x <= bounds.left - 10 ||
        pointer.x >= bounds.right + 10 ||
        pointer.y <= bounds.top - 10 ||
        pointer.y >= bounds.bottom + 10,
      'Tooltip must leave a gap around the pointer',
    );
    return bounds;
  };
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
    await wait('document.querySelectorAll(".chat-activity-row").length===8');
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
    await wait('document.querySelectorAll(".response-chart").length===3');
    assert(
      await evaluate(
        'document.querySelector(".response-chart-heading button svg").getBoundingClientRect().width<=18',
      ),
    );
    const linkPoint = await evaluate<{ x: number; y: number }>(`(() => {
      const link=Array.from(document.querySelectorAll('.response-file-link')).find(b=>b.textContent.includes('Saved notes'));
      link.scrollIntoView({block:'center'});
      const bounds=link.getBoundingClientRect();
      return {x:Math.round(bounds.left+bounds.width/2),y:Math.round(bounds.top+bounds.height/2)};
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...linkPoint });
    await wait(`(() => {
      const link=Array.from(document.querySelectorAll('.response-file-link')).find(b=>b.textContent.includes('Saved notes'));
      return link.matches(':hover') && getComputedStyle(link).textDecorationColor===getComputedStyle(link).color;
    })()`);
    await evaluate(
      `Array.from(document.querySelectorAll('.response-file-link')).find(b=>b.textContent.includes('Saved notes')).click()`,
    );
    await wait(
      `document.querySelector('dialog .reference-selected-line')?.textContent.includes('The preview is ready')`,
    );
    await click('dialog button[aria-label="Close dialog"]');
    await evaluate(
      `Array.from(document.querySelectorAll('.response-file-link')).find(b=>b.textContent.includes('Relative notes')).click()`,
    );
    await wait('Boolean(document.querySelector("dialog .artifact-preview pre"))');
    await click('dialog button[aria-label="Close dialog"]');
    const galleryHeight = await evaluate<number>(
      `document.querySelector('.response-image-gallery').getBoundingClientRect().height`,
    );
    for (const [alt, width] of [
      ['Uploaded preview', 320],
      ['Workspace preview', 600],
    ] as const) {
      await evaluate(
        `Array.from(document.querySelectorAll('.response-gallery-link')).find(link=>link.textContent.includes('${alt}')).scrollIntoView({block:'center',behavior:'instant'})`,
      );
      await evaluate(
        `Array.from(document.querySelectorAll('.response-gallery-link')).find(link=>link.textContent.includes('${alt}')).click()`,
      );
      await wait(`Boolean(document.querySelector('.response-image-gallery[data-highlighted]'))`);
      assert.equal(await evaluate('document.querySelector("dialog")'), null);
      assert.equal(
        await evaluate('document.querySelectorAll(".response-gallery-slide").length'),
        2,
      );
      await wait(
        `document.querySelector('.response-gallery-slide[data-position="active"] .response-image-button')?.getAttribute('aria-label')==='Preview ${alt}'`,
      );
      await wait(
        `(() => {const gallery=document.querySelector('.response-image-gallery').getBoundingClientRect(),feed=document.querySelector('.ai-message-feed').getBoundingClientRect();return gallery.top>=feed.top-1 && gallery.bottom<=feed.bottom+1;})()`,
      );
      await wait(
        `document.querySelector('.response-image-button img[alt="${alt}"]')?.naturalWidth===${width}`,
      );
      assert(
        await evaluate(
          `Math.abs(document.querySelector('.response-image-gallery').getBoundingClientRect().height-${galleryHeight})<=1`,
        ),
        'Carousel height should stay stable between images',
      );
      await click(`.response-image-button[aria-label="Preview ${alt}"]`);
      await wait(
        `document.querySelector('dialog .artifact-image-preview')?.naturalWidth===${width}`,
      );
      if (alt === 'Uploaded preview') {
        assert(
          await evaluate(
            'document.querySelector("dialog").classList.contains("artifact-lightbox")',
          ),
        );
        await click('dialog button[aria-label="Zoom in"]');
        await wait('document.querySelector(".artifact-lightbox-zoom-value").textContent==="125%"');
        await click('dialog button[aria-label="Reset zoom"]');
        await wait('document.querySelector(".artifact-lightbox-zoom-value").textContent==="100%"');
        await click('dialog button[aria-label="Next artifact"]');
        await wait('document.querySelector("dialog .artifact-image-preview")?.naturalWidth===600');
        await wait(
          'document.querySelector(".artifact-lightbox-heading > span").textContent==="2 / 2"',
        );
        await capture('artifact-lightbox-desktop');
        await click('dialog button[aria-label="Previous artifact"]');
        await wait('document.querySelector("dialog .artifact-image-preview")?.naturalWidth===320');
        assert(
          await evaluate(
            `document.querySelector('dialog button[aria-label="Previous artifact"]').disabled`,
          ),
        );
      }
      await click('dialog button[aria-label="Close dialog"]');
    }
    // Repeated references target the same slide; carousel controls and keyboard agree.
    await evaluate(
      `Array.from(document.querySelectorAll('.response-gallery-link')).find(link=>link.textContent.includes('Upload again')).click()`,
    );
    await wait(
      `document.querySelector('.response-gallery-controls [role="status"]').textContent==='1 / 2'`,
    );
    assert(
      await evaluate(`document.querySelector('button[aria-label="Previous image"]').disabled`),
    );
    // Carousel navigation changes pictures without initiating another chat scroll.
    await wait(
      `(() => {const gallery=document.querySelector('.response-image-gallery').getBoundingClientRect(),feed=document.querySelector('.ai-message-feed').getBoundingClientRect();return gallery.top>=feed.top-1 && gallery.bottom<=feed.bottom+1;})()`,
    );
    await evaluate(`new Promise(resolve => {
      const feed=document.querySelector('.ai-message-feed');
      let previous=feed.scrollTop,stable=0;
      function frame() {
        const current=feed.scrollTop;
        stable=current===previous?stable+1:0;
        previous=current;
        if(stable>=4) resolve(); else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    })`);
    const navigationScroll = await evaluate<number>(
      `document.querySelector('.ai-message-feed').scrollTop`,
    );
    await click('button[aria-label="Next image"]');
    await wait(
      `document.querySelector('.response-gallery-controls [role="status"]').textContent==='2 / 2'`,
    );
    assert(await evaluate(`document.querySelector('button[aria-label="Next image"]').disabled`));
    assert.equal(
      await evaluate(`document.querySelector('.ai-message-feed').scrollTop`),
      navigationScroll,
    );
    await click('.response-gallery-slide[data-position="previous"] button');
    await wait(
      `document.querySelector('.response-gallery-controls [role="status"]').textContent==='1 / 2'`,
    );
    await click('.response-gallery-thumbnails button:last-child');
    await wait(
      `document.querySelector('.response-gallery-controls [role="status"]').textContent==='2 / 2'`,
    );
    assert.equal(
      await evaluate('document.querySelector("dialog")'),
      null,
      'Neighbor and thumbnail clicks should select without opening the modal',
    );
    await evaluate(
      `document.querySelector('.response-image-gallery').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`,
    );
    await wait(
      `document.querySelector('.response-gallery-controls [role="status"]').textContent==='1 / 2'`,
    );
    assert.equal(await evaluate('document.querySelector("dialog")'), null);
    assert.equal(await evaluate('document.querySelector(".response-gallery-caption")'), null);
    assert.equal(
      await evaluate('document.querySelectorAll(".response-gallery-thumbnails button").length'),
      2,
    );
    assert(
      await evaluate(
        `document.querySelector('.response-gallery-dots button:first-child').getAttribute('aria-current')==='true'`,
      ),
    );
    assert.equal(
      imageRequests.filter((href) => href === `mukai://attachment/${attachment.id}`).length,
      1,
      'Revisiting an upload should reuse its preview',
    );
    assert.equal(
      imageRequests.filter((href) => href === 'copied-image.png').length,
      1,
      'Revisiting a file should reuse its preview',
    );
    await capture('response-image-gallery');
    await wait('!document.querySelector("dialog")');
    await evaluate(
      `(() => { const point = document.querySelector('.response-chart svg [tabindex]'); point.focus(); point.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); })()`,
    );
    await wait(
      `document.querySelector('.response-chart-tooltip').textContent.includes('Jan · Revenue: 9')`,
    );
    await wait(
      `document.querySelector('.response-chart [role="tooltip"]')?.textContent.includes('Jan')`,
    );
    await evaluate(`(() => {
      const chart=document.querySelector('.response-chart');
      chart.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    })()`);
    await wait(`!document.querySelector('.response-chart [role="tooltip"]')`);
    // Inspect empty plot space as well as marks, including touch and narrow edge placement.
    for (const [row, label, value] of [
      [0, 'Jan', '9'],
      [1, 'Feb', '-2'],
      [2, 'Mar', '14'],
    ] as const) {
      await evaluate(`(() => {
        const svg=document.querySelector('.response-chart-plot > svg');
        const point=new DOMPoint(62+(${row}+.5)/3*560,138).matrixTransform(svg.getScreenCTM());
        svg.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:point.x,clientY:point.y}));
      })()`);
      await wait(
        `document.querySelector('.response-chart [role="tooltip"]')?.textContent.includes('${label}')`,
      );
      assert(
        await evaluate(`(() => {
        const chart=document.querySelector('.response-chart');
        const card=chart.querySelector('[role="tooltip"]');
        const bounds=card.getBoundingClientRect(),plot=chart.querySelector('.response-chart-plot').getBoundingClientRect();
        return card.textContent.includes('${value}') && bounds.left>=plot.left && bounds.right<=plot.right && chart.querySelectorAll('.response-chart-mark.is-active').length===1 && Boolean(chart.querySelector('.response-chart-crosshair'));
      })()`),
      );
    }
    await evaluate(`(() => {
      const svg=document.querySelector('.response-chart-plot > svg');
      svg.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerType:'mouse',relatedTarget:document.body}));
    })()`);
    await wait(`!document.querySelector('.response-chart [role="tooltip"]')`);
    for (const visible of [true, false]) {
      await evaluate(`(() => {
        const svg=document.querySelector('.response-chart-plot > svg');
        const point=new DOMPoint(342,138).matrixTransform(svg.getScreenCTM());
        svg.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'touch',clientX:point.x,clientY:point.y}));
      })()`);
      await wait(`${visible ? '' : '!'}document.querySelector('.response-chart [role="tooltip"]')`);
    }
    const firstPosition = await checkChartTooltip(0, 320, 60);
    const movedPosition = await checkChartTooltip(0, 360, 110);
    assert(
      Math.abs(firstPosition.left - movedPosition.left) > 10 &&
        Math.abs(firstPosition.top - movedPosition.top) > 10,
      'Tooltip should follow the pointer within the same category',
    );
    for (const [x, y] of [
      [63, 19],
      [621, 19],
      [63, 257],
      [621, 257],
    ])
      await checkChartTooltip(0, x, y);
    await checkChartTooltip(1, 342, 138);
    await click('.response-chart details summary');
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".response-chart:first-of-type tbody tr").length || document.querySelector(".response-chart tbody").children.length',
      ),
      3,
    );
    const csvDownload = new Promise<void>((done, reject) => {
      window.webContents.session.once('will-download', (_event, item) => {
        item.setSavePath(join(dir, 'chart-data.csv'));
        item.once('done', (_event, state) =>
          state === 'completed' ? done() : reject(new Error('CSV download failed: ' + state)),
        );
      });
    });
    await click('.response-chart-heading button');
    await csvDownload;
    assert(readFileSync(join(dir, 'chart-data.csv'), 'utf8').includes('"Feb","-2"'));
    await evaluate(`document.querySelector('.response-chart').scrollIntoView({block:'start'})`);
    await evaluate(`(() => {
      const svg=document.querySelector('.response-chart-plot > svg');
      const point=new DOMPoint(342,138).matrixTransform(svg.getScreenCTM());
      svg.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:point.x,clientY:point.y}));
    })()`);
    await wait(
      `document.querySelector('.response-chart [role="tooltip"]')?.textContent.includes('Feb')`,
    );
    await capture('rich-response-charts');
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
    for (const name of ['copied-image.png', 'legacy-copy.png']) {
      await click(`button[aria-label="Preview ${name}"]`);
      await wait('Boolean(document.querySelector("dialog")?.open)');
      await wait('document.querySelector("dialog .artifact-image-preview")?.naturalWidth===600');
      assert.equal(await evaluate('document.querySelector("dialog pre")'), null);
      await capture('chat-activity-' + name.replace('.png', ''));
      await click('dialog button[aria-label="Close dialog"]');
    }
    // A missing file reports its error inside a dismissible modal.
    unlinkSync(join(dir, 'legacy-copy.png'));
    await click('button[aria-label="Preview legacy-copy.png"]');
    await wait('Boolean(document.querySelector("dialog [role=alert]"))');
    assert(
      await evaluate(
        'document.querySelector("dialog [role=alert]").textContent.includes("no longer available")',
      ),
    );
    await click('dialog button[aria-label="Close dialog"]');
    writeFileSync(join(dir, 'legacy-copy.png'), copiedPng);
    // Keep a guest download pending and prove its loading modal can be closed.
    const guest = api.computers.guest;
    let finishDownload: ((value: unknown) => void) | undefined;
    api.computers.guest = () =>
      ({
        request: async () =>
          new Promise((done) => {
            finishDownload = done;
          }),
      }) as unknown as ReturnType<typeof guest>;
    api.store.run("UPDATE workspaces SET computer='qemu' WHERE id='default'");
    try {
      await click('button[aria-label="Preview legacy-copy.png"]');
      await wait('Boolean(document.querySelector("dialog [role=status]"))');
      assert(
        await evaluate(
          'document.querySelector("dialog [role=status]").textContent.includes("Loading file")',
        ),
      );
      for (let attempt = 0; !finishDownload && attempt < 100; attempt++)
        await new Promise((done) => setTimeout(done, 20));
      assert(finishDownload);
      await click('dialog button[aria-label="Close dialog"]');
      assert.equal(await evaluate('document.querySelector("dialog")'), null);
    } finally {
      finishDownload?.({ name: 'legacy-copy.png', bytes: copiedPng.toString('base64') });
      api.computers.guest = guest;
      api.store.run("UPDATE workspaces SET computer='local' WHERE id='default'");
    }
    await click('.chat-activity-section[aria-label="Bots"] button');
    await wait('document.body.textContent.includes("Nova review complete")');
    await click('button[aria-label="Go back"]');
    await wait('document.querySelectorAll(".chat-activity-row").length===8');
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
    await wait('document.querySelectorAll(".chat-activity-row").length===8');
    const appearance = await fetch(api.url + '/settings/appearance', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'dark', theme: 'mukai' }),
    });
    assert(appearance.ok, await appearance.clone().text());
    await window.reload();
    await wait(
      'document.querySelectorAll(".chat-activity-row").length===8 && document.documentElement.dataset.mode==="dark"',
    );
    await capture('chat-activity-dark');
    window.setSize(740, 880);
    await wait('document.querySelector(".workspace-navigation").getBoundingClientRect().width<=77');
    await wait('getComputedStyle(document.querySelector(".conversation")).display!=="none"');
    await wait('!document.querySelector(".chat-activity-drawer")');
    // A saved desktop-open preference must not cover the chat on a narrow reload.
    await window.reload();
    await wait(`Boolean(document.querySelector('button[aria-label="Show chat activity"]'))`);
    assert.equal(await evaluate('document.querySelector(".chat-activity-drawer")'), null);
    await click('button[aria-label="Show chat activity"]');
    await wait('getComputedStyle(document.querySelector(".conversation")).display==="none"');
    assert(
      await evaluate(
        `document.querySelector('.chat-activity-drawer').getBoundingClientRect().height > document.querySelector('.conversation-layout').getBoundingClientRect().height * .95`,
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
    for (const [x, y] of [
      [63, 19],
      [621, 19],
      [63, 257],
      [621, 257],
    ])
      await checkChartTooltip(1, x, y);
    await capture('rich-response-tooltip-narrow');
    await evaluate(
      `Array.from(document.querySelectorAll('.response-gallery-link')).find(link=>link.textContent.includes('Upload again')).click()`,
    );
    await wait(
      `document.querySelector('.response-gallery-controls [role="status"]').textContent==='1 / 2'`,
    );
    await evaluate(
      `document.querySelector('.response-image-gallery').scrollIntoView({block:'center',behavior:'instant'})`,
    );
    await evaluate(`(() => {
      const gallery=document.querySelector('.response-image-gallery');
      const start=new Touch({identifier:1,target:gallery,clientX:350,clientY:400});
      const end=new Touch({identifier:1,target:gallery,clientX:150,clientY:405});
      gallery.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[start]}));
      gallery.dispatchEvent(new TouchEvent('touchend',{bubbles:true,changedTouches:[end]}));
      gallery.querySelector('.response-image-button').click();
    })()`);
    await wait(
      `document.querySelector('.response-gallery-controls [role="status"]').textContent==='2 / 2'`,
    );
    assert.equal(
      await evaluate('document.querySelector("dialog")'),
      null,
      'Swiping must not open the image modal',
    );
    await wait(
      `document.querySelector('.response-gallery-slide[data-position="active"] img')?.naturalWidth===600`,
    );
    assert(
      await evaluate(
        `(() => {const gallery=document.querySelector('.response-image-gallery'),image=gallery.querySelector('.response-gallery-slide[data-position="active"] img').getBoundingClientRect(),stage=gallery.querySelector('.response-gallery-stage').getBoundingClientRect();return gallery.scrollWidth<=gallery.clientWidth+2 && image.width<=gallery.clientWidth && image.top>=stage.top && image.bottom<=stage.bottom && Math.abs((image.left+image.right)/2-(stage.left+stage.right)/2)<1;})()`,
      ),
    );
    await wait(
      `(() => {const gallery=document.querySelector('.response-image-gallery').getBoundingClientRect(),feed=document.querySelector('.ai-message-feed').getBoundingClientRect();return gallery.top>=feed.top-1 && gallery.bottom<=feed.bottom+1;})()`,
    );
    await capture('response-image-gallery-narrow');
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
    await wait('document.querySelectorAll(".chat-activity-row").length===8');
    await click('button[aria-label="Close chat activity"]');
    let finalResponse: ServerResponse | undefined;
    let liveRun = 0;
    const waitForFinalResponse = async () => {
      for (let attempt = 0; !finalResponse && attempt < 100; attempt++)
        await new Promise((done) => setTimeout(done, 50));
      assert(finalResponse);
      return finalResponse;
    };
    const fixture = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (
        body.messages.some(
          (message: { tool_call_id?: string }) => message.tool_call_id === `live-write-${liveRun}`,
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
                      id: `live-write-${liveRun}`,
                      type: 'function',
                      function: {
                        name: 'file_operations',
                        arguments: JSON.stringify({
                          action: 'write_file',
                          path: liveRun ? `live-draft-${liveRun}.md` : 'live-draft.md',
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
              // Exercise activity updates without unrelated context compaction.
              contextWindowTokens: 65536,
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
      const streamedResponse = await waitForFinalResponse();
      streamedResponse.write(
        'data: ' +
          JSON.stringify({
            id: 'live',
            model: 'fixture',
            choices: [
              {
                index: 0,
                delta: { content: '```mukai-chart\n' + JSON.stringify(chart) },
                finish_reason: null,
              },
            ],
          }) +
          '\n\n',
      );
      await wait('document.body.textContent.includes("Reviewing chart…")');
      assert(
        await evaluate('Boolean(document.querySelector(".response-chart-loading .is-spinning"))'),
      );
      assert.equal(await evaluate('document.querySelectorAll(".response-chart").length'), 3);
      // A manual reopen during generation must not override the completion collapse.
      await wait('Array.from(document.querySelectorAll(".response-work")).at(-1)?.open===true');
      await evaluate(
        'Array.from(document.querySelectorAll(".response-work > summary")).at(-1).click()',
      );
      await wait('Array.from(document.querySelectorAll(".response-work")).at(-1)?.open===false');
      await evaluate(
        'Array.from(document.querySelectorAll(".response-work > summary")).at(-1).click()',
      );
      await wait('Array.from(document.querySelectorAll(".response-work")).at(-1)?.open===true');
      streamedResponse.end(
        'data: ' +
          JSON.stringify({
            id: 'live',
            model: 'fixture',
            choices: [
              {
                index: 0,
                delta: { content: '\n```\n\nThe live draft is ready.' },
                finish_reason: 'stop',
              },
            ],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
      await wait(`!document.querySelector('button[aria-label="Stop generation"]')`);
      await wait('document.querySelectorAll(".response-chart").length===4');
      await wait('Array.from(document.querySelectorAll(".response-work")).at(-1)?.open===false');
      await evaluate(
        'Array.from(document.querySelectorAll(".response-work > summary")).at(-1).click()',
      );
      await wait('Array.from(document.querySelectorAll(".response-work")).at(-1)?.open===true');
      assert.equal(await evaluate('document.querySelector(".chat-activity-drawer")'), null);
      // The same live tool run on a small screen must never open activity itself.
      liveRun = 1;
      finalResponse = undefined;
      window.setSize(740, 880);
      await wait('document.querySelector(".conversation-layout").clientWidth<=700');
      await evaluate(
        `(() => { const input = document.querySelector('.ai-composer-area .composer > textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Create another live draft.'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await click('button[aria-label="Send message"]');
      const narrowResponse = await waitForFinalResponse();
      assert(
        await evaluate(`Boolean(document.querySelector('button[aria-label="Stop generation"]'))`),
      );
      assert.equal(await evaluate('document.querySelector(".chat-activity-drawer")'), null);
      assert(
        await evaluate(
          'getComputedStyle(document.querySelector(".conversation")).display!=="none"',
        ),
      );
      await click('button[aria-label="Show chat activity"]');
      await wait('getComputedStyle(document.querySelector(".conversation")).display==="none"');
      await wait(`Boolean(document.querySelector('button[aria-label="Preview live-draft-1.md"]'))`);
      await click('button[aria-label="Close chat activity"]');
      await wait('getComputedStyle(document.querySelector(".conversation")).display!=="none"');
      narrowResponse.end(
        'data: ' +
          JSON.stringify({
            id: 'live',
            model: 'fixture',
            choices: [
              { index: 0, delta: { content: 'The second draft is ready.' }, finish_reason: 'stop' },
            ],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
      await wait(`!document.querySelector('button[aria-label="Stop generation"]')`);
      assert.equal(await evaluate('document.querySelector(".chat-activity-drawer")'), null);
      // Space chats share the same manual full-area activity view.
      await evaluate(
        `Array.from(document.querySelectorAll('.rail-link')).find(b=>b.textContent.trim()==='Spaces').click()`,
      );
      await wait(`Boolean(document.querySelector('button[aria-label="Show chat activity"]'))`);
      assert.equal(await evaluate('document.querySelector(".chat-activity-drawer")'), null);
      await click('button[aria-label="Show chat activity"]');
      await wait('getComputedStyle(document.querySelector(".conversation")).display==="none"');
      await click('button[aria-label="Close chat activity"]');
      await wait('getComputedStyle(document.querySelector(".conversation")).display!=="none"');
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
