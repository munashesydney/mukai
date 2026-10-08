/** Opt-in integration test. Clones a prepared disk; never boots or modifies the base image. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { QemuComputer, qemuConfig } from '../src/server/computer/qemuComputer';
import { z } from 'zod';
import { build } from 'esbuild';

async function main() {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'mukai-vm-guardrails-'));
  const config = qemuConfig();
  const owner = { workspaceId: 'test', botId: 'one', conversationId: 'test' };
  const signal = new AbortController().signal;
  let vm = new QemuComputer(directory, config);
  const run = async (command: string, botId = 'one') => {
    const result = z.object({
      id: z.string(),
      status: z.string(),
      exitCode: z.number().nullable(),
      output: z.string(),
    });
    let state = result.parse(
      await vm.request('terminal', { command, yieldMs: 1000 }, { ...owner, botId }, signal),
    );
    while (state.status === 'running')
      state = result.parse(
        await vm.request(
          'process',
          { action: 'wait', sessionId: state.id, waitMs: 30000 },
          { ...owner, botId },
          signal,
        ),
      );
    assert.equal(state.exitCode, 0, state.output);
    return state.output;
  };
  try {
    console.log('Writing a marker before upgrading the cloned guest.');
    await run('printf preserved > guardrail-marker.txt');
    await vm.stop();
    vm = new QemuComputer(directory, config, undefined, resolve('dist/guest'));
    console.log('Upgrading the existing disk and restarting its bridge.');
    await vm.start();
    assert.match(await run('cat guardrail-marker.txt', 'two'), /preserved/);
    const identity = await run('id; sudo -n id; ps -eo user,comm | grep mukai-');
    assert.match(identity, /uid=\d+\(mukai\)/);
    assert.match(identity, /uid=0\(root\)/);
    assert.doesNotMatch(identity.split('\n')[0], /\(root\)/);
    assert.match(identity, /root\s+mukai-bridge/);
    assert.match(identity, /mukai\s+mukai-tools/);
    await run('test ! -r /run/mukai-guest/boot-token; test ! -w /dev/virtio-ports/com.mukai.agent');
    for (const command of [
      'poweroff',
      'reboot',
      'shutdown -h now',
      'halt',
      'systemctl poweroff',
      'systemctl reboot',
      'systemctl stop mukai-guest',
      'systemctl restart mukai-guest',
    ]) {
      assert.match(
        await run(
          `if sudo -n ${command}; then echo UNEXPECTED_SUCCESS; exit 1; else echo BLOCKED; fi`,
        ),
        /BLOCKED/,
      );
    }
    await run(
      'if kill -TERM $(pgrep -x mukai-bridge); then exit 1; else echo BRIDGE_PROTECTED; fi',
    );
    await run(
      'sudo -n systemctl is-active mukai-guest; sudo -n systemctl daemon-reload; sudo -n sh -c "printf admin > /root/mukai-admin-test"; sudo -n cat /root/mukai-admin-test',
    );
    const profileCheck = await build({
      stdin: {
        contents: `import { checkSharedChromeProfiles } from './scripts/browser-profile-check';
        checkSharedChromeProfiles('/home/mukai/workspace/profile-acceptance', 'https://mukai-profile.test/').catch(error => { console.error(error); process.exitCode = 1; });`,
        resolveDir: resolve('.'),
      },
      bundle: true,
      platform: 'node',
      packages: 'external',
      write: false,
    });
    await vm.request(
      'files',
      {
        action: 'write_file',
        path: 'profile-check.cjs',
        content: profileCheck.outputFiles[0].text,
      },
      owner,
      signal,
    );
    console.log(await run('NODE_PATH=/opt/mukai-guest/node_modules node profile-check.cjs'));
    await run('printf "<title>VM guardrails</title><h1>Working</h1>" > guardrail-browser.html');
    const server = z
      .object({ id: z.string() })
      .parse(
        await vm.request(
          'terminal',
          { command: 'python3 -m http.server 8765 --bind 127.0.0.1', background: true },
          owner,
          signal,
        ),
      );
    const page = z
      .object({ tab: z.object({ id: z.string() }) })
      .parse(
        await vm.request(
          'browser',
          { action: 'open', url: 'http://127.0.0.1:8765/guardrail-browser.html' },
          owner,
          signal,
        ),
      );
    assert.match(
      JSON.stringify(
        await vm.request('browser', { action: 'snapshot', sessionId: page.tab.id }, owner, signal),
      ),
      /Working/,
    );
    const screenshot = z
      .object({ path: z.string() })
      .parse(
        await vm.request(
          'browser',
          { action: 'screenshot', sessionId: page.tab.id },
          owner,
          signal,
        ),
      );
    assert.ok(await vm.request('image', { action: 'read', path: screenshot.path }, owner, signal));
    await vm.request('process', { action: 'kill', sessionId: server.id }, owner, signal);
    console.log(
      'Verified: sudo, bridge protection, power guardrails, Chrome, and files shared across bots.',
    );
    const stoppedAt = Date.now();
    await vm.stop();
    assert.ok(
      Date.now() - stoppedAt < 14000,
      'Guest should power off through QMP before the forced-stop timeout.',
    );
    assert.equal(vm.status().state, 'stopped');
    await vm.start();
    assert.match(await run('cat guardrail-marker.txt'), /preserved/);
    console.log('Verified: controller stop/start and persistent workspace files.');
  } finally {
    await vm.shutdown();
    const target = await realpath(directory);
    assert.equal(dirname(target), parent);
    await rm(target, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
