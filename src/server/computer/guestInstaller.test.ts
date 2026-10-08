import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const installer = readFileSync('scripts/guest/install.sh', 'utf8').replace(/\r\n/g, '\n');
describe.skipIf(!existsSync(shell))('guest installer virtualization guard', () => {
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
