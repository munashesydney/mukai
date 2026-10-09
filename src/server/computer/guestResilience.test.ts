import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guestScripts } from './bundleFiles';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const source = readFileSync('scripts/guest/resilience.sh', 'utf8').replace(/\r\n/g, '\n');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

type Options = {
  freeKiB?: number;
  freeAfterKiB?: number;
  existingSwap?: boolean;
  configuredSwap?: boolean;
  managedSwap?: boolean;
  managedEntries?: number;
  filesystem?: string;
  swaponFails?: boolean;
  formatFails?: boolean;
  runs?: number;
};

function provision(options: Options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mukai-resilience-'));
  const path = (name: string) => join(directory, name).replaceAll('\\', '/');
  const swapfile = path('state/swapfile');
  const fstab = path('fstab');
  const swaps = path('proc-swaps');
  const calls = path('calls');
  writeFileSync(
    fstab,
    '# Preserve image mounts\n/dev/vda1 / ext4 defaults 0 1\n' +
      (options.configuredSwap ? '/image-swap none swap sw 0 0\n' : '') +
      `${swapfile} none swap sw 0 0\n`.repeat(options.managedEntries ?? 0),
  );
  writeFileSync(
    swaps,
    'Filename Type Size Used Priority\n' +
      (options.existingSwap ? '/image-swap file 2097152 0 -2\n' : '') +
      (options.managedSwap ? `${swapfile} file 2097152 0 -2\n` : ''),
  );
  if (options.managedSwap) {
    mkdirSync(path('state'));
    writeFileSync(swapfile, 'existing swap');
  }
  let script = source;
  // Relocate every root-owned path into this disposable fixture. Production
  // has no path override; command stubs never activate swap or change the host.
  for (const [original, replacement] of [
    ['/var/lib/mukai-guest-system', path('state')],
    ['/var/log/mukai-guest', path('health-log')],
    ['/var/log/journal', path('journal')],
    ['/etc/systemd/journald.conf.d', path('journald.conf.d')],
    ['/etc/sysctl.d', path('sysctl.d')],
    ['/etc/fstab', fstab],
    ['/proc/swaps', swaps],
  ]) {
    script = script.replaceAll(original!, quote(replacement!));
  }
  const harness = `calls=${quote(calls)}
swaps=${quote(swaps)}
allocated=0
id() { printf 0; }
install() {
  printf 'install %s\\n' "$*" >> "$calls"
  local directory=0
  local args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in -o|-g|-m) shift 2 ;; -d) directory=1; shift ;; *) args+=("$1"); shift ;; esac
  done
  if [ "$directory" = 1 ]; then command mkdir -p "\${args[@]}"; else command cp "\${args[@]}"; fi
}
chown() { printf 'chown %s\\n' "$*" >> "$calls"; }
chmod() { printf 'chmod %s\\n' "$*" >> "$calls"; }
journalctl() { printf 'journalctl %s\\n' "$*" >> "$calls"; }
sysctl() { printf 'sysctl %s\\n' "$*" >> "$calls"; }
df() {
  if [ "$1" = -PT ]; then
    printf 'Filesystem Type 1024-blocks Used Available Capacity Mounted\\n/dev/fake %s 33000000 1000000 30000000 4%% /\\n' ${quote(options.filesystem ?? 'ext4')}
  elif [ "$allocated" = 1 ]; then
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/fake 33000000 1000000 %s 4%% /\\n' ${options.freeAfterKiB ?? 10000000}
  else
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/fake 33000000 1000000 %s 4%% /\\n' ${options.freeKiB ?? 12000000}
  fi
}
dd() {
  printf 'dd %s\\n' "$*" >> "$calls"
  local target
  for argument in "$@"; do case "$argument" in of=*) target="\${argument#of=}" ;; esac; done
  printf 'mock allocated swap' > "$target"
  allocated=1
}
stat() { printf 2147483648; }
mkswap() { printf 'mkswap %s\\n' "$*" >> "$calls"; return ${options.formatFails ? 1 : 0}; }
swapon() {
  printf 'swapon %s\\n' "$*" >> "$calls"
  ${options.swaponFails ? 'return 1' : 'printf \'%s file 2097152 0 -2\\n\' "$1" >> "$swaps"'}
}
${script.repeat(options.runs ?? 1)}`;
  try {
    const result = spawnSync(shell, ['-c', harness], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Provisioning fixture failed: ${result.stderr}`);
    return {
      result,
      calls: readFileSync(calls, 'utf8'),
      fstab: readFileSync(fstab, 'utf8'),
      swapfile,
      journal: readFileSync(path('journald.conf.d/60-mukai-resilience.conf'), 'utf8'),
      swapExists: existsSync(swapfile),
      pendingFiles: spawnSync(shell, ['-c', `find ${quote(directory)} -name 'swapfile.*'`], {
        encoding: 'utf8',
      }).stdout.trim(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(!existsSync(shell))('guest resilience provisioning', () => {
  it('rejects unprivileged execution before provisioning any paths', () => {
    const result = spawnSync(shell, ['-c', `id() { printf 1001; }\n${source}`], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires root');
  });

  it('allocates and activates swap once, preserving mounts and a single fstab entry on rerun', () => {
    const output = provision({ runs: 2 });
    expect(output.result.status, output.result.stderr).toBe(0);
    expect(output.calls.match(/^dd /gm)).toHaveLength(1);
    expect(output.calls).toContain('bs=1M count=2048 conv=fsync');
    expect(output.calls.match(/^mkswap /gm)).toHaveLength(1);
    expect(output.calls.match(/^swapon /gm)).toHaveLength(1);
    expect(output.calls).toContain(`chmod 0600 ${output.swapfile}`);
    expect(output.fstab).toContain('/dev/vda1 / ext4 defaults 0 1');
    expect(
      output.fstab.split('\n').filter((line) => line.startsWith(output.swapfile)),
    ).toHaveLength(1);
    expect(output.calls).toContain('sysctl -w vm.swappiness=20');
  });

  it('normalizes duplicate managed entries without reallocating an active swap file', () => {
    const output = provision({ managedSwap: true, managedEntries: 2 });
    expect(output.result.status, output.result.stderr).toBe(0);
    expect(output.calls).not.toMatch(/^(dd|mkswap|swapon) /m);
    expect(
      output.fstab.split('\n').filter((line) => line.startsWith(output.swapfile)),
    ).toHaveLength(1);
  });

  for (const options of [{ existingSwap: true }, { configuredSwap: true }]) {
    it(`respects ${options.existingSwap ? 'active' : 'configured'} administrator swap`, () => {
      const output = provision(options);
      expect(output.result.status, output.result.stderr).toBe(0);
      expect(output.calls).not.toMatch(/^(dd|mkswap|swapon|sysctl) /m);
      expect(output.fstab).not.toContain(output.swapfile);
      expect(output.result.stderr).toContain('Existing swap detected');
    });
  }

  it('leaves 4 GiB free and does not allocate when the initial disk budget is insufficient', () => {
    const output = provision({ freeKiB: 6291455 });
    expect(output.result.status, output.result.stderr).toBe(0);
    expect(output.calls).not.toMatch(/^(dd|mkswap|swapon) /m);
    expect(output.result.stderr).toContain('leave at least 4 GiB free');
    expect(output.swapExists).toBe(false);
  });

  it('removes the new file when concurrent usage erodes the reserved space during allocation', () => {
    const output = provision({ freeAfterKiB: 4194303 });
    expect(output.result.status, output.result.stderr).toBe(0);
    expect(output.calls).toMatch(/^dd /m);
    expect(output.calls).not.toMatch(/^(mkswap|swapon) /m);
    expect(output.swapExists).toBe(false);
    expect(output.pendingFiles).toBe('');
  });

  it('does not persist an unusable swap file when activation fails', () => {
    const output = provision({ swaponFails: true });
    expect(output.result.status, output.result.stderr).toBe(0);
    expect(output.calls).toMatch(/^swapon /m);
    expect(output.fstab).not.toContain(output.swapfile);
    expect(output.result.stderr).toContain('Swap was not activated');
  });

  it('cleans up an allocated file when formatting fails', () => {
    const output = provision({ formatFails: true });
    expect(output.result.status, output.result.stderr).toBe(0);
    expect(output.calls).toMatch(/^mkswap /m);
    expect(output.calls).not.toMatch(/^swapon /m);
    expect(output.fstab).not.toContain(output.swapfile);
    expect(output.swapExists).toBe(false);
    expect(output.pendingFiles).toBe('');
  });

  it('reports unsupported filesystems without allocating swap', () => {
    const output = provision({ filesystem: 'btrfs' });
    expect(output.result.status, output.result.stderr).toBe(0);
    expect(output.calls).not.toMatch(/^(dd|mkswap|swapon) /m);
    expect(output.result.stderr).toContain('not supported');
  });

  it('keeps persistent diagnostics capped and loads the provisioner through trusted updates', () => {
    const output = provision({ existingSwap: true });
    expect(output.journal).toContain('Storage=persistent');
    expect(output.journal).toContain('SystemMaxUse=100M');
    expect(output.journal).toContain('SystemKeepFree=1G');
    expect(output.calls).toMatch(/install -d -o root -g root -m 0750 .*health-log/);
    expect(guestScripts).toContain('resilience.sh');
    expect(readFileSync('scripts/guest/protect.sh', 'utf8')).toContain(
      '/bin/sh /usr/lib/mukai-guest/resilience.sh',
    );
  });
});
