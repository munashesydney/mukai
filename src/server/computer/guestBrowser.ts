import { arch, platform } from 'node:os';

/** Only Linux ARM guests use the managed Chromium build; host Chrome stays unchanged. */
export function guestBrowserExecutable() {
  return platform() === 'linux' && arch() === 'arm64' ? '/usr/local/bin/mukai-browser' : undefined;
}
