#!/bin/sh
set -eu
# Wait for X before allowing the guest tool service to advertise readiness.
attempt=0
until xdpyinfo -display :0 >/dev/null 2>&1; do
  attempt=$((attempt+1))
  [ "$attempt" -lt 100 ] || { echo 'Desktop display did not become ready.' >&2; exit 1; }
  sleep 0.2
done
if [ "${1:-}" = '--wait' ]; then exit 0; fi
exec dbus-run-session -- startxfce4
