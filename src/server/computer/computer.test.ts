import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { Frames, encodeFrame, FRAME_LIMIT } from './protocol';
import { GuestDispatcher } from './guestDispatcher';
import { QemuComputer, qemuArguments } from './qemuComputer';
import { computerTools } from './tools';
import { DiagnosticService } from '../services/diagnosticService';
import { BrowserService } from '../services/browserService';
const host = vi.hoisted(() => ({ architecture: 'x64', platform: process.platform }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  arch: () => host.architecture,
  platform: () => host.platform,
}));

let directory: string;
const cleanup: (() => Promise<unknown>)[] = [];
const owner = { workspaceId: 'workspace', botId: 'bot', conversationId: 'conversation' };
const signal = () => new AbortController().signal;
beforeEach(async () => {
  host.architecture = 'x64';
  host.platform = process.platform;
  directory = await realpath(await mkdtemp(join(tmpdir(), 'mukai-computer-')));
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('computer framing', () => {
  it('handles partial UTF-8, multiple frames and oversized input', () => {
    const frames = new Frames();
    const bytes = encodeFrame({ text: '🌱' });
    const position = bytes.indexOf(Buffer.from('🌱')) + 2;
    expect(frames.push(bytes.subarray(0, position))).toEqual([]);
    expect(
      frames.push(Buffer.concat([bytes.subarray(position), encodeFrame({ done: true })])),
    ).toEqual([{ text: '🌱' }, { done: true }]);
    expect(() => frames.push(Buffer.alloc(FRAME_LIMIT + 1, 65))).toThrow('frame limit');
  });
});

describe('guest services', () => {
  async function guest() {
    const folder = join(directory, 'workspace');
    const data = join(directory, 'private');
    await mkdir(folder);
    await mkdir(data);
    const computer = new GuestDispatcher(folder, data);
    cleanup.push(() => computer.shutdown());
    return { computer, folder };
  }
  it('keeps main Chrome requests in the guest and maps inline to guest workspace Chrome', async () => {
    const { computer } = await guest();
    const execute = vi.spyOn(BrowserService.prototype, 'execute').mockResolvedValue({ tabs: [] });
    try {
      for (const [target, expected] of [
        ['mukai', 'chrome'],
        ['chrome', 'chrome'],
        ['chrome-default', 'chrome-default'],
      ] as const) {
        const profile = target === 'chrome-default' ? { profileId: 'Profile 1' } : {};
        await computer.request(
          'browser',
          { action: 'open', target, url: 'https://example.com', ...profile },
          owner,
          signal(),
        );
        expect(execute).toHaveBeenLastCalledWith(
          owner,
          {
            action: 'open',
            target: expected,
            url: 'https://example.com',
            ...profile,
          },
          expect.any(AbortSignal),
        );
      }
      await computer.request('browser', { action: 'profiles' }, owner, signal());
      expect(execute).toHaveBeenLastCalledWith(
        owner,
        { action: 'profiles', target: 'chrome-default' },
        expect.any(AbortSignal),
      );
    } finally {
      execute.mockRestore();
    }
  });
  it('writes, patches and downloads files with mutation snapshots', async () => {
    const { computer, folder } = await guest();
    expect(
      await computer.request(
        'files',
        { action: 'write_file', path: 'draft.txt', content: 'hello' },
        owner,
        signal(),
      ),
    ).toMatchObject({
      result: { changed: true, path: 'draft.txt' },
      changes: [{ before: null, after: 'hello' }],
    });
    expect(
      await computer.request(
        'files',
        { action: 'patch', path: 'draft.txt', oldText: 'hello', newText: 'world' },
        owner,
        signal(),
      ),
    ).toMatchObject({ changes: [{ before: 'hello', after: 'world' }] });
    expect(await readFile(join(folder, 'draft.txt'), 'utf8')).toBe('world');
    expect(await computer.request('download', { path: 'draft.txt' }, owner, signal())).toEqual({
      name: 'draft.txt',
      bytes: Buffer.from('world').toString('base64'),
    });
    await expect(
      computer.request('files', { action: 'read_file', path: '../outside' }, owner, signal()),
    ).rejects.toThrow();
  });
  it('keeps process sessions scoped to their bot and conversation', async () => {
    const { computer } = await guest();
    const command = `"${process.execPath}" -e "process.stdout.write('guest-output')"`;
    const result = (await computer.request(
      'terminal',
      { command, yieldMs: 30000 },
      owner,
      signal(),
    )) as { id: string; output: string };
    expect(result.output).toContain('guest-output');
    expect(await computer.request('process', { action: 'list' }, owner, signal())).toHaveLength(1);
    expect(
      await computer.request('process', { action: 'list' }, { ...owner, botId: 'other' }, signal()),
    ).toEqual([]);
    await expect(
      computer.request(
        'process',
        { action: 'poll', sessionId: result.id },
        { ...owner, conversationId: 'other' },
        signal(),
      ),
    ).rejects.toThrow('not found');
  });
  it('reads images through guest dispatch and honors cancellation', async () => {
    const { computer, folder } = await guest();
    await sharp({ create: { width: 8, height: 9, channels: 3, background: '#123456' } })
      .png()
      .toFile(join(folder, 'test.png'));
    expect(
      await computer.request('image', { action: 'view', path: 'test.png' }, owner, signal()),
    ).toMatchObject({ width: 8, height: 9, viewed: true, mediaType: 'image/png' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      computer.request('files', { action: 'list' }, owner, controller.signal),
    ).rejects.toThrow();
  });
});

describe('VM tools', () => {
  it('keeps guest screenshot paths while saving host artifacts and delivering vision pixels', async () => {
    const picture = await sharp({
      create: { width: 8, height: 9, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    const image = picture.toString('base64');
    const saveScreenshot = vi.fn().mockResolvedValue({
      artifactId: 'artifact',
      path: 'C:\\host\\saved.png',
      width: 8,
      height: 9,
    });
    const tools = computerTools({
      computer: {
        request: vi.fn().mockResolvedValue({ image, path: '/var/lib/mukai-guest/screen.png' }),
      },
      owner,
      signal: signal(),
      onActivity: vi.fn(),
      budget: { remaining: 10 },
      fileBudget: { remaining: 10 },
      vision: true,
      recordChange: vi.fn(),
      recordFile: vi.fn(),
      saveScreenshot,
    });
    const output = await tools.browser.execute!(
      { action: 'screenshot', sessionId: 'tab' },
      { toolCallId: 'screen', messages: [], context: undefined },
    );
    expect(output).toMatchObject({
      ok: true,
      result: {
        path: '/var/lib/mukai-guest/screen.png',
        artifactId: 'artifact',
        screenshotUrl: '/artifacts/artifact',
      },
    });
    expect(saveScreenshot).toHaveBeenCalledWith(image);
    const model = await tools.browser.toModelOutput!({
      output,
      input: { action: 'screenshot' },
      toolCallId: 'screen',
    });
    expect(model).toMatchObject({
      type: 'content',
      value: [
        { type: 'text' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: image } },
      ],
    });
    expect(JSON.stringify(model)).not.toContain('C:\\\\host');
  });
  it('routes calls exclusively through the computer and preserves file bookkeeping', async () => {
    const request = vi.fn().mockResolvedValue({
      result: { path: 'test.txt', changed: true, summary: 'Saved' },
      changes: [{ path: 'test.txt', before: null, after: 'hello' }],
    });
    const recordChange = vi.fn(),
      recordFile = vi.fn();
    const tools = computerTools({
      computer: { request },
      owner,
      signal: signal(),
      onActivity: vi.fn(),
      budget: { remaining: 10 },
      fileBudget: { remaining: 10 },
      vision: false,
      recordChange,
      recordFile,
      saveScreenshot: vi.fn(),
    });
    const options = { toolCallId: 'call', messages: [], context: undefined };
    expect(
      await tools.file_operations.execute!(
        { action: 'write_file', path: 'test.txt', content: 'hello' },
        options,
      ),
    ).toMatchObject({ ok: true });
    expect(recordChange).toHaveBeenCalledWith({ path: 'test.txt', before: null, after: 'hello' });
    expect(recordFile).toHaveBeenCalledWith('test.txt');
    request.mockRejectedValue(new Error('VM offline'));
    expect(
      await tools.terminal.execute!({ command: 'echo should-not-run' }, options),
    ).toMatchObject({ ok: false, error: 'VM offline' });
    expect(request.mock.calls.at(-1)?.slice(0, 3)).toEqual([
      'terminal',
      { command: 'echo should-not-run' },
      owner,
    ]);
    const calls = request.mock.calls.length;
    expect(await tools.image.execute!({ action: 'view', path: 'test.png' }, options)).toMatchObject(
      { ok: false },
    );
    expect(request).toHaveBeenCalledTimes(calls);
  });
});

describe('QEMU lifecycle over a real loopback bridge', () => {
  // A small stand-in interprets the launch arguments; tests do not pretend to boot QEMU.
  async function fixture(wrongIdentity = false, delay = 0, diagnostics?: DiagnosticService) {
    const image = join(directory, 'base.qcow2');
    const script = join(directory, 'guest.cjs');
    await writeFile(image, 'base-image');
    await writeFile(
      script,
      `
      const net = require('node:net'), fs = require('node:fs');
      const args = process.argv.slice(2);
      const port = Number(/port=(\\d+)/.exec(args[args.indexOf('-chardev')+1])[1]);
      const tokenPath = args[args.indexOf('-fw_cfg')+1].split('file=')[1].replace(/,,/g, ',');
      const token = ${wrongIdentity ? "'0'.repeat(64)" : "fs.readFileSync(tokenPath, 'utf8')"};
      let disconnected = false;
      let socket;
      const connect = () => {
      disconnected = false;
      socket = net.connect(port, '127.0.0.1', () => setTimeout(() => socket.write(JSON.stringify({hello:1,token})+'\\n'), ${delay}));
      let buffer = '';
      socket.on('data', chunk => { buffer += chunk; let end;
        while((end = buffer.indexOf('\\n')) !== -1) {
          const request = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1);
          if(request.ready) continue;
          if(request.cancel) { fs.writeFileSync(tokenPath+'.cancel', request.cancel); continue; }
          if(request.input.command.startsWith('disconnect')) {
            disconnected = true;
            socket.destroy();
            if(request.input.command === 'disconnect-reconnect') setTimeout(connect, 300);
            continue;
          }
          if(request.input.command === 'hang') continue;
          socket.write(JSON.stringify({id:request.id,result:{method:request.method,input:request.input,owner:request.owner}})+'\\n');
        }
      });
      socket.on('close', () => { if(!disconnected) process.exit(0); });
      };
      connect();
      process.stdin.on('data', chunk => { if(chunk.toString().includes('system_powerdown')) process.exit(0); });
    `,
    );
    const launch = vi.fn(
      (
        binary: string,
        args: string[],
        options: import('node:child_process').SpawnOptionsWithoutStdio,
      ) => spawn(binary, [script, ...args], options),
    );
    const firmware = join(directory, 'firmware.fd');
    await writeFile(firmware, 'firmware fixture');
    const vm = new QemuComputer(
      join(directory, 'vm'),
      { binary: process.execPath, image, accelerator: 'tcg', firmware },
      launch,
      undefined,
      diagnostics,
    );
    cleanup.push(() => vm.shutdown());
    return { vm, launch, image };
  }
  it('boots and restarts the ARM bridge with UEFI while retaining disk contents', async () => {
    host.architecture = 'arm64';
    host.platform = 'darwin';
    const { vm, launch } = await fixture();
    await vm.request('terminal', { command: 'arm guest' }, owner, signal());
    const args = launch.mock.calls[0][1];
    expect(args).toEqual(
      expect.arrayContaining([
        'virt,highmem=off',
        'cortex-a72',
        '-bios',
        join(directory, 'firmware.fd'),
      ]),
    );
    await vm.stop();
    await writeFile(join(directory, 'vm', 'disk.qcow2'), 'ARM workspace files');
    await vm.start();
    expect(await readFile(join(directory, 'vm', 'disk.qcow2'), 'utf8')).toBe('ARM workspace files');
    expect(launch).toHaveBeenCalledTimes(2);
  });
  it('shares startup, routes owner data, stops and preserves disk across restarts', async () => {
    const { vm, launch } = await fixture();
    const [first, second] = await Promise.all([
      vm.request('terminal', { command: 'one' }, owner, signal()),
      vm.request('terminal', { command: 'two' }, owner, signal()),
    ]);
    expect(first).toMatchObject({ input: { command: 'one' }, owner });
    expect(second).toMatchObject({ input: { command: 'two' }, owner });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(vm.status().state).toBe('running');
    await vm.stop();
    expect(vm.status().state).toBe('stopped');
    await writeFile(join(directory, 'vm', 'disk.qcow2'), 'persistent changes');
    await vm.start();
    expect(await readFile(join(directory, 'vm', 'disk.qcow2'), 'utf8')).toBe('persistent changes');
    expect(launch).toHaveBeenCalledTimes(2);
  });
  it('forwards cancellation and rejects requests when stopped', async () => {
    const { vm } = await fixture();
    await vm.start();
    const controller = new AbortController();
    const request = vm.request('terminal', { command: 'hang' }, owner, controller.signal);
    const assertion = expect(request).rejects.toThrow('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new Error('cancelled'));
    await assertion;
    await vi.waitFor(async () =>
      expect(await readFile(join(directory, 'vm', 'boot-token.cancel'), 'utf8')).toMatch(
        /^[a-f0-9-]{36}$/,
      ),
    );
    const hanging = vm.request('terminal', { command: 'hang' }, owner, signal());
    const stopped = expect(hanging).rejects.toThrow('stopped');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await vm.stop();
    await stopped;
  });
  it('does not power off a live VM when a tool retries after losing the bridge', async () => {
    const { vm, launch } = await fixture();
    await expect(
      vm.request('terminal', { command: 'disconnect' }, owner, signal()),
    ).rejects.toThrow('connection closed');
    const child = launch.mock.results[0].value;
    await expect(vm.request('terminal', { command: 'ls' }, owner, signal())).rejects.toThrow(
      'still running',
    );
    expect(child.exitCode).toBeNull();
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it('recovers an authenticated guest reconnection without restarting the VM', async () => {
    const { vm, launch } = await fixture();
    await expect(
      vm.request('terminal', { command: 'disconnect-reconnect' }, owner, signal()),
    ).rejects.toThrow('connection closed');
    await vi.waitFor(() => expect(vm.status().state).toBe('running'));
    expect(await vm.request('terminal', { command: 'ls' }, owner, signal())).toMatchObject({
      input: { command: 'ls' },
    });
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it('persists unexpected process exits and bridge failures without logging tool inputs or boot secrets', async () => {
    const diagnostics = new DiagnosticService(directory);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { vm, launch } = await fixture(false, 0, diagnostics);
      await vm.start();
      const token = await readFile(join(directory, 'vm', 'boot-token'), 'utf8');
      await expect(
        vm.request('terminal', { command: 'disconnect-private-command' }, owner, signal()),
      ).rejects.toThrow('connection closed');
      launch.mock.results[0].value.kill();
      await vi.waitFor(() => expect(vm.status().error).toContain('exited'));
      const log = await readFile(diagnostics.path, 'utf8');
      const events = log
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'computer.bridge_disconnected',
          workspaceId: 'vm',
          phase: 'computer',
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'computer.exited',
          message: expect.stringContaining('expected=false'),
        }),
      );
      expect(log).not.toContain(token);
      expect(log).not.toContain('disconnect-private-command');
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
  });
  it('rejects a guest with the wrong boot identity', async () => {
    const { vm } = await fixture(true);
    await expect(vm.start()).rejects.toThrow();
    expect(vm.status().state).toBe('failed');
  });
  it('stops a boot in progress without leaving a guest process behind', async () => {
    const { vm, launch } = await fixture(false, 5000);
    const starting = vm.start();
    const cancelled = expect(starting).rejects.toThrow();
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    await vm.shutdown();
    await cancelled;
    expect(vm.status().state).toBe('stopped');
  });
  it('refuses to open a disk with a recorded live process', async () => {
    const { vm, launch } = await fixture();
    await mkdir(join(directory, 'vm'));
    await writeFile(join(directory, 'vm', 'runtime.pid'), String(process.pid));
    await expect(vm.start()).rejects.toThrow('previous VM process is still running');
    expect(launch).not.toHaveBeenCalled();
  });
  it('fails missing setup without launching and never includes host mounts', async () => {
    const launch = vi.fn();
    const vm = new QemuComputer(
      join(directory, 'vm'),
      { binary: '', image: '', accelerator: 'tcg' },
      launch,
    );
    await expect(vm.request('terminal', { command: 'echo no' }, owner, signal())).rejects.toThrow(
      'MUKAI_QEMU_BINARY',
    );
    expect(launch).not.toHaveBeenCalled();
    const args = qemuArguments('C:\\images,with,commas', 1234, {
      binary: 'qemu',
      image: 'base',
      accelerator: 'whpx',
    });
    expect(args.join(' ')).toContain('images,,with,,commas');
    expect(args.join(' ')).not.toMatch(/virtfs|hostfwd|fsdev/);
    expect(args).toContain('whpx');
  });
});
