import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { userInfo } from 'node:os';
import { setupProcess } from './setupProcess';

async function executable(paths: string[]) {
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Try another standard system location.
    }
  }
}

/** Only fixed kernel modules and the current OS user's kvm membership may be changed. */
async function administer(
  binary: string,
  args: string[],
  signal: AbortSignal,
  output: (text: string) => void,
) {
  const run = (command: string, parameters: string[]) =>
    setupProcess(command, parameters, signal, '', output, 60000);
  if (process.getuid?.() === 0) return (await run(binary, args)).code === 0;
  const sudo = await executable(['/usr/bin/sudo']);
  if (sudo && (await run(sudo, ['-n', binary, ...args])).code === 0) return true;
  const pkexec = await executable(['/usr/bin/pkexec']);
  // The setup process has no terminal for a textual password prompt.
  if (pkexec) return (await run(pkexec, ['--disable-internal-agent', binary, ...args])).code === 0;
  return false;
}

/** A best-effort repair. Failure must still allow verified software emulation. */
export async function prepareLinuxKvm(
  signal: AbortSignal,
  output: (text: string) => void,
): Promise<string | undefined> {
  const accessible = () =>
    access('/dev/kvm', constants.R_OK | constants.W_OK).then(
      () => true,
      () => false,
    );
  try {
    signal.throwIfAborted();
    if (await accessible()) return;
    let device = await stat('/dev/kvm').catch(() => undefined);
    if (!device) {
      const cpu = await readFile('/proc/cpuinfo', 'utf8').catch(() => '');
      const flags = cpu
        .split('\n')
        .filter((line) => /^flags\s*:/.test(line))
        .join(' ');
      const module = /\bvmx\b/.test(flags) ? 'kvm_intel' : /\bsvm\b/.test(flags) ? 'kvm_amd' : '';
      const modprobe = module && (await executable(['/usr/sbin/modprobe', '/sbin/modprobe']));
      if (modprobe) {
        output('Enabling the Linux KVM kernel module. Administrator approval may be requested.\n');
        await administer(modprobe, [module], signal, output);
        if (await accessible()) return;
        device = await stat('/dev/kvm').catch(() => undefined);
      }
      if (!device)
        return 'Hardware virtualization is unavailable. Your host may need virtualization or nested virtualization enabled.';
    }
    if (!device.isCharacterDevice()) return '/dev/kvm is not a KVM device.';
    if (await accessible()) return;
    if (process.getuid?.() === 0)
      return 'The host restricts access to /dev/kvm even for root. Check container or hypervisor device access.';
    const getent = await executable(['/usr/bin/getent']);
    const group =
      getent && (await setupProcess(getent, ['group', 'kvm'], signal, '', undefined, 10000));
    const fields = group && group.code === 0 ? group.output.trim().split(':') : [];
    // Never grant membership of root or an unrelated device-owning group.
    if (
      fields[0] !== 'kvm' ||
      Number(fields[2]) !== device.gid ||
      device.gid === 0 ||
      (device.mode & 0o060) !== 0o060
    )
      return 'Your user cannot access /dev/kvm. Its device permissions need administrator attention.';
    const username = userInfo().username;
    const id = await executable(['/usr/bin/id']);
    const groups =
      id && (await setupProcess(id, ['-nG', '--', username], signal, '', undefined, 10000));
    const loginNotice = 'Log out and back in, then restart Mukai to activate KVM access.';
    if (groups && groups.code === 0 && groups.output.trim().split(/\s+/).includes('kvm'))
      return loginNotice;
    const usermod = await executable(['/usr/sbin/usermod', '/sbin/usermod']);
    if (usermod) {
      output('Granting your OS user access to KVM. Administrator approval may be requested.\n');
      if (await administer(usermod, ['-a', '-G', 'kvm', '--', username], signal, output)) {
        if (await accessible()) return;
        return loginNotice;
      }
    }
    return 'KVM access could not be granted. An administrator can add your OS user to the kvm group; log in again afterward.';
  } catch (error) {
    signal.throwIfAborted();
    output(
      `KVM repair could not complete: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 'KVM access could not be repaired automatically.';
  }
}
