export const guestScripts = [
  'install.sh',
  'protect.sh',
  'systemctl-guard.sh',
  'mukai-guest.service',
  'desktop-prepare.sh',
  'desktop-start.sh',
  'mukai-display.service',
  'mukai-desktop.service',
];
export const guestFiles = ['guest.cjs', 'guest-worker.cjs', 'package.json', ...guestScripts];
