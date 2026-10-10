import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guestScripts } from './bundleFiles';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const script = readFileSync('scripts/guest/whpx-cet.sh', 'utf8').replace(/\r\n/g, '\n');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

function provision(
  accelerator: string,
  architecture = 'x86_64',
  options: { twice?: boolean; fails?: boolean; uid?: number } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'mukai-cet-test-'));
  const root = directory.replaceAll('\\', '/');
  const calls = join(directory, 'calls');
  const helper = join(directory, 'helper.sh');
  writeFileSync(calls, '');
  // Only the disposable GRUB directory is real; no host system files are used.
  writeFileSync(helper, script.replaceAll('/etc/default/grub.d', root + '/grub.d'));
  const harness = `uname() { printf '%s' ${quote(architecture)}; }
id() { printf '%s' ${quote(String(options.uid ?? 0))}; }
update-grub() { printf 'update\\n' >> ${quote(calls.replaceAll('\\', '/'))}; return ${options.fails ? 1 : 0}; }
export -f uname id update-grub
bash ${quote(helper.replaceAll('\\', '/'))} ${quote(accelerator)} || exit $?
${options.twice ? `bash ${quote(helper.replaceAll('\\', '/'))} ${quote(accelerator)} || exit $?` : ''}
if [ -f ${quote(root + '/grub.d/99-mukai-whpx-cet.cfg')} ]; then
  GRUB_CMDLINE_LINUX='existing-option=1'
  . ${quote(root + '/grub.d/99-mukai-whpx-cet.cfg')}
  printf 'CMDLINE=%s\\n' "$GRUB_CMDLINE_LINUX"
fi`;
  try {
    const result = spawnSync(shell, ['-c', harness], { encoding: 'utf8' });
    const cfg = join(directory, 'grub.d', '99-mukai-whpx-cet.cfg');
    return {
      ...result,
      config: existsSync(cfg) ? readFileSync(cfg, 'utf8') : undefined,
      calls: readFileSync(calls, 'utf8'),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(!existsSync(shell))('new WHPX image CET policy', () => {
  it('preserves existing kernel arguments and updates GRUB only once', () => {
    const result = provision('whpx', 'x86_64', { twice: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toBe('update\n');
    expect(result.stdout).toContain('CMDLINE=existing-option=1 clearcpuid=519,596 nousershstk');
    expect(result.config).toContain(
      'GRUB_CMDLINE_LINUX="${GRUB_CMDLINE_LINUX} clearcpuid=519,596 nousershstk"',
    );
  });
  for (const [accelerator, architecture] of [
    ['kvm', 'x86_64'],
    ['hvf', 'x86_64'],
    ['tcg', 'x86_64'],
    ['', 'x86_64'],
    ['whpx', 'aarch64'],
  ]) {
    it(`does not alter CET for ${accelerator || 'unspecified'} / ${architecture}`, () => {
      const result = provision(accelerator, architecture);
      expect(result.status, result.stderr).toBe(0);
      expect(result.config).toBeUndefined();
      expect(result.calls).toBe('');
    });
  }
  it('fails image preparation when GRUB cannot be updated', () => {
    const result = provision('whpx', 'x86_64', { fails: true });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('WHPX image: CET disabled');
  });
  it('requires root before touching the guest boot configuration', () => {
    const result = provision('whpx', 'x86_64', { uid: 1001 });
    expect(result.status).toBe(1);
    expect(result.config).toBeUndefined();
    expect(result.calls).toBe('');
  });
  it('bundles the helper for new installation without changing trusted updates', () => {
    expect(guestScripts).toContain('whpx-cet.sh');
    expect(readFileSync('scripts/guest/install.sh', 'utf8')).toContain('sh ./whpx-cet.sh "${1:-}"');
    expect(readFileSync('scripts/guest/protect.sh', 'utf8')).not.toContain('whpx-cet');
  });
});
