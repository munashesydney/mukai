import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startApiServer } from '../src/server/app';
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
    assert.deepEqual(errors, []);
    console.log(
      'Memory graph, inspector, list, controls, and renderer passed. Screenshot: ' + path,
    );
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
