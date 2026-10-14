import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { installWindowsQemu, WINDOWS_QEMU_INSTALLER } from './windowsQemu';
import { setupProcess } from './setupProcess';
import { downloadVerifiedFile } from './setupDownload';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  access: vi.fn(),
}));
vi.mock('./setupProcess', () => ({ setupProcess: vi.fn() }));
vi.mock('./setupDownload', () => ({ downloadVerifiedFile: vi.fn() }));

let directory: string;
let allowed: Set<string>;
let controller: AbortController;
const output = vi.fn();
const phase = vi.fn<(message: string) => Promise<void>>().mockResolvedValue(undefined);
const run = () => installWindowsQemu(directory, controller.signal, output, phase);
const alias = () => win32.join(process.env.LOCALAPPDATA!, 'Microsoft', 'WindowsApps', 'winget.exe');
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mukai-qemu-'-$-"));
  controller = new AbortController();
  allowed = new Set();
  vi.stubEnv('PATH', '');
  vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\VM User\\AppData\\Local');
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  vi.mocked(access).mockImplementation(async (path) => {
    if (!allowed.has(String(path))) throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
  });
  vi.mocked(setupProcess).mockResolvedValue({ code: 0, output: 'v1.12' });
  vi.mocked(downloadVerifiedFile).mockImplementation(
    async (_url, path, _hash, _signal, progress) => {
      await writeFile(path, 'verified installer fixture');
      progress(100, 100);
    },
  );
});
afterEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('Windows QEMU installation', () => {
  it('finds a working WindowsApps alias outside PATH and retains package-manager installation', async () => {
    allowed.add(alias());
    await run();
    expect(setupProcess).toHaveBeenCalledWith(
      alias(),
      ['--version'],
      controller.signal,
      undefined,
      undefined,
      10000,
    );
    expect(vi.mocked(setupProcess).mock.calls[1][1]).toEqual(
      expect.arrayContaining(['install', '--id', 'SoftwareFreedomConservancy.QEMU']),
    );
    expect(downloadVerifiedFile).not.toHaveBeenCalled();
  });
  it('resolves quoted PATH entries before the WindowsApps alias', async () => {
    vi.stubEnv('PATH', '"C:\\Tools With Spaces";C:\\Tools');
    const binary = 'C:\\Tools With Spaces\\winget.exe';
    allowed.add(binary);
    allowed.add(alias());
    await run();
    expect(vi.mocked(setupProcess).mock.calls.map(([path]) => path)).toEqual([binary, binary]);
  });
  it('derives WindowsApps from USERPROFILE when LOCALAPPDATA is absent', async () => {
    vi.stubEnv('LOCALAPPDATA', '');
    vi.stubEnv('USERPROFILE', 'C:\\Users\\Other User');
    const binary = 'C:\\Users\\Other User\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe';
    allowed.add(binary);
    await run();
    expect(vi.mocked(setupProcess).mock.calls[0][0]).toBe(binary);
  });
  it('downloads the pinned installer when WinGet is missing, then requests UAC and cleans up', async () => {
    await run();
    expect(downloadVerifiedFile).toHaveBeenCalledWith(
      WINDOWS_QEMU_INSTALLER.url,
      expect.stringContaining('qemu-setup.exe'),
      WINDOWS_QEMU_INSTALLER.sha256,
      controller.signal,
      expect.any(Function),
      { label: 'QEMU installer', maxBytes: 512 * 1024 ** 2 },
    );
    expect(setupProcess).toHaveBeenCalledOnce();
    const [binary, args] = vi.mocked(setupProcess).mock.calls[0];
    expect(binary).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString(
      'utf16le',
    );
    expect(script).toContain('-Verb RunAs -WindowStyle Hidden -Wait -PassThru');
    expect(script).toContain("-ArgumentList '/S'");
    const installer = vi.mocked(downloadVerifiedFile).mock.calls[0][1];
    expect(script).toContain("-FilePath '" + installer.replace(/'/g, "''") + "'");
    expect(phase).toHaveBeenCalledWith(expect.stringContaining('administrator prompt'));
    expect(await readdir(directory)).toEqual([]);
  });
  it.each(['broken alias', 'missing executable'])('falls back for a %s', async (reason) => {
    allowed.add(alias());
    if (reason === 'broken alias')
      vi.mocked(setupProcess).mockResolvedValueOnce({ code: 1, output: 'Not registered' });
    else
      vi.mocked(setupProcess).mockRejectedValueOnce(
        Object.assign(new Error('Missing'), { code: 'ENOENT' }),
      );
    await run();
    expect(downloadVerifiedFile).toHaveBeenCalledOnce();
  });
  it('falls back if the alias disappears between discovery and installation', async () => {
    allowed.add(alias());
    vi.mocked(setupProcess)
      .mockResolvedValueOnce({ code: 0, output: 'v1' })
      .mockRejectedValueOnce(Object.assign(new Error('Missing'), { code: 'ENOENT' }));
    await run();
    expect(downloadVerifiedFile).toHaveBeenCalledOnce();
  });
  it('preserves WinGet installation failures instead of retrying through another installer', async () => {
    allowed.add(alias());
    vi.mocked(setupProcess)
      .mockResolvedValueOnce({ code: 0, output: 'v1' })
      .mockResolvedValueOnce({ code: 1, output: 'Installation denied by policy' });
    await expect(run()).rejects.toThrow('Installation denied by policy');
    expect(downloadVerifiedFile).not.toHaveBeenCalled();
  });
  it.each(['checksum did not match', 'download failed (503)'])(
    'never runs an installer when its %s',
    async (message) => {
      vi.mocked(downloadVerifiedFile).mockRejectedValueOnce(new Error(`QEMU installer ${message}`));
      await expect(run()).rejects.toThrow('Install QEMU for Windows');
      expect(setupProcess).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    },
  );
  it('reports declined administrator approval with a retry instruction', async () => {
    vi.mocked(setupProcess).mockResolvedValueOnce({ code: 1223, output: '' });
    await expect(run()).rejects.toThrow('Retry setup and approve');
    expect(await readdir(directory)).toEqual([]);
  });
  it.skipIf(process.platform !== 'win32').each([
    ['declined approval', 'throw [System.ComponentModel.Win32Exception]::new(1223)', 1223],
    [
      'wrapped declined approval',
      "throw [System.InvalidOperationException]::new('Approval declined', [System.ComponentModel.Win32Exception]::new(1223))",
      1223,
    ],
    ['installer exit code', 'return [pscustomobject]@{ ExitCode = 7 }', 7],
  ])('handles %s in real PowerShell without running an installer', async (name, body, code) => {
    await run();
    const [binary, args] = vi.mocked(setupProcess).mock.calls[0];
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString(
      'utf16le',
    );
    const simulated = `function Start-Process { ${body} }\n${script}`;
    const actual = await vi.importActual<typeof import('./setupProcess')>('./setupProcess');
    const result = await actual.setupProcess(
      binary,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(simulated, 'utf16le').toString('base64'),
      ],
      controller.signal,
      undefined,
      undefined,
      10000,
    );
    expect(result.code, String(name)).toBe(code);
  });
  it('preserves direct installer errors and gives manual recovery instructions', async () => {
    vi.mocked(setupProcess).mockResolvedValueOnce({ code: 1, output: 'Access denied' });
    await expect(run()).rejects.toThrow('Access denied');
    expect(await readdir(directory)).toEqual([]);
  });
  it('does not fall back when cancellation interrupts discovery', async () => {
    allowed.add(alias());
    vi.mocked(setupProcess).mockImplementationOnce(async () => {
      controller.abort(new Error('Cancelled'));
      throw new Error('Interrupted');
    });
    await expect(run()).rejects.toThrow('Cancelled');
    expect(downloadVerifiedFile).not.toHaveBeenCalled();
  });
  it('never launches the installer if cancelled after downloading', async () => {
    vi.mocked(downloadVerifiedFile).mockImplementationOnce(async () => {
      controller.abort(new Error('Cancelled'));
    });
    await expect(run()).rejects.toThrow('Cancelled');
    expect(setupProcess).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
});
