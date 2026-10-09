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
install -d -o root -g root -m 0755 /etc/polkit-1/rules.d
cat > /etc/polkit-1/rules.d/00-mukai-power.rules <<'RULES'
polkit.addRule(function(action, subject) {
  if (subject.user === 'mukai' && /^org\.freedesktop\.login1\.(power-off|reboot|halt|suspend|hibernate|hybrid-sleep)/.test(action.id)) {
    return polkit.Result.NO;
  }
});
RULES
install -d -o root -g root -m 0755 /opt/mukai-guest/bridge /usr/lib/mukai-guest
install -o root -g root -m 0644 "$bundle/guest.cjs" "$bundle/guest-worker.cjs" /opt/mukai-guest/bridge/
install -o root -g root -m 0755 "$bundle/desktop-prepare.sh" "$bundle/desktop-start.sh" /opt/mukai-guest/bridge/
if ! dpkg-divert --list /usr/bin/systemctl | grep -q /usr/lib/mukai-guest/systemctl; then
  dpkg-divert --local --add --rename --divert /usr/lib/mukai-guest/systemctl /usr/bin/systemctl
fi
install -o root -g root -m 0755 "$bundle/systemctl-guard.sh" /usr/bin/systemctl
install -o root -g root -m 0755 "$bundle/resilience.sh" /usr/lib/mukai-guest/resilience.sh
/bin/sh /usr/lib/mukai-guest/resilience.sh
# No policy change to sudo: ordinary administration remains available.
install -o root -g root -m 0644 "$bundle/mukai-guest.service" /etc/systemd/system/mukai-guest.service
install -o root -g root -m 0644 "$bundle/mukai-display.service" "$bundle/mukai-desktop.service" /etc/systemd/system/
/usr/lib/mukai-guest/systemctl daemon-reload
/usr/lib/mukai-guest/systemctl enable mukai-guest.service mukai-display.service mukai-desktop.service
