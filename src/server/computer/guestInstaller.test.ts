import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const installer = readFileSync('scripts/guest/install.sh', 'utf8').replace(/\r\n/g, '\n');
describe.skipIf(!existsSync(shell))('guest installer virtualization guard', () => {
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
