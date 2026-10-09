import assert from 'node:assert/strict';
import { readFile, mkdtemp, realpath, rm, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { QemuComputer, type QemuConfig } from '../src/server/computer/qemuComputer';
import { defaultDataDir } from '../src/server/config';
import type { ComputerUseInput } from '../src/server/tools/computer_use/definition';

async function main() {
  const index = process.argv.indexOf('--data-dir');
  const dataDir = index < 0 ? defaultDataDir() : resolve(process.argv[index + 1]);
  const config = JSON.parse(
    await readFile(join(dataDir, 'computer-setup/ready.json'), 'utf8'),
  ) as QemuConfig;
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'mukai-computer-use-'));
  const vm = new QemuComputer(directory, config, undefined, resolve('dist/guest'));
  const owner = { workspaceId: basename(directory), botId: 'smoke', conversationId: 'smoke' };
  const signal = AbortSignal.timeout(300000);
  const run = (input: ComputerUseInput) => vm.request('computer_use', input, owner, signal);
  const request = (method: Parameters<QemuComputer['request']>[0], input: unknown) =>
    vm.request(method, input, owner, signal);
  const state = async () => {
    const result = z
      .object({ result: z.object({ content: z.string() }) })
      .parse(await request('files', { action: 'read_file', path: 'computer_use-events.json' }));
    return JSON.parse(result.result.content) as {
      x: number;
      y: number;
      text: string;
      buttons: number[];
      motion: number;
      releasedKeys: number;
    };
  };
  try {
    console.log('Booting disposable base copy:', directory);
    await vm.start();
    console.log('Guest computer_use:', await run({ action: 'status' }));
    const capture = z
      .object({
        image: z.string(),
        screenshotId: z.string(),
        path: z.string(),
        width: z.number(),
        height: z.number(),
        coordinateMapping: z.object({
          originX: z.number(),
          originY: z.number(),
          logicalUnitsPerPixelX: z.number(),
          logicalUnitsPerPixelY: z.number(),
        }),
      })
      .parse(await run({ action: 'screenshot' }));
    assert.ok(capture.path.startsWith('/var/lib/mukai-guest/screenshots/'));
    const viewed = z
      .object({ width: z.number(), height: z.number() })
      .parse(await request('image', { action: 'view', path: capture.path }));
    assert.equal(viewed.width, capture.width);
    assert.equal(viewed.height, capture.height);
    const artifactDir = resolve('artifacts/computer_use');
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, 'vm-smoke.png'), Buffer.from(capture.image, 'base64'));
    await request('files', {
      action: 'write_file',
      path: 'computer_use-smoke.py',
      content: await readFile('scripts/computer_use/x11_smoke.py', 'utf8'),
    });
    await request('terminal', { command: 'python3 computer_use-smoke.py', background: true });
    let receiver: Awaited<ReturnType<typeof state>> | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        receiver = await state();
        break;
      } catch {
        await delay(300, undefined, { signal });
      }
    }
    assert.ok(receiver, 'X11 receiver did not start.');
    const point = (x: number, y: number) => ({
      screenshotId: capture.screenshotId,
      x:
        (receiver.x + x - capture.coordinateMapping.originX) /
        capture.coordinateMapping.logicalUnitsPerPixelX,
      y:
        (receiver.y + y - capture.coordinateMapping.originY) /
        capture.coordinateMapping.logicalUnitsPerPixelY,
    });
    await run({ action: 'click', ...point(100, 100), clicks: 2 });
    await run({ action: 'type', text: 'Mukai café 世界 🌱' });
    await delay(200);
    assert.equal((await state()).text, 'Mukai café 世界 🌱');
    const mixedText =
      'Mukai café 世界 🌱 — [] {} ! @ # $ % ^ & * ( ) + = : ; , . ? / 0123456789 Ωαβ你好再见';
    await run({ action: 'press', key: 'CTRL+A' });
    await run({ action: 'type', text: mixedText.repeat(3) });
    await delay(200);
    assert.equal((await state()).text, mixedText.repeat(3));
    await run({ action: 'press', key: 'CTRL+A' });
    await run({ action: 'type', text: 'replaced' });
    await run({ action: 'key_down', key: 'SHIFT' });
    await run({ action: 'key_up', key: 'SHIFT' });
    await run({ action: 'scroll', ...point(100, 100), direction: 'down', pixels: 500 });
    const end = point(200, 200);
    await run({ action: 'drag', ...point(100, 100), endX: end.x, endY: end.y, durationMs: 300 });
    await delay(200);
    const observed = await state();
    assert.equal(observed.text, 'replaced');
    assert.ok(observed.buttons.filter((button) => button === 1).length >= 3);
    assert.ok(observed.buttons.includes(5), 'Scroll did not arrive.');
    assert.ok(observed.motion >= 5, 'Drag motion did not arrive.');
    assert.ok(observed.releasedKeys > 5);
    console.log(
      'VM screenshot, double click, Unicode, shortcut, key hold, scroll and drag passed:',
      observed,
    );
    await request('files', {
      action: 'write_file',
      path: 'computer_use-smoke.html',
      content:
        '<!doctype html><title>Native typing smoke</title><textarea aria-label="Native typing" autofocus style="width:90vw;height:60vh;font-size:24px"></textarea>',
    });
    await request('terminal', {
      command: 'python3 -m http.server 8898 --bind 127.0.0.1',
      background: true,
    });
    await delay(300, undefined, { signal });
    const browser = z.object({ tab: z.object({ id: z.string() }) }).parse(
      await request('browser', {
        action: 'open',
        target: 'chrome',
        url: 'http://127.0.0.1:8898/computer_use-smoke.html',
      }),
    );
    const sessionId = browser.tab.id;
    // A screenshot brings the real Chromium window forward before injecting native input.
    await request('browser', { action: 'screenshot', sessionId });
    const snapshotSchema = z.object({
      controls: z.array(z.object({ role: z.string(), ref: z.string(), value: z.string() })),
    });
    const controls = snapshotSchema.parse(
      await request('browser', { action: 'snapshot', sessionId }),
    ).controls;
    const textarea = controls.find((control) => control.role === 'textarea');
    assert.ok(textarea, 'Chromium typing fixture did not load.');
    await request('browser', { action: 'click', sessionId, ref: textarea.ref });
    await run({ action: 'type', text: mixedText.repeat(3) });
    await delay(300, undefined, { signal });
    const typed = snapshotSchema
      .parse(await request('browser', { action: 'snapshot', sessionId }))
      .controls.find((control) => control.role === 'textarea');
    assert.equal(typed?.value, mixedText.repeat(3));
    console.log('Native X11 Unicode typing in guest Chromium passed.');
    await request('browser', { action: 'close', sessionId });
  } finally {
    await vm.shutdown();
    const artifactDir = resolve('artifacts/computer_use');
    await mkdir(artifactDir, { recursive: true });
    await copyFile(join(directory, 'console.log'), join(artifactDir, 'vm-console.log')).catch(
      () => {},
    );
    const target = await realpath(directory);
    assert.equal(dirname(target), parent, 'Unexpected VM cleanup path.');
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
