import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const installer = readFileSync('scripts/guest/install.sh', 'utf8').replace(/\r\n/g, '\n');
describe.skipIf(!existsSync(shell))('guest installer virtualization guard', () => {
  it('keeps desktop Chromium on the main profile while honoring explicit automation profiles', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mukai-browser-launcher-'));
    const executable = join(directory, 'browser');
    writeFileSync(executable, '#!/bin/sh\nprintf "<%s>\\n" "$@"\n', { mode: 0o755 });
    const launcher = readFileSync('scripts/guest/browser-start.sh', 'utf8').replaceAll(
      '/opt/mukai-guest/chromium',
      `'${executable.replaceAll("'", "'\\''")}'`,
    );
    // The guest uses POSIX paths. MSYS rewrites a Windows TEMP-based HOME to /tmp.
    const home = '/mukai-launcher-test-home';
    const launch = (args: string[]) =>
      spawnSync(shell, ['-c', launcher, 'launcher', ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
      });
    try {
      const desktop = launch(['https://example.test/']);
      expect(desktop.status).toBe(0);
      expect(desktop.stdout).toContain(`<--user-data-dir=${home}/.config/google-chrome>`);
      expect(desktop.stdout).toContain('<https://example.test/>');
      for (const args of [
        ['--user-data-dir=/workspace profile', '--remote-debugging-pipe'],
        ['--user-data-dir', '/workspace profile'],
      ]) {
        const automation = launch(args);
        expect(automation.status).toBe(0);
        expect(automation.stdout).not.toContain('.config/google-chrome');
        for (const argument of args) expect(automation.stdout).toContain(`<${argument}>`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const [architecture, nodeArch] of [
    ['x86_64', 'x64'],
    ['aarch64', 'arm64'],
  ] as const) {
    it(`selects and checks the native Node archive for ${architecture}`, () => {
      // Stop at extraction. Downloads and package commands are stubs, and the
      // only real writes are to mktemp's disposable directory.
      const harness = `systemd-detect-virt() { printf qemu; }
id() { printf 0; }
uname() { printf '${architecture}'; }
apt-get() { :; }
modprobe() { :; }
curl() { printf '%s\\n' "$2"; printf '%s\\n' 'hash node-v24.1.0-linux-x64.tar.xz' 'hash node-v24.1.0-linux-arm64.tar.xz' > "$4"; }
sha256sum() { cat; }
tar() { printf 'EXTRACT %s\\n' "$*"; return 73; }
${installer}`;
      const result = spawnSync(shell, ['-c', harness], { encoding: 'utf8' });
      expect(result.status).toBe(73);
      expect(result.stdout).toContain(
        `https://nodejs.org/dist/latest-v24.x/node-v24.1.0-linux-${nodeArch}.tar.xz`,
      );
      expect(result.stdout).toContain(`hash node-v24.1.0-linux-${nodeArch}.tar.xz`);
      expect(result.stdout).toContain('EXTRACT');
    });
  }
  it('installs and loads missing firmware modules before downloading guest runtimes', () => {
    const preflight = installer.slice(0, installer.indexOf('scratch='));
    const harness = `systemd-detect-virt() { printf qemu; }
id() { printf 0; }
uname() { if [ "$1" = -r ]; then printf 6.8.0-test; else printf x86_64; fi; }
apt-get() { printf '%s\\n' "$*"; }
attempt=0
modprobe() { attempt=$((attempt+1)); [ "$attempt" -gt 1 ]; }
${preflight}
printf MODULE_READY`;
    const result = spawnSync(shell, ['-c', harness], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('install -y linux-modules-extra-6.8.0-test');
    expect(result.stdout).toContain('MODULE_READY');
  });
  for (const [hypervisor, vendor, accepted] of [
    ['qemu', 'QEMU', true],
    ['kvm', 'QEMU', true],
    ['microsoft', 'QEMU', true],
    ['microsoft', 'Microsoft Corporation', false],
    ['none', 'QEMU', false],
  ] as const) {
    it(`${accepted ? 'accepts' : 'rejects'} ${hypervisor} with ${vendor} hardware`, () => {
      // Execute the real installer, but stub every command before package installation.
      // apt-get stops the accepted path with a sentinel; nothing is installed on the host.
      const harness = `systemd-detect-virt() { printf '%s' '${hypervisor}'; }
cat() { printf '%s' '${vendor}'; }
id() { printf '0'; }
uname() { printf 'x86_64'; }
apt-get() { printf 'INSTALL_REACHED'; return 73; }
${installer}`;
      const result = spawnSync(shell, ['-c', harness], { encoding: 'utf8' });
      expect(result.status).toBe(accepted ? 73 : 1);
      expect(result.stdout.includes('INSTALL_REACHED')).toBe(accepted);
    });
  }
});
