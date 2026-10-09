import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guestScripts } from './bundleFiles';

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const source = readFileSync('scripts/guest/kernel-modules.sh', 'utf8').replace(/\r\n/g, '\n');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

type Options = {
  /** Installed linux-image-<abi>-<flavour> packages, as dpkg would report them. */
  installedImages?: string[];
  /** Any other installed package the script may ask dpkg about. */
  installedPackages?: string[];
  running?: string;
  /** Whether qemu_fw_cfg loads without installing anything. */
  moduleLoads?: boolean;
  /** Whether qemu_fw_cfg loads once a package has been installed. */
  moduleLoadsAfterInstall?: boolean;
  /** Simulates an already complete package list, as install.sh passes it. */
  aptUpdated?: boolean;
  aptFails?: boolean;
};

/**
 * Runs the real guest script under bash with dpkg/apt/modprobe stubbed out, so
 * the decision logic is exercised without a guest, a package manager or root.
 */
function repair(options: Options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mukai-kernel-modules-'));
  const path = (name: string) => join(directory, name).replaceAll('\\', '/');
  const calls = path('calls');
  writeFileSync(calls, '');
  const harness = `calls=${quote(calls)}
images=${quote((options.installedImages ?? []).join(' '))}
packages=${quote((options.installedPackages ?? []).join(' '))}
apt_fails=${options.aptFails ? 1 : 0}
apt_installed=0
module_ok=${options.moduleLoads ? 1 : 0}
module_after_install=${options.moduleLoadsAfterInstall ? 1 : 0}
id() { printf 0; }
uname() { printf '%s' ${quote(options.running ?? '6.8.0-142-generic')}; }
depmod() { printf 'depmod %s\\n' "$*" >> "$calls"; }
modprobe() {
  printf 'modprobe %s\\n' "$*" >> "$calls"
  if [ "$module_ok" = 1 ] || { [ "$module_after_install" = 1 ] && [ "$apt_installed" = 1 ]; }; then
    return 0
  fi
  return 1
}
dpkg-query() {
  local pattern=''
  for argument in "$@"; do
    case "$argument" in -W|-f=*) ;; *) pattern="$argument" ;; esac
  done
  printf 'dpkg-query %s\\n' "$pattern" >> "$calls"
  case "$pattern" in
    'linux-image-[0-9]*')
      # dpkg lists only package names; the script drops anything not installed.
      for package in $images; do printf '%s install ok installed\\n' "$package"; done
      return 0
      ;;
  esac
  for package in $packages $images; do
    if [ "$package" = "$pattern" ]; then printf 'install ok installed'; return 0; fi
  done
  return 1
}
apt-get() {
  printf 'apt-get %s\\n' "$*" >> "$calls"
  if [ "$apt_fails" = 1 ]; then return 1; fi
  if [ "$1" = update ]; then return 0; fi
  local installing=0
  for argument in "$@"; do
    case "$argument" in
      install) installing=1 ;;
      -o|-y|--no-install-recommends) ;;
      -*) ;;
      Acquire::*) ;;
      *) if [ "$installing" = 1 ]; then packages="$packages $argument"; fi ;;
    esac
  done
  apt_installed=1
  return 0
}
${source}`;
  const env = { ...process.env };
  if (options.aptUpdated) env.MUKAI_APT_UPDATED = '1';
  else delete env.MUKAI_APT_UPDATED;
  try {
    const result = spawnSync(shell, ['-c', harness], { encoding: 'utf8', env });
    return { result, calls: readFileSync(calls, 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(!existsSync(shell))('guest kernel module provisioning', () => {
  it('repairs the running kernel, every other installed kernel, and adopts the tracking meta', () => {
    // The incident: unattended-upgrades added a kernel with no modules-extra.
    const output = repair({
      installedImages: ['linux-image-6.8.0-142-generic', 'linux-image-6.8.0-146-generic'],
      running: '6.8.0-146-generic',
      moduleLoadsAfterInstall: true,
    });
    expect(output.result.status, output.result.stderr).toBe(0);
    // The kernel the guest just booted is unusable without this package.
    expect(output.calls).toMatch(
      /^apt-get .*install -y --no-install-recommends linux-modules-extra-6\.8\.0-146-generic$/m,
    );
    // The idle kernel would break the next boot, and is one dpkg query away.
    expect(output.calls).toMatch(
      /^apt-get .*install -y --no-install-recommends linux-modules-extra-6\.8\.0-142-generic$/m,
    );
    // linux-image-generic depends on the extras, so later upgrades stay complete.
    expect(output.calls).toMatch(
      /^apt-get .*install -y --no-install-recommends linux-image-generic$/m,
    );
    expect(output.calls).toMatch(/^apt-get .* update$/m);
    expect(output.calls).toContain('depmod -a');
    expect(output.calls).toMatch(/^modprobe qemu_fw_cfg$/m);
    // Package names are matched numerically so the metas are never treated as kernels.
    expect(output.calls).toContain('dpkg-query linux-image-[0-9]*');
  });

  it('installs only the extras a kernel is actually missing', () => {
    const output = repair({
      installedImages: ['linux-image-6.8.0-142-generic', 'linux-image-6.8.0-146-generic'],
      installedPackages: ['linux-modules-extra-6.8.0-142-generic', 'linux-image-generic'],
      running: '6.8.0-146-generic',
      moduleLoadsAfterInstall: true,
    });
    expect(output.result.status, output.result.stderr).toBe(0);
    expect(output.calls).toMatch(
      /^apt-get .*install -y --no-install-recommends linux-modules-extra-6\.8\.0-146-generic$/m,
    );
    expect(output.calls).not.toMatch(
      /--no-install-recommends linux-modules-extra-6\.8\.0-142-generic/,
    );
    expect(output.calls).not.toMatch(/--no-install-recommends linux-image-generic/);
  });

  it('leaves a healthy guest untouched: no package manager, no network, no state change', () => {
    const output = repair({
      installedImages: ['linux-image-6.8.0-142-generic'],
      installedPackages: ['linux-modules-extra-6.8.0-142-generic', 'linux-image-generic'],
      moduleLoads: true,
    });
    expect(output.result.status, output.result.stderr).toBe(0);
    expect(output.calls).not.toMatch(/^apt-get /m);
    expect(output.calls).not.toMatch(/^depmod /m);
    expect(output.calls.match(/^modprobe /gm)).toHaveLength(1);
  });

  it('does not refresh package lists when the caller has already done so', () => {
    const output = repair({
      installedImages: ['linux-image-6.8.0-142-generic'],
      running: '6.8.0-142-generic',
      moduleLoadsAfterInstall: true,
      aptUpdated: true,
    });
    expect(output.result.status, output.result.stderr).toBe(0);
    expect(output.calls).not.toMatch(/^apt-get update\b/m);
    // Extras are asked for twice (running kernel, installed kernel) and installed once.
    expect(
      output.calls.match(/--no-install-recommends linux-modules-extra-6\.8\.0-142-generic/g),
    ).toHaveLength(1);
  });

  it('fails loudly when the module is still unavailable after the repair', () => {
    const output = repair({ aptFails: true, moduleLoads: false });
    expect(output.result.status).toBe(1);
    expect(output.result.stderr).toContain(
      'could not install linux-modules-extra-6.8.0-142-generic',
    );
    expect(output.result.stderr).toContain('qemu_fw_cfg is unavailable');
  });

  it('ships a boot guard ordered ahead of the bridge and display services', () => {
    expect(guestScripts).toContain('kernel-modules.sh');
    expect(guestScripts).toContain('mukai-kernel-guard.service');
    const guard = readFileSync('scripts/guest/mukai-kernel-guard.service', 'utf8');
    expect(guard).toContain('ExecStart=/bin/sh /usr/lib/mukai-guest/kernel-modules.sh');
    expect(guard).toContain('Before=mukai-display.service mukai-guest.service');
    expect(guard).toContain('WantedBy=multi-user.target');
    expect(guard).toContain('ConditionPathExists=/dev/virtio-ports/com.mukai.agent');
    for (const unit of ['mukai-guest.service', 'mukai-display.service']) {
      const text = readFileSync(`scripts/guest/${unit}`, 'utf8');
      expect(text).toContain('mukai-kernel-guard.service');
    }
  });

  it('runs the same check from the image build and from a trusted guest update', () => {
    const installer = readFileSync('scripts/guest/install.sh', 'utf8').replace(/\r\n/g, '\n');
    expect(installer).toContain('MUKAI_APT_UPDATED=1 sh ./kernel-modules.sh');
    expect(installer).not.toContain('linux-modules-extra');
    const protect = readFileSync('scripts/guest/protect.sh', 'utf8').replace(/\r\n/g, '\n');
    expect(protect).toContain(
      'install -o root -g root -m 0755 "$bundle/kernel-modules.sh" /usr/lib/mukai-guest/kernel-modules.sh',
    );
    expect(protect).toMatch(/\/bin\/sh \/usr\/lib\/mukai-guest\/kernel-modules\.sh \|\|/);
    expect(protect).toContain('mukai-kernel-guard.service');
    expect(protect).toContain(
      '/usr/lib/mukai-guest/systemctl enable mukai-guest.service mukai-display.service mukai-desktop.service mukai-kernel-guard.service',
    );
  });
});
