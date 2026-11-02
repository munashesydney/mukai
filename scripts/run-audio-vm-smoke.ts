/** Real guest PulseAudio -> authenticated relay -> browser Web Audio, in a disposable VM. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright-core';
import { build } from 'esbuild';
import { QemuComputer, type QemuConfig } from '../src/server/computer/qemuComputer';
import { DesktopTransport } from '../src/server/computer/desktopTransport';
import { defaultDataDir } from '../src/server/config';

async function main() {
  const index = process.argv.indexOf('--data-dir');
  const dataDir = index < 0 ? defaultDataDir() : resolve(process.argv[index + 1]);
  const config = JSON.parse(
    await readFile(join(dataDir, 'computer-setup/ready.json'), 'utf8'),
  ) as QemuConfig;
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mukai-audio-vm-'));
  await mkdir('artifacts/audio-smoke', { recursive: true });
  const fixture = await mkdtemp(resolve('artifacts/audio-smoke/ui-'));
  const vm = new QemuComputer(
    directory,
    { ...config, resources: { memoryMiB: 2048, vcpus: 2 } },
    undefined,
    resolve('dist/guest'),
  );
  const transport = new DesktopTransport(true);
  const owner = { workspaceId: basename(directory), botId: 'smoke', conversationId: 'audio' };
  const signal = AbortSignal.timeout(900000);
  const request = (input: unknown) => vm.request('terminal', input, owner, signal);
  let audioRequests = 0;
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/computer-audio')) {
      try {
        const session = transport.audioSession(vm);
        audioRequests++;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(session));
      } catch {
        res.writeHead(503).end();
      }
      return;
    }
    const name =
      req.url === '/app.js' ? 'app.js' : req.url === '/style.css' ? 'style.css' : 'index.html';
    void readFile(join(fixture, name)).then((bytes) => {
      res.setHeader(
        'Content-Type',
        name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
      );
      res.end(bytes);
    });
  });
  transport.attach(server);
  let browser: Browser | undefined;
  const abort = () => {
    void vm.stop();
  };
  signal.addEventListener('abort', abort, { once: true });
  const progress = setInterval(() => {
    const status = vm.status();
    if (status.state === 'starting')
      console.log('VM:', status.message || status.state, status.detail?.slice(-300) || '');
  }, 10000);
  try {
    console.log('Booting disposable audio VM:', directory);
    await vm.start();
    console.log('Guest ready; generating an output-only stereo tone.');
    await request({
      command:
        "python3 - <<'PY'\nimport wave,math,struct\nwith wave.open('/home/mukai/workspace/tone.wav','wb') as f:\n f.setparams((2,2,48000,0,'NONE','not compressed'))\n f.writeframes(b''.join(struct.pack('<hh',int(8000*math.sin(2*math.pi*440*i/48000)),int(8000*math.sin(2*math.pi*660*i/48000))) for i in range(96000)))\nPY",
    });
    const playback = (await request({
      command: 'while true; do paplay /home/mukai/workspace/tone.wav; done',
      background: true,
      timeoutSeconds: 300,
    })) as { id: string };
    await build({
      stdin: {
        contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{ComputerAudioControls}from'./src/renderer/src/features/computer/ComputerAudioControls';function App(){const[open,setOpen]=useState(true),[workspace,setWorkspace]=useState('smoke');window.setAudioOpen=setOpen;window.setAudioWorkspace=setWorkspace;return <main><h1>Workspace audio</h1><ComputerAudioControls workspaceId={workspace} open={open} available={true}/></main>}createRoot(document.getElementById('root')).render(<App/>);`,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      outfile: join(fixture, 'app.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      define: { 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"production"' },
    });
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script>',
    );
    await writeFile(
      join(fixture, 'style.css'),
      (await readFile('src/renderer/src/styles/tokens.css', 'utf8')) +
        (await readFile('src/renderer/src/styles/computer.css', 'utf8')) +
        'body{font-family:system-ui;padding:30px;background:var(--surface);color:var(--ink)}button{border:0;background:transparent;cursor:pointer}',
    );
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // Observe the actual playback graph, without substituting the audio engine.
    await page.addInitScript(
      `window.audioGraphs=[];const Original=window.AudioContext;window.AudioContext=class extends Original{createGain(){const gain=super.createGain();const analyser=super.createAnalyser();analyser.fftSize=2048;gain.connect(analyser);window.audioGraphs.push({context:this,gain,analyser});return gain}};window.audioPeak=()=>{const graph=window.audioGraphs.at(-1);if(!graph)return 0;const samples=new Float32Array(graph.analyser.fftSize);graph.analyser.getFloatTimeDomainData(samples);return Math.max(...samples.map(Math.abs))};`,
    );
    const address = server.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.locator('.computer-audio-controls button[aria-pressed=true]').waitFor();
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.getByRole('button', { name: 'Mute', exact: true }).waitFor();
    await page.waitForFunction('window.audioPeak() > 0.02');
    const peak = await page.evaluate('window.audioPeak()');
    console.log('PASS: guest tone reached the real browser playback graph; peak=', peak);
    const slider = page.getByRole('slider', { name: 'Workspace volume' });
    await slider.focus();
    await page.keyboard.press('Home');
    await page.waitForFunction(
      'window.audioGraphs.at(-1).gain.gain.value === 0 && window.audioPeak() < 0.001',
    );
    await page.keyboard.press('End');
    await page.waitForFunction('window.audioPeak() > 0.02');
    console.log('PASS: volume controls actual playback amplitude.');
    await vm.request('process', { action: 'kill', sessionId: playback.id }, owner, signal);
    await page.waitForFunction('window.audioPeak() < 0.001');
    await vm.request(
      'files',
      {
        action: 'write_file',
        path: 'audio.html',
        content:
          '<!doctype html><title>Guest browser audio</title><button onclick="const c=new AudioContext();const o=c.createOscillator();const g=c.createGain();o.frequency.value=880;g.gain.value=0.2;o.connect(g).connect(c.destination);o.start();this.disabled=true">Start audio</button>',
      },
      owner,
      signal,
    );
    await request({ command: 'python3 -m http.server 8899 --bind 127.0.0.1', background: true });
    await delay(500);
    const guestTab = (await vm.request(
      'browser',
      { action: 'open', target: 'chrome', url: 'http://127.0.0.1:8899/audio.html' },
      owner,
      signal,
    )) as { tab: { id: string } };
    const snapshot = (await vm.request(
      'browser',
      { action: 'snapshot', sessionId: guestTab.tab.id },
      owner,
      signal,
    )) as { controls: { role: string; ref: string }[] };
    const play = snapshot.controls.find((control) => control.role === 'button');
    assert(play, 'Guest browser must expose the audio start button.');
    await vm.request(
      'browser',
      { action: 'click', sessionId: guestTab.tab.id, ref: play.ref },
      owner,
      signal,
    );
    await page.waitForFunction('window.audioPeak() > 0.02');
    console.log('PASS: audio produced by Chromium inside the VM reaches the viewer.');
    const before = audioRequests;
    transport.forget(vm);
    await page.waitForFunction('window.audioPeak() > 0.02');
    for (let i = 0; i < 30 && audioRequests === before; i++) await delay(150);
    assert(audioRequests > before, 'Audio must reconnect with a fresh ticket.');
    await page.getByRole('button', { name: 'Mute', exact: true }).waitFor();
    await page.waitForFunction('window.audioPeak() > 0.02');
    console.log('PASS: disconnected audio reconnects.');
    await page.screenshot({ path: 'artifacts/audio-smoke/controls.png' });
    await page.getByRole('button', { name: 'Mute', exact: true }).click();
    await page.waitForFunction('window.audioGraphs.at(-1).context.state === "closed"');
    const captures = async () =>
      JSON.stringify(await request({ command: 'pgrep -x parec | wc -l' }));
    let stopped = false;
    for (let i = 0; i < 20; i++) {
      if ((await captures()).includes('"output":"0\\n"')) {
        stopped = true;
        break;
      }
      await delay(100);
    }
    assert(stopped, 'Muting must stop the guest recorder.');
    await page.getByRole('button', { name: 'Enable sound' }).click();
    await page.getByRole('button', { name: 'Mute', exact: true }).waitFor();
    await page.evaluate('window.setAudioOpen(false)');
    await page.waitForFunction('window.audioGraphs.at(-1).context.state === "closed"');
    await page.evaluate('window.setAudioOpen(true)');
    await page.getByRole('button', { name: 'Mute', exact: true }).waitFor();
    const graphs = (await page.evaluate('window.audioGraphs.length')) as number;
    await page.evaluate('window.setAudioWorkspace("other")');
    await page.waitForFunction(
      (count) =>
        (window as unknown as { audioGraphs: { context: AudioContext }[] }).audioGraphs.length >
          count &&
        (window as unknown as { audioGraphs: { context: AudioContext }[] }).audioGraphs[count - 1]
          .context.state === 'closed',
      graphs,
    );
    await page.getByRole('button', { name: 'Mute', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await writeFile(
      'artifacts/audio-smoke/result.json',
      JSON.stringify(
        {
          passed: true,
          peak,
          audioRequests,
          tested: [
            'real guest playback',
            'guest Chromium playback',
            'volume',
            'reconnect',
            'mute recorder cleanup',
            'close',
            'workspace switch',
          ],
        },
        null,
        2,
      ),
    );
    console.log('PASS: mute/close/workspace switch stop playback and capture; browser errors=0.');
  } finally {
    clearInterval(progress);
    signal.removeEventListener('abort', abort);
    await browser?.close();
    transport.shutdown();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    await vm.shutdown();
    await rm(directory, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
