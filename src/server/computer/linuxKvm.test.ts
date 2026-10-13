import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareLinuxKvm } from './linuxKvm';
import { setupProcess } from './setupProcess';

const system = vi.hoisted(() => ({
  present: true,
  readable: false,
  character: true,
  gid: 108,
  mode: 0o660,
  cpu: '',
  groups: 'users',
  grant: false,
  privilegedCode: 0,
  executables: new Set<string>(),
}));
vi.mock('node:os', () => ({ userInfo: () => ({ username: 'server-user', uid: 1000 }) }));
vi.mock('node:fs/promises', () => ({
  access: vi.fn(async (path: string) => {
    if (path === '/dev/kvm' ? system.present && system.readable : system.executables.has(path))
      return;
    throw new Error('Access unavailable');
  }),
  readFile: vi.fn(async () => system.cpu),
  stat: vi.fn(async () => {
    if (!system.present) throw new Error('ENOENT');
    return { gid: system.gid, mode: system.mode, isCharacterDevice: () => system.character };
  }),
}));
vi.mock('./setupProcess', () => ({ setupProcess: vi.fn() }));
const output = vi.fn();
beforeEach(() => {
  Object.assign(system, {
    present: true,
    readable: false,
    character: true,
    gid: 108,
    mode: 0o660,
    cpu: '',
    groups: 'users',
    grant: false,
    privilegedCode: 0,
    executables: new Set([
      '/usr/bin/getent',
      '/usr/bin/id',
      '/usr/sbin/usermod',
      '/usr/bin/sudo',
      '/usr/bin/pkexec',
      '/usr/sbin/modprobe',
    ]),
  });
  if (process.getuid) vi.spyOn(process, 'getuid').mockReturnValue(1000);
  vi.mocked(setupProcess).mockImplementation(async (binary, args, signal) => {
    signal.throwIfAborted();
    if (binary.endsWith('/getent')) return { code: 0, output: 'kvm:x:108:\n' };
    if (binary.endsWith('/id')) return { code: 0, output: system.groups };
    if (system.privilegedCode === 0 && system.grant) {
      system.present = true;
      system.readable = true;
    }
    return {
      code: system.privilegedCode,
      output: args.includes('kvm_intel') ? 'module result' : '',
    };
  });
});
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('Linux KVM prerequisites', () => {
  it('leaves an accessible KVM device alone', async () => {
    system.readable = true;
    expect(await prepareLinuxKvm(new AbortController().signal, output)).toBeUndefined();
    expect(setupProcess).not.toHaveBeenCalled();
  });
  it('detects hosts without virtualization and does not ask for administrator access', async () => {
    system.present = false;
    expect(await prepareLinuxKvm(new AbortController().signal, output)).toContain(
      'Hardware virtualization is unavailable',
    );
    expect(setupProcess).not.toHaveBeenCalled();
  });
  it.each(['vmx', 'svm'])('loads only the matching KVM module for %s CPUs', async (flag) => {
    system.present = false;
    system.cpu = `flags : sse ${flag} xsave\n`;
    system.grant = true;
    expect(await prepareLinuxKvm(new AbortController().signal, output)).toBeUndefined();
    expect(setupProcess).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      ['-n', '/usr/sbin/modprobe', flag === 'vmx' ? 'kvm_intel' : 'kvm_amd'],
      expect.any(AbortSignal),
      '',
      output,
      60000,
    );
  });
  it('appends only kvm membership and explains why the current login still lacks access', async () => {
    expect(await prepareLinuxKvm(new AbortController().signal, output)).toContain(
      'Log out and back in',
    );
    expect(setupProcess).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      ['-n', '/usr/sbin/usermod', '-a', '-G', 'kvm', '--', 'server-user'],
      expect.any(AbortSignal),
      '',
      output,
      60000,
    );
  });
  it('does not repeat administrator approval for membership already granted', async () => {
    system.groups = 'users kvm';
    expect(await prepareLinuxKvm(new AbortController().signal, output)).toContain(
      'Log out and back in',
    );
    expect(setupProcess).not.toHaveBeenCalledWith(
      '/usr/bin/sudo',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
  it('uses graphical approval without an unusable textual password prompt', async () => {
    system.privilegedCode = 1;
    expect(await prepareLinuxKvm(new AbortController().signal, output)).toContain(
      'could not be granted',
    );
    expect(setupProcess).toHaveBeenCalledWith(
      '/usr/bin/pkexec',
      ['--disable-internal-agent', '/usr/sbin/usermod', '-a', '-G', 'kvm', '--', 'server-user'],
      expect.any(AbortSignal),
      '',
      output,
      60000,
    );
  });
  it('allows fallback on headless hosts with no available approval mechanism', async () => {
    system.executables.delete('/usr/bin/sudo');
    system.executables.delete('/usr/bin/pkexec');
    expect(await prepareLinuxKvm(new AbortController().signal, output)).toContain(
      'could not be granted',
    );
    expect(setupProcess).toHaveBeenCalledTimes(2);
  });
  it.skipIf(!process.getuid)(
    'does not change root membership when the host restricts device access',
    async () => {
      if (process.getuid) vi.mocked(process.getuid).mockReturnValue(0);
      expect(await prepareLinuxKvm(new AbortController().signal, output)).toContain(
        'even for root',
      );
      expect(setupProcess).not.toHaveBeenCalled();
    },
  );
  it.each([{ gid: 0 }, { gid: 999 }, { mode: 0o600 }, { character: false }])(
    'does not broaden unsafe device permissions: %j',
    async (change) => {
      Object.assign(system, change);
      await prepareLinuxKvm(new AbortController().signal, output);
      expect(setupProcess).not.toHaveBeenCalledWith(
        '/usr/bin/sudo',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    },
  );
  it('does not swallow cancellation or continue granting permissions', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Cancelled'));
    await expect(prepareLinuxKvm(controller.signal, output)).rejects.toThrow('Cancelled');
    expect(setupProcess).not.toHaveBeenCalled();
  });
});
