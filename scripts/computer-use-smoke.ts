import { app, BrowserWindow, screen } from 'electron';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ComputerUseService } from '../src/server/services/computerUseService';
import { NativeDesktopBackend } from '../src/server/computer/computer_use/nativeBackend';
import type { DesktopDisplay } from '../src/server/computer/computer_use/protocol';
import type { ComputerUseInput } from '../src/server/tools/computer_use/definition';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

void app.whenReady().then(async () => {
  const service = new ComputerUseService(new NativeDesktopBackend());
  const owner = {
    workspaceId: 'computer-use-smoke',
    botId: 'smoke',
    conversationId: 'interactive',
  };
  const signal = AbortSignal.timeout(75000);
  const primary = screen.getPrimaryDisplay();
  const window = new BrowserWindow({
    x: primary.workArea.x + 40,
    y: primary.workArea.y + 40,
    width: 700,
    height: 600,
    frame: false,
    alwaysOnTop: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await window.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#eef2f6;font:16px sans-serif">
      <textarea id="text" style="position:absolute;left:24px;top:24px;width:440px;height:120px"></textarea>
      <button id="button" style="position:absolute;left:500px;top:24px;width:130px;height:50px" onclick="this.textContent='Clicked'">Click me</button>
      <div id="scroll" style="position:absolute;left:24px;top:180px;width:440px;height:230px;overflow:auto"><div style="height:1500px;background:linear-gradient(#acd,#456)">Scroll target</div></div>
      <div id="drag" style="position:absolute;left:500px;top:180px;width:120px;height:100px;background:#79b">Drag target</div>
      <script>
      window.smokeEvents=[];
      for(const type of ['pointerdown','pointermove','pointerup','pointercancel','dragstart','wheel'])document.addEventListener(type,e=>window.smokeEvents.push({type,target:e.target.id,x:e.clientX,y:e.clientY,buttons:e.buttons,alt:e.altKey,ctrl:e.ctrlKey,shift:e.shiftKey,meta:e.metaKey}),true);
      let start; const drag=document.getElementById('drag'); drag.addEventListener('pointerdown',e=>{start=[e.clientX,e.clientY];drag.setPointerCapture(e.pointerId)});drag.addEventListener('pointerup',e=>{if(start&&Math.hypot(e.clientX-start[0],e.clientY-start[1])>10)drag.dataset.dragged='yes'});
      </script>
      </body></html>`),
    );
    window.show();
    window.focus();
    await delay(500);
    const run = (input: ComputerUseInput) => service.execute(owner, input, signal);
    const displays = (await run({ action: 'displays' })) as { displays: DesktopDisplay[] };
    const display = displays.displays.find((item) => item.primary) || displays.displays[0];
    window.moveTop();
    window.focus();
    await delay(1500);
    const capture = (await run({ action: 'screenshot', displayId: display.id })) as {
      screenshotId: string;
      image: string;
      width: number;
      height: number;
    };
    const bounds = window.getContentBounds();
    const point = (x: number, y: number) => ({
      screenshotId: capture.screenshotId,
      x: ((bounds.x + x - primary.bounds.x) / primary.bounds.width) * capture.width,
      y: ((bounds.y + y - primary.bounds.y) / primary.bounds.height) * capture.height,
    });
    const evaluate = (code: string) =>
      window.webContents.executeJavaScript(code) as Promise<unknown>;
    const diagnostics = async () =>
      JSON.stringify({
        events: await evaluate('window.smokeEvents'),
        originalBounds: bounds,
        currentBounds: window.getContentBounds(),
        cursor: await run({ action: 'cursor' }),
      });
    const waitFor = async (condition: string, message: string) => {
      const deadline = Date.now() + 5000;
      while (!(await evaluate(condition))) {
        if (Date.now() >= deadline) assert.fail(`${message} ${await diagnostics()}`);
        await delay(50);
      }
    };
    await mkdir(resolve('artifacts/computer_use'), { recursive: true });
    await writeFile(
      resolve('artifacts/computer_use/interactive-screen.png'),
      Buffer.from(capture.image, 'base64'),
    );
    if (!window.isFocused())
      throw new Error(
        'The disposable smoke window could not acquire focus. Run this test in an interactive desktop without an overlay intercepting input.',
      );
    await run({ action: 'click', ...point(550, 50) });
    await delay(100);
    assert.equal(await evaluate("document.getElementById('button').textContent"), 'Clicked');
    const gestures = async (phase: string) => {
      await evaluate('window.smokeEvents=[]');
      await run({ action: 'scroll', ...point(200, 280), direction: 'down', pixels: 650 });
      await waitFor(
        "document.getElementById('scroll').scrollTop > 0",
        `The scroll gesture was not delivered ${phase}.`,
      );
      const start = point(550, 210),
        end = point(600, 250);
      await evaluate('window.smokeEvents=[]');
      await run({ action: 'drag', ...start, endX: end.x, endY: end.y, durationMs: 300 });
      await waitFor(
        "document.getElementById('drag').dataset.dragged === 'yes'",
        `The drag gesture was not delivered ${phase}.`,
      );
      console.log(`Scroll and drag delivered ${phase}.`);
      await evaluate(
        "document.getElementById('scroll').scrollTop=0; delete document.getElementById('drag').dataset.dragged",
      );
    };
    await gestures('before typing');
    await run({ action: 'click', ...point(80, 70) });
    const text =
      'Mukai café 世界 🌱 — [] {} ! @ # $ % ^ & * ( ) + = : ; , . ? / 0123456789 Ωαβ你好再见'.repeat(
        3,
      );
    await run({ action: 'type', text });
    await delay(200);
    assert.equal(await evaluate("document.getElementById('text').value"), text);
    await run({ action: 'press', key: 'CMD+A' });
    await run({ action: 'type', text: 'replaced' });
    await delay(100);
    assert.equal(await evaluate("document.getElementById('text').value"), 'replaced');
    await run({ action: 'key_down', key: 'SHIFT' });
    await run({ action: 'key_up', key: 'SHIFT' });
    await gestures('after typing');
    console.log(
      'Native screenshot, click, Unicode text, shortcut, key hold, scroll and drag passed.',
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await service.shutdown();
    window.destroy();
    app.exit(Number(process.exitCode) || 0);
  }
});
