#!/bin/sh
# Trusted app update, run as root INSIDE the guest. Does not restart the bridge.
set -eu
[ "$(id -u)" = 0 ] || exit 1
bundle=$(realpath "${1:?Missing guest bundle}")
if ! command -v Xtigervnc >/dev/null 2>&1 || ! command -v startxfce4 >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends tigervnc-standalone-server tigervnc-tools xfce4 xfce4-terminal dbus-x11 x11-utils fonts-dejavu-core polkitd
fi
if ! python3 -c 'import ctypes; ctypes.CDLL("libX11.so.6"); ctypes.CDLL("libXtst.so.6"); ctypes.CDLL("libXrandr.so.2")' >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends python3 libx11-6 libxtst6 libxrandr2
fi
install -d -o root -g root -m 0755 /etc/polkit-1/rules.d
cat > /etc/polkit-1/rules.d/00-mukai-power.rules <<'RULES'
polkit.addRule(function(action, subject) {
  if (subject.user === 'mukai' && /^org\.freedesktop\.login1\.(power-off|reboot|halt|suspend|hibernate|hybrid-sleep)/.test(action.id)) {
    return polkit.Result.NO;
  }
});
RULES
install -d -o root -g root -m 0755 /opt/mukai-guest/bridge /usr/lib/mukai-guest
if ! cmp -s "$bundle/package.json" /opt/mukai-guest/package.json ||
   ! /usr/local/bin/node -e 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(require("/opt/mukai-guest/node_modules/esbuild").version!==p.dependencies.esbuild)process.exit(1)' "$bundle/package.json"; then
  install -o root -g root -m 0644 "$bundle/package.json" /opt/mukai-guest/package.json
  (cd /opt/mukai-guest; /usr/local/bin/npm install --omit=dev)
fi
install -o root -g root -m 0644 "$bundle/guest.cjs" "$bundle/guest-worker.cjs" /opt/mukai-guest/bridge/
install -o root -g root -m 0644 "$bundle/linux.py" "$bundle/linux_wayland.py" /opt/mukai-guest/bridge/
install -o root -g root -m 0755 "$bundle/desktop-prepare.sh" "$bundle/desktop-start.sh" /opt/mukai-guest/bridge/
if ! dpkg-divert --list /usr/bin/systemctl | grep -q /usr/lib/mukai-guest/systemctl; then
  dpkg-divert --local --add --rename --divert /usr/lib/mukai-guest/systemctl /usr/bin/systemctl
fi
install -o root -g root -m 0755 "$bundle/systemctl-guard.sh" /usr/bin/systemctl
install -o root -g root -m 0755 "$bundle/resilience.sh" /usr/lib/mukai-guest/resilience.sh
/bin/sh /usr/lib/mukai-guest/resilience.sh
install -o root -g root -m 0755 "$bundle/kernel-modules.sh" /usr/lib/mukai-guest/kernel-modules.sh
# Repair kernel module drift before the controlled reboot. An upgrade that
# installed a kernel without linux-modules-extra would otherwise boot a guest
# whose services cannot read the boot identity. Best effort by design: the boot
# guard retries, and failing the update would not make the guest any safer.
/bin/sh /usr/lib/mukai-guest/kernel-modules.sh ||
  echo 'Mukai guest update: kernel module repair deferred to boot.' >&2
# No policy change to sudo: ordinary administration remains available.
install -o root -g root -m 0644 "$bundle/mukai-guest.service" /etc/systemd/system/mukai-guest.service
install -o root -g root -m 0644 "$bundle/mukai-display.service" "$bundle/mukai-desktop.service" "$bundle/mukai-kernel-guard.service" /etc/systemd/system/
/usr/lib/mukai-guest/systemctl daemon-reload
/usr/lib/mukai-guest/systemctl enable mukai-guest.service mukai-display.service mukai-desktop.service mukai-kernel-guard.service
