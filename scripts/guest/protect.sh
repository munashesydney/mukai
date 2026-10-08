#!/bin/sh
# Trusted app update, run as root INSIDE the guest. Does not restart the bridge.
set -eu
[ "$(id -u)" = 0 ] || exit 1
bundle=$(realpath "${1:?Missing guest bundle}")
install -d -o root -g root -m 0755 /opt/mukai-guest/bridge /usr/lib/mukai-guest
install -o root -g root -m 0644 "$bundle/guest.cjs" "$bundle/guest-worker.cjs" /opt/mukai-guest/bridge/
if ! dpkg-divert --list /usr/bin/systemctl | grep -q /usr/lib/mukai-guest/systemctl; then
  dpkg-divert --local --add --rename --divert /usr/lib/mukai-guest/systemctl /usr/bin/systemctl
fi
install -o root -g root -m 0755 "$bundle/systemctl-guard.sh" /usr/bin/systemctl
# No policy change to sudo: ordinary administration remains available.
install -o root -g root -m 0644 "$bundle/mukai-guest.service" /etc/systemd/system/mukai-guest.service
/usr/lib/mukai-guest/systemctl daemon-reload
/usr/lib/mukai-guest/systemctl enable mukai-guest.service
