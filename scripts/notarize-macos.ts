import { notarize } from '@electron/notarize';
import type { AfterPackContext } from 'app-builder-lib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { join } from 'node:path';

interface ReleaseNotarization {
  appPath: string;
  appleId: string;
  appleIdPassword: string;
  teamId: string;
}
interface Operations {
  notarize: (options: ReleaseNotarization) => Promise<void>;
  staple: (path: string) => Promise<void>;
  pause: (milliseconds: number) => Promise<void>;
  log: (message: string) => void;
}
const execute = promisify(execFile);
const operations: Operations = {
  notarize,
  staple: async (appPath) => {
    await execute('xcrun', ['stapler', 'staple', appPath], { timeout: 60_000 });
  },
  pause,
  log: console.log,
};
function transientTicketFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
  const output = [failure.message, failure.stdout, failure.stderr].filter(Boolean).join('\n');
  const ticketFailure =
    failure.code === 68 || /Failed to staple your application with code: 68\b/.test(output);
  return (
    ticketFailure && /NSURLErrorDomain|network connection|could not connect|timed out/i.test(output)
  );
}

/** Retry ticket attachment to the same accepted bundle, without signing or submitting it again. */
export async function notarizeWithTicketRetry(options: ReleaseNotarization, tools = operations) {
  try {
    await tools.notarize(options);
    return;
  } catch (error) {
    // @electron/notarize staples only after notarytool reports Accepted.
    // Authentication errors and Apple's rejection of a bundle must remain fatal.
    if (!transientTicketFailure(error)) throw error;
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    tools.log(
      `Apple accepted the app; retrying ticket attachment in ${attempt * 10}s (${attempt}/5).`,
    );
    await tools.pause(attempt * 10_000);
    try {
      await tools.staple(options.appPath);
      tools.log('Apple notarization ticket attached successfully.');
      return;
    } catch (error) {
      if (attempt === 5 || !transientTicketFailure(error)) throw error;
    }
  }
}

/** electron-builder afterSign hook: complete notarization before DMG creation. */
export default async function notarizeRelease(context: AfterPackContext) {
  if (context.electronPlatformName !== 'darwin') return;
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Missing ${name} for macOS notarization.`);
    return value;
  };
  await notarizeWithTicketRetry({
    appPath: join(context.appOutDir, context.packager.appInfo.productFilename + '.app'),
    appleId: required('APPLE_ID'),
    appleIdPassword: required('APPLE_APP_SPECIFIC_PASSWORD'),
    teamId: required('APPLE_TEAM_ID'),
  });
}
