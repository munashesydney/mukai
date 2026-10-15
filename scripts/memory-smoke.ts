import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startApiServer } from '../src/server/app';
import { seedTestBot } from '../src/server/testFixtures';
import { IPC } from '../src/shared/contracts';
import { BgeEmbedder } from '../mukai_memory/src';

async function main() {
  const dir = process.env.MUKAI_MEMORY_SMOKE_DIR;
  if (!dir) throw new Error('Disposable memory smoke directory required.');
  app.setPath('userData', dir);
  await app.whenReady();
  const api = await startApiServer(0, {
    dataDir: join(dir, 'api'),
    memoryExtractor: async () => ({ facts: [] }),
    memoryReviewIdleMs: 0,
  });
  seedTestBot(api.store);
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
  ipcMain.handle(IPC.apiConnection, () => ({ url: api.url, token: api.token }));
  ipcMain.handle(IPC.health, () => ({ status: 'ok' }));
  ipcMain.handle(IPC.browserBounds, () => {});
  const evaluate = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const wait = async (code: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate<boolean>(code)) return;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error('Memory UI did not settle: ' + code);
  };
  const errors: string[] = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  try {
    api.memory.import('default', [
      {
        subject: 'Mukai',
        relation: 'uses_database',
        object: 'SQLite',
        text: 'Mukai stores workspace data in SQLite.',
        validFrom: '2026-01-01T00:00:00Z',
        validTo: null,
        state: 'confirmed',
      },
      {
        subject: 'Alex',
        relation: 'works_on',
        object: 'Mukai',
        text: 'Alex works on Mukai.',
        validFrom: '2026-01-01T00:00:00Z',
        validTo: null,
        state: 'confirmed',
      },
      {
        subject: 'User',
        relation: 'prefers_coffee',
        object: 'Espresso',
        text: 'User prefers espresso in the morning.',
        validFrom: '2026-01-01T00:00:00Z',
        validTo: null,
        state: 'confirmed',
      },
    ]);
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await wait('Boolean(document.querySelector(".header-actions"))');
    await evaluate(`document.querySelector('button[aria-label="Open settings"]').click()`);
    await wait('Boolean(document.querySelector("#settings-tab-memory"))');
    await evaluate(`document.querySelector('#settings-tab-memory').click()`);
    await wait('Boolean(document.querySelector(".memory-graph-node"))');
    assert.equal(
      await evaluate<number>('document.querySelectorAll(".memory-graph-edge").length'),
      3,
    );
    await evaluate(
      `document.querySelector('.memory-graph-edge').dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
    );
    await wait('Boolean(document.querySelector(".memory-detail"))');
    assert(
      (await evaluate<string>('document.querySelector(".memory-detail").textContent')).includes(
        'Source evidence',
      ),
    );
    await evaluate(
      `Array.from(document.querySelectorAll('[role=tab]')).find(tab=>tab.textContent.includes('Memories')).click()`,
    );
    await wait('document.querySelectorAll(".memory-fact").length===3');
    await evaluate(`document.querySelector('#memory-tab-preferences').click()`);
    await wait('Boolean(document.querySelector(".memory-preferences"))');
    const capture = async (name: string) => {
      await evaluate(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      );
      mkdirSync(join(process.cwd(), 'artifacts'), { recursive: true });
      writeFileSync(
        join(process.cwd(), 'artifacts', name),
        (await window.webContents.capturePage()).toPNG(),
      );
    };
    assert.equal(await evaluate('document.querySelector(".memory-panel h3 svg")'), null);
    await evaluate(`document.querySelector('#memory-tab-graph').click()`);
    await wait('document.querySelectorAll(".memory-graph-edge").length===3');
    await evaluate(
      `document.querySelector('input[role="switch"][aria-label="Enable workspace memory"]').click()`,
    );
    await wait(
      'Boolean(document.querySelector(".memory-off-notice")) && !document.querySelector("input[role=switch]").disabled',
    );
    assert.equal(api.memory.settings('default').enabled, false);
    assert.equal(api.memory.snapshot('default').facts.length, 3);
    await capture('memory-toggle-off.png');
    await evaluate(`document.querySelector('input[role="switch"]').focus()`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await wait(
      'document.querySelector("input[role=switch]").checked && !document.querySelector("input[role=switch]").disabled',
    );
    assert.equal(api.memory.settings('default').enabled, true);
    await capture('memory-toggle-on.png');
    await evaluate(`document.querySelector('#memory-tab-preferences').click()`);
    await capture('memory-preferences.png');
    const before = api.memory.settings('default').automaticRecall;
    await evaluate(
      `document.querySelectorAll('.memory-preferences input[type=checkbox]')[1].click()`,
    );
    await wait('Boolean(document.querySelector(".ai-notice"))');
    assert.equal(api.memory.settings('default').automaticRecall, !before);
    await evaluate(
      `Array.from(document.querySelectorAll('[role=tab]')).find(tab=>tab.textContent==='Graph').click()`,
    );
    await wait('document.querySelectorAll(".memory-graph-edge").length===3');
    await evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    const path = join(process.cwd(), 'artifacts', 'memory-smoke.png');
    mkdirSync(join(process.cwd(), 'artifacts'), { recursive: true });
    writeFileSync(path, (await window.webContents.capturePage()).toPNG());
    await evaluate(
      `document.querySelector('#memory-tab-graph').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}))`,
    );
    await wait('document.querySelectorAll(".memory-fact").length===3');
    assert.equal(await evaluate('document.activeElement.id'), 'memory-tab-list');
    await evaluate(`document.querySelector('#memory-tab-activity').click()`);
    await wait('Boolean(document.querySelector(".memory-processing"))');
    assert(
      await evaluate(
        'document.querySelector(".memory-recalls").textContent.includes("Recall records")',
      ),
    );
    await capture('memory-activity.png');
    api.store.run(
      "INSERT INTO conversations(id,workspace_id,kind,name,description,owner_bot_id,created_at,updated_at) VALUES('memory-smoke-review','default','private','Project review','','scout','now','now')",
    );
    api.store.run(
      "INSERT INTO conversation_bots(conversation_id,bot_id) VALUES('memory-smoke-review','scout')",
    );
    api.store.run(
      "INSERT INTO messages(id,conversation_id,request_id,role,content,status,created_at) VALUES('memory-smoke-message','memory-smoke-review','memory-smoke-request','user','Hello','complete','2026-10-04T00:00:00Z')",
    );
    api.memory.reviews.schedule('default', 'memory-smoke-review', 'scout');
    await api.memory.reviews.drain(new AbortController().signal);
    await evaluate(`document.querySelector('#memory-tab-runs').click()`);
    await wait('Boolean(document.querySelector(".pursuit-run-row"))');
    await capture('memory-runs.png');
    await evaluate(`document.querySelector('.pursuit-run-row').click()`);
    await wait('Boolean(document.querySelector(".memory-run-detail"))');
    assert(
      await evaluate(
        'document.querySelector(".memory-run-summary").textContent.includes("No durable information")',
      ),
    );
    assert(
      await evaluate(
        'document.querySelector(".memory-run-operations").textContent.includes("memory · search")',
      ),
    );
    await capture('memory-run-detail.png');
    await evaluate(`document.querySelector('#settings-tab-appearance').click()`);
    await wait('Boolean(document.querySelector("input[name=color-mode][value=dark]"))');
    await evaluate(`document.querySelector('input[name=color-mode][value=dark]').click()`);
    await evaluate(`document.querySelector('#settings-tab-memory').click()`);
    await wait('document.querySelectorAll(".memory-graph-edge").length===3');
    await capture('memory-dark.png');
    window.setSize(900, 900);
    await capture('memory-narrow.png');
    assert(
      await evaluate(
        `document.querySelector('.memory-panel').scrollWidth <= document.querySelector('.memory-panel').clientWidth + 1`,
      ),
    );
    await evaluate(`document.querySelector('#memory-tab-preferences').click()`);
    await wait('Boolean(document.querySelector(".memory-preferences"))');
    await capture('memory-preferences-narrow.png');
    assert(
      await evaluate(
        `document.querySelector('.memory-panel').scrollWidth <= document.querySelector('.memory-panel').clientWidth + 1`,
      ),
    );
    await evaluate(`document.querySelector('#memory-tab-runs').click()`);
    await wait('Boolean(document.querySelector(".pursuit-run-row"))');
    await capture('memory-runs-dark-narrow.png');
    await evaluate(`document.querySelector('.pursuit-run-row').click()`);
    await wait('Boolean(document.querySelector(".memory-run-detail"))');
    await evaluate(`document.querySelector('.memory-run-operations details').open = true`);
    await capture('memory-run-detail-dark-narrow.png');
    assert(
      await evaluate(
        'document.querySelector(".memory-panel").scrollWidth <= document.querySelector(".memory-panel").clientWidth + 1',
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      'Memory graph, inspector, list, controls, and renderer passed. Screenshot: ' + path,
    );
    if (process.env.MUKAI_MEMORY_UI_ONLY === '1') return;
    // Verify the native runtime under Electron, using the same cached model as Node.
    const embeddings = new BgeEmbedder(join(process.cwd(), 'artifacts', 'memory-models'));
    try {
      await embeddings.initialize(false);
      assert.equal((await embeddings.embed(['Electron CPU inference'], 'document'))[0].length, 384);
      console.log('Electron CPU embedding worker passed.');
    } finally {
      await embeddings.dispose();
    }
  } finally {
    window.destroy();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    app.quit();
  }
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
