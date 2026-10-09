export const guestScripts = [
  'install.sh',
  'browser-start.sh',
  'protect.sh',
  'resilience.sh',
  'systemctl-guard.sh',
  'mukai-guest.service',
  'desktop-prepare.sh',
  'desktop-start.sh',
  'mukai-display.service',
  'mukai-desktop.service',
];
export const guestDesktopFiles = ['linux.py', 'linux_wayland.py'];
export const guestFiles = [
  'guest.cjs',
  'guest-worker.cjs',
  'package.json',
  ...guestScripts,
  ...guestDesktopFiles,
];
