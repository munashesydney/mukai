import { access, mkdtemp, rm } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { setupProcess } from './setupProcess';
import { downloadVerifiedFile } from './setupDownload';

// Pinned x64 installer and SHA-256 from Microsoft's community WinGet manifest:
// https://github.com/microsoft/winget-pkgs/blob/master/manifests/s/SoftwareFreedomConservancy/QEMU/11.1.0/SoftwareFreedomConservancy.QEMU.installer.yaml
export const WINDOWS_QEMU_INSTALLER = {
  version: '11.1.0',
  url: 'https://qemu.weilnetz.de/w64/2026/qemu-w64-setup-20260811.exe',
  sha256: 'f98a8aeb5f7faea9765b6dee28316c266cd179d80354a2fed8e50176f9a2e59f',
} as const;

const recovery =
  'Install QEMU for Windows from https://www.qemu.org/download/#windows, then restart Mukai and retry VM setup. If you use a custom installation folder, set MUKAI_QEMU_BINARY to its qemu-system-x86_64.exe path.';
const psLiteral = (value: string) => "'" + value.replace(/'/g, "''") + "'";

/** App execution aliases may be available even when the app inherited an old PATH. */
async function findWinget(signal: AbortSignal, output: (text: string) => void) {
  const local =
    process.env.LOCALAPPDATA ||
    (process.env.USERPROFILE && win32.join(process.env.USERPROFILE, 'AppData', 'Local'));
  const candidates = [
    ...String(process.env.PATH || '')
      .split(';')
      .map((folder) => folder.trim().replace(/^"(.*)"$/, '$1'))
      .filter(Boolean)
      .map((folder) => win32.join(folder, 'winget.exe')),
    ...(local ? [win32.join(local, 'Microsoft', 'WindowsApps', 'winget.exe')] : []),
  ];
  for (const path of new Set(candidates)) {
    signal.throwIfAborted();
    try {
      await access(path);
      const probe = await setupProcess(path, ['--version'], signal, undefined, undefined, 10000);
      signal.throwIfAborted();
      if (probe.code === 0) return path;
      output(`WinGet is unavailable (exit ${probe.code}). ${probe.output.slice(-800)}\n`);
    } catch (error) {
      signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        output(`WinGet could not start: ${(error as Error).message}\n`);
    }
  }
}

/** Only fall back when WinGet is unavailable, not after an installer/policy failure. */
export async function installWindowsQemu(
  root: string,
  signal: AbortSignal,
  output: (text: string) => void,
  phase: (message: string) => Promise<void>,
) {
  const winget = await findWinget(signal, output);
  if (winget) {
    await phase(
      'Installing QEMU with Windows Package Manager. Approve the Windows prompt if shown.',
    );
    try {
      const result = await setupProcess(
        winget,
        [
          'install',
          '--exact',
          '--id',
          'SoftwareFreedomConservancy.QEMU',
          '--source',
          'winget',
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements',
          '--disable-interactivity',
        ],
        signal,
        undefined,
        output,
      );
      signal.throwIfAborted();
      if (result.code !== 0)
        throw new Error(
          `Windows Package Manager could not install QEMU (exit ${result.code}). ${result.output.slice(-1500)} ${recovery}`,
        );
      return;
    } catch (error) {
      signal.throwIfAborted();
      // A removed or unregistered alias can disappear after the version check.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if ((error as Error).message.includes(recovery)) throw error;
        throw new Error(
          `Windows Package Manager could not install QEMU. ${(error as Error).message} ${recovery}`,
        );
      }
      output('WinGet disappeared before installation. Using the QEMU installer instead.\n');
    }
  }
  signal.throwIfAborted();
  await phase('Windows Package Manager is unavailable. Downloading the QEMU installer…');
  const directory = await mkdtemp(join(root, 'qemu-installer-'));
  const installer = join(directory, 'qemu-setup.exe');
  try {
    let lastReportedMiB = -10;
    await downloadVerifiedFile(
      WINDOWS_QEMU_INSTALLER.url,
      installer,
      WINDOWS_QEMU_INSTALLER.sha256,
      signal,
      (bytes, total) => {
        const mib = Math.floor(bytes / 1024 ** 2);
        if (mib < lastReportedMiB + 10 && bytes !== total) return;
        lastReportedMiB = mib;
        output(
          `QEMU installer: ${mib} MiB${total ? ` of ${Math.ceil(total / 1024 ** 2)} MiB` : ''}\n`,
        );
      },
      { label: 'QEMU installer', maxBytes: 512 * 1024 ** 2 },
    );
    signal.throwIfAborted();
    await phase('Installing QEMU. Approve the Windows administrator prompt to continue.');
    // An encoded command and PowerShell literals keep local paths out of shell syntax.
    // NSIS requires elevation. RunAs leaves that approval to Windows' UAC prompt.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `try { $p = Start-Process -FilePath ${psLiteral(installer)} -ArgumentList '/S' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode }`,
      'catch { $e = $_.Exception; while ($e) { if ($e.NativeErrorCode -eq 1223) { exit 1223 }; $e = $e.InnerException }; Write-Output $_.Exception.Message; exit 1 }',
    ].join('\n');
    const powershell = win32.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const result = await setupProcess(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      signal,
      undefined,
      output,
    );
    signal.throwIfAborted();
    if (result.code === 1223)
      throw new Error(
        'QEMU installation was cancelled. Retry setup and approve the Windows administrator prompt.',
      );
    if (result.code !== 0)
      throw new Error(`QEMU installer failed (exit ${result.code}). ${result.output.slice(-1500)}`);
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${recovery}`);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
