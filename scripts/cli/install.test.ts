import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const installer = readFileSync('installers/install.sh', 'utf8').replace(/\r\n/g, '\n');
const dependencyFunction = installer.match(/install_linux_vm_dependencies\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(dependencyFunction);
const kvmFunction = installer.match(/configure_linux_kvm\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(kvmFunction);
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const skip = process.platform === 'win32' && !existsSync(bash);

function run(
  options: Record<string, string | undefined> = {},
  entry = 'install_linux_vm_dependencies',
) {
  // Run the installer's actual shell function with fake package/admin commands.
  // No test can invoke the host's package manager or elevate privileges.
  return spawnSync(bash, [], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    env: {
      ...process.env,
      MUKAI_SKIP_VM_DEPS: '',
      TEST_PLATFORM: 'linux',
      TEST_UID: '1000',
      TEST_QEMU: '0',
      TEST_IMAGE: '0',
      TEST_APT: '1',
      TEST_SUDO: '1',
      TEST_AUTH: '1',
      TEST_FAIL: '',
      TEST_INSTALLS: '1',
      TEST_DEVICE: '0',
      TEST_DEVICE_ACCESS: '0',
      TEST_DEVICE_GROUP: 'kvm',
      TEST_GROUPS: 'users',
      TEST_GRANT: '1',
      ...options,
    },
    input: `set -euo pipefail
platform="$TEST_PLATFORM"
command() {
  if [[ "$1" == -v ]]; then
    case "$2" in
      qemu-system-x86_64) [[ "$TEST_QEMU" == 1 ]]; return ;;
      qemu-img) [[ "$TEST_IMAGE" == 1 ]]; return ;;
      apt-get) [[ "$TEST_APT" == 1 ]]; return ;;
      sudo) [[ "$TEST_SUDO" == 1 ]]; return ;;
    esac
  fi
  builtin command "$@"
}
id() {
  case "$1" in
    -u) echo "$TEST_UID" ;;
    -un) echo 'server-user' ;;
    -nG) echo "$TEST_GROUPS" ;;
    *) return 1 ;;
  esac
}
test() {
  if [[ "$2" == /dev/kvm ]]; then
    case "$1" in
      -c) [[ "$TEST_DEVICE" == 1 ]]; return ;;
      -r|-w) [[ "$TEST_DEVICE_ACCESS" == 1 ]]; return ;;
    esac
  fi
  builtin test "$@"
}
stat() { echo "$TEST_DEVICE_GROUP"; }
usermod() { echo "CALL usermod $*"; [[ "$TEST_GRANT" == 1 ]]; }
sudo() {
  echo "CALL sudo $*"
  [[ "$*" != '-n true' ]] || return "$((1 - TEST_AUTH))"
  [[ "$1" != -v ]] || return 1
  shift
  "$@"
}
apt-get() {
  echo "CALL apt-get $*"
  [[ "$TEST_FAIL" != "$1" ]] || return 1
  if [[ "$1" == install && "$TEST_INSTALLS" == 1 ]]; then TEST_QEMU=1; TEST_IMAGE=1; fi
}
${dependencyFunction}
${kvmFunction}
${entry}
echo COMPLETE
`,
  });
}

test('shell installer syntax is valid', { skip }, () => {
  const result = spawnSync(bash, ['-n'], { input: installer, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('KVM access is configured even when QEMU is already installed', { skip }, () => {
  const result = run(
    { TEST_QEMU: '1', TEST_IMAGE: '1', TEST_DEVICE: '1' },
    'install_linux_vm_dependencies\nconfigure_linux_kvm',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /CALL apt-get/);
  assert.match(result.stdout, /CALL sudo -n usermod -a -G kvm -- server-user/);
  assert.match(result.stderr, /Log out and back in/);
});

test(
  'KVM access checks skip unnecessary approval and never add an unrelated device group',
  { skip },
  () => {
    for (const options of [
      { TEST_DEVICE: '1', TEST_DEVICE_ACCESS: '1' },
      { TEST_DEVICE: '1', TEST_GROUPS: 'users kvm' },
      { TEST_DEVICE: '1', TEST_DEVICE_GROUP: 'root' },
      { TEST_DEVICE: '1', TEST_UID: '0' },
      { TEST_DEVICE: '0' },
      { TEST_DEVICE: '1', MUKAI_SKIP_VM_DEPS: '1' },
      { TEST_DEVICE: '1', TEST_PLATFORM: 'darwin' },
    ]) {
      const result = run(options, 'configure_linux_kvm');
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /CALL sudo|CALL usermod/);
    }
  },
);

test(
  'KVM approval and permission failures allow installation with a software fallback notice',
  { skip },
  () => {
    for (const options of [{ TEST_SUDO: '0' }, { TEST_AUTH: '0' }, { TEST_GRANT: '0' }]) {
      const result = run({ TEST_DEVICE: '1', ...options }, 'configure_linux_kvm');
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /slower software emulation/);
      assert.match(result.stdout, /COMPLETE/);
    }
  },
);

test(
  'Linux installer elevates only package commands and installs both VM dependencies',
  { skip },
  () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CALL sudo -n apt-get update/);
    assert.match(result.stdout, /CALL sudo -n apt-get install -y qemu-system-x86 qemu-utils/);
    assert.match(result.stdout, /COMPLETE/);
  },
);

test('existing QEMU, explicit opt-out, and macOS skip package installation', { skip }, () => {
  for (const options of [
    { TEST_QEMU: '1', TEST_IMAGE: '1' },
    { MUKAI_SKIP_VM_DEPS: '1' },
    { TEST_PLATFORM: 'darwin' },
  ]) {
    const result = run(options);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CALL/);
  }
});

test('missing qemu-img still installs qemu-utils', { skip }, () => {
  const result = run({ TEST_QEMU: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /apt-get install -y qemu-system-x86 qemu-utils/);
});

test('root provisioning runs packages directly without sudo', { skip }, () => {
  const result = run({ TEST_UID: '0', TEST_SUDO: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CALL apt-get install/);
  assert.doesNotMatch(result.stdout, /CALL sudo/);
});

test('unsupported package managers leave an actionable manual instruction', { skip }, () => {
  const result = run({ TEST_APT: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Install QEMU with your Linux package manager/);
  assert.doesNotMatch(result.stdout, /CALL/);
});

test('missing sudo fails clearly before running any package commands', { skip }, () => {
  const result = run({ TEST_SUDO: '0' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Install it as an administrator/);
  assert.doesNotMatch(result.stdout, /CALL apt-get|COMPLETE/);
});

test('unavailable administrator approval cannot run package commands', { skip }, () => {
  const result = run({ TEST_AUTH: '0' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Rerun from an interactive terminal|Administrator approval failed/);
  assert.doesNotMatch(result.stdout, /CALL apt-get|COMPLETE/);
});

test(
  'package failures and missing installed binaries prevent successful completion',
  { skip },
  () => {
    for (const options of [
      { TEST_FAIL: 'update' },
      { TEST_FAIL: 'install' },
      { TEST_INSTALLS: '0' },
    ]) {
      const result = run(options);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /QEMU installation (failed|finished)/);
      assert.doesNotMatch(result.stdout, /COMPLETE/);
      if (options.TEST_FAIL === 'update')
        assert.doesNotMatch(result.stdout, /CALL apt-get install/);
    }
  },
);
