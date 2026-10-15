import { ApiError } from '../src/server/config';
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startApiServer } from '../src/server/app';
import { seedTestBot } from '../src/server/testFixtures';
import { IPC } from '../src/shared/contracts';

async function main() {
  const dir = process.env.MUKAI_SKILLS_SMOKE_DIR;
  if (!dir) throw new Error('Disposable smoke directory required.');
  app.setPath('userData', dir);
  await app.whenReady();
  const api = await startApiServer(0, {
    dataDir: join(dir, 'api'),
    memoryExtractor: async () => ({ facts: [] }),
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
    for (let i = 0; i < 100; i++) {
      if (await evaluate<boolean>(code)) return;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error('UI did not settle: ' + code);
  };
  const click = async (label: string) => {
    await wait(
      `Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()===${JSON.stringify(label)} && !button.disabled)`,
    );
    return evaluate(
      `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)}).click()`,
    );
  };
  const input = async (selector: string, value: string) =>
    evaluate(
      `(()=>{const field=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
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
  const errors: string[] = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const seed = (name: string) => ({
    files: [
      {
        path: 'SKILL.md',
        encoding: 'utf8' as const,
        content: `---\nname: ${name}\ndescription: Review code changes with a repeatable checklist.\n---\n\n# Review code\n\nRead the diff and check the behavior.\n\n## Workflow\n\n1. Inspect the changed files.\n2. Use references/checklist.md.\n3. Report actionable issues.`,
      },
      {
        path: 'references/checklist.md',
        encoding: 'utf8' as const,
        content: '# Checklist\n\nCheck error paths and verify scope boundaries.',
      },
      {
        path: 'scripts/check.ts',
        encoding: 'utf8' as const,
        content: 'console.log("Review helper");',
      },
    ],
  });
  try {
    mkdirSync(join(dir, 'project'), { recursive: true });
    api.store.run('UPDATE workspaces SET folder=? WHERE id=?', join(dir, 'project'), 'default');
    // Preview is deterministic; the HTTP and persistence flows remain real.
    let previewUnavailable = true;
    api.skills.preview = async () => {
      if (previewUnavailable) throw new ApiError(404, 'Not found');
      return {
        ...seed('imported-workflow'),
        source: {
          url: 'https://github.com/example/skills/blob/main/review/SKILL.md',
          repository: 'example/skills',
          commit: 'a'.repeat(40),
          folder: 'review',
        },
      };
    };
    await window.loadFile(join(process.cwd(), 'out/renderer/index.html'));
    await wait('Boolean(document.querySelector(".navigation-rail"))');
    await click('Tools');
    await click('Skills');
    await wait(
      'document.querySelector(".skills-page > .tools-empty")?.textContent.trim()==="No skills yet."',
    );
    assert(
      await evaluate(
        'getComputedStyle(document.querySelector(".skills-page > .tools-empty")).textAlign === "left"',
      ),
    );
    assert(
      await evaluate(
        'document.querySelector(".workspace-tools-folder").textContent.includes("project")',
      ),
    );
    assert(
      await evaluate(
        'getComputedStyle(document.querySelector(".skills-page > .tools-bottom-note")).justifyContent === "flex-start"',
      ),
    );
    await capture('skills-empty.png');
    api.skills.save('default', seed('review-code'));
    await evaluate(`document.querySelector('button[aria-label="Refresh skills"]').click()`);
    await wait('document.querySelectorAll(".skills-page .tool-family-card").length===1');
    await capture('skills-page.png');
    await evaluate(`document.querySelector('.skills-page .tool-family-card').click()`);
    await wait('Boolean(document.querySelector(".skill-markdown"))');
    assert(
      await evaluate('document.querySelector(".skill-markdown").textContent.includes("Workflow")'),
    );
    await evaluate(
      `(()=>{const select=document.querySelector('select[aria-label="Skill file"]');select.value='references/checklist.md';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await wait(
      'document.querySelector(".skill-markdown").textContent.includes("scope boundaries")',
    );
    await capture('skills-detail.png');
    await evaluate(`document.querySelector('.skill-enabled input').click()`);
    await wait('document.querySelector(".skill-enabled input").checked===false');
    assert.equal(api.skills.list('default')[0].enabled, false);
    await click('Edit skill');
    await wait('Boolean(document.querySelector(".skill-editor"))');
    await input(
      '.skill-editor',
      seed('review-code').files[0].content + '\n\nAdded from the editor.',
    );
    await click('Save skill');
    await wait('!document.querySelector(".skill-editor")');
    assert(
      api.skills
        .inspect('default', api.skills.list('default')[0].id)
        .files.find((file) => file.path === 'SKILL.md')!
        .content.includes('Added from the editor.'),
    );
    await click('All skills');
    await click('Create skill');
    await wait('Boolean(document.querySelector(".skill-editor"))');
    await input('.skill-editor', seed('new-workflow').files[0].content);
    await input('input[placeholder="references/example.md"]', 'references/example.md');
    await click('Add file');
    await input('.skill-editor', 'Useful reference text.');
    await click('Save skill');
    await wait('!document.querySelector(".skill-editor")');
    assert.equal(api.skills.list('default').length, 2);
    await click('All skills');
    await input('input[aria-label="Search skills"]', 'not-present');
    await wait('document.querySelectorAll(".skills-page .tool-family-card").length===0');
    await input('input[aria-label="Search skills"]', '');
    await click('Import skill');
    await wait('Boolean(document.querySelector("input[type=url]"))');
    await input('input[type=url]', 'https://github.com/example/skills/blob/main/review/SKILL.md');
    await click('Preview import');
    await wait('document.querySelector(".ai-alert")?.textContent.includes("restart Mukai")');
    previewUnavailable = false;
    await click('Preview import');
    await wait('Boolean(document.querySelector(".skill-import-preview"))');
    await capture('skills-import.png');
    await click('Import skill folder');
    await wait('!document.querySelector(".skill-import-preview")');
    assert.equal(api.skills.list('default').length, 3);
    await click('Remove skill');
    await wait('Boolean(document.querySelector("dialog.confirmation-modal[open]"))');
    await capture('skill-removal-confirmation.png');
    await click('Cancel');
    assert.equal(api.skills.list('default').length, 3);
    await click('Remove skill');
    await evaluate(`document.querySelector('.confirmation-modal .button--danger').click()`);
    await wait('!document.querySelector(".skill-detail")');
    assert.equal(api.skills.list('default').length, 2);
    await evaluate(`document.querySelector('button[aria-label="Open settings"]').click()`);
    await wait('Boolean(document.querySelector("#settings-tab-appearance"))');
    await evaluate(`document.querySelector('#settings-tab-appearance').click()`);
    await wait('Boolean(document.querySelector("input[name=color-mode][value=dark]"))');
    await evaluate(`document.querySelector('input[name=color-mode][value=dark]').click()`);
    await click('Tools');
    await click('Skills');
    await wait('document.querySelectorAll(".skills-page .tool-family-card").length===2');
    await capture('skills-dark.png');
    window.setSize(900, 900);
    await capture('skills-narrow.png');
    assert(
      await evaluate(
        'document.querySelector(".skills-page").scrollWidth<=document.querySelector(".skills-page").clientWidth+1',
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      'Skills navigation, creation, supporting files, editing, import preview, search, enable/disable, removal, and light/dark/narrow rendering passed.',
    );
  } catch (error) {
    await capture('skills-smoke-failure.png');
    console.error('Skills renderer errors:', errors);
    throw error;
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
