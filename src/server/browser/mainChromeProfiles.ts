import { access, lstat, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { ChromeProfile } from '../../shared/runtime';
import { ApiError } from '../config';

/** Chrome's normal launcher filters internal/about URLs; a loopback marker identifies only our new tab. */
export async function profileWindowMarker() {
  const path = '/mukai-profile/' + randomUUID();
  const server = createServer((request, response) => {
    response
      .writeHead(request.url === path ? 200 : 404, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'close',
      })
      .end(request.url === path ? '<!doctype html><title>Preparing Chrome</title>' : '');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// Keep these locations aligned with Playwright's stable Chrome channel discovery.
export function chromeUserDataDirectory() {
  switch (process.platform) {
    case 'win32':
      return join(
        process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
        'Google',
        'Chrome',
        'User Data',
      );
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    case 'linux':
      return join(homedir(), '.config', 'google-chrome');
    default:
      throw new ApiError(
        503,
        'Main Chrome profile discovery is unavailable on this operating system.',
      );
  }
}

const safeId = (id: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,127}$/.test(id) && !id.endsWith('.') && !id.endsWith(' ');
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

async function chromeExecutable() {
  const candidates =
    process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
          .filter((path): path is string => Boolean(path))
          .map((path) => join(path, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            join(
              homedir(),
              'Applications',
              'Google Chrome.app',
              'Contents',
              'MacOS',
              'Google Chrome',
            ),
          ]
        : ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];
  if (process.platform === 'win32') {
    for (const hive of ['HKCU', 'HKLM']) {
      try {
        const { stdout } = await promisify(execFile)(
          'reg.exe',
          [
            'query',
            `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`,
            '/ve',
          ],
          { windowsHide: true, timeout: 3000 },
        );
        const path = stdout.match(/REG_SZ\s+([^\r\n]+)/)?.[1]?.trim();
        if (path) candidates.unshift(path);
      } catch {
        /* Standard installation paths are checked below. */
      }
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try the next installation location. */
    }
  }
  throw new ApiError(
    503,
    'Google Chrome could not be located to open the selected profile. Install stable Google Chrome and retry.',
  );
}

export class MainChromeProfiles {
  constructor(private directory = chromeUserDataDirectory()) {}

  async list(): Promise<ChromeProfile[]> {
    const path = join(this.directory, 'Local State');
    let state: Record<string, unknown> | undefined;
    try {
      if ((await stat(path)).size > 16 * 1024 * 1024)
        throw new Error('Chrome metadata is too large.');
      state = record(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new ApiError(
        503,
        'Chrome profile metadata could not be read. Open Chrome and retry profile discovery.',
      );
    }
    const settings = record(state?.profile);
    const cache = record(settings?.info_cache);
    const profiles = await Promise.all(
      Object.entries(cache || {}).map(async ([id, value]) => {
        const info = record(value);
        if (
          !safeId(id) ||
          !info ||
          info.is_omitted === true ||
          info.is_ephemeral === true ||
          ['Guest Profile', 'System Profile'].includes(id)
        )
          return undefined;
        try {
          // Metadata does not authorize access to arbitrary paths or linked directories.
          const directory = await lstat(join(this.directory, id));
          if (!directory.isDirectory() || directory.isSymbolicLink()) return undefined;
        } catch {
          return undefined;
        }
        return {
          id,
          name: typeof info.name === 'string' ? info.name.slice(0, 200) || id : id,
          lastUsed: settings?.last_used === id,
        };
      }),
    );
    return profiles
      .filter((profile): profile is ChromeProfile => Boolean(profile))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async require(id: string) {
    const profile = (await this.list()).find((profile) => profile.id === id);
    if (!profile)
      throw new ApiError(
        404,
        'Chrome profile not found. Use browser profiles to discover available profile IDs on this computer.',
      );
    return profile;
  }

  async openWindow(profile: ChromeProfile, url: string) {
    // Chrome's normal process singleton routes the window to this existing profile.
    // Do not launch an automation context, copy cookies, or change debugging preferences.
    const executable = await chromeExecutable();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        executable,
        [
          `--user-data-dir=${this.directory}`,
          `--profile-directory=${profile.id}`,
          '--new-window',
          url,
        ],
        {
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }

  async identify(page: Page, expected?: ChromeProfile): Promise<ChromeProfile> {
    await page.goto('chrome://version/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const path = (await page.locator('#profile_path').innerText({ timeout: 10000 })).trim();
    const actual = await realpath(path);
    const root = await realpath(this.directory);
    const id = relative(root, actual);
    if (!safeId(id) || basename(actual) !== id || (expected && id !== expected.id)) {
      throw new ApiError(
        503,
        'Chrome opened a different profile than requested. The tab was closed without visiting the requested site. Retry with a profile ID from browser profiles.',
      );
    }
    return (
      (await this.list()).find((profile) => profile.id === id) || { id, name: id, lastUsed: false }
    );
  }
}
