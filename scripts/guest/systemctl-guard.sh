#!/bin/sh
# Accidental lifecycle protection. Root can deliberately bypass this wrapper.
deny() { echo 'Mukai manages this VM and its guest bridge. Use the workspace controls for power operations.' >&2; exit 1; }
case "${0##*/}" in
  poweroff|reboot|shutdown|halt) deny ;;
  telinit) case "${1:-}" in 0|6) deny ;; esac ;;
esac
readonly_call=false
for argument in "$@"; do
  case "$argument" in
    status|show|cat|is-active|is-enabled|is-failed|list-units|list-unit-files) readonly_call=true ;;
    poweroff|reboot|halt|kexec|soft-reboot|suspend|hibernate|hybrid-sleep|suspend-then-hibernate|rescue|emergency|exit|switch-root) deny ;;
  esac
done
# A mutating command takes precedence even if a unit is named "status".
for argument in "$@"; do
  case "$argument" in
    start|stop|restart|try-restart|reload|reload-or-restart|reload-or-try-restart|kill|disable|mask|revert|set-property|isolate|enable|reenable|preset|preset-all|edit|link) readonly_call=false ;;
  esac
done
if [ "$readonly_call" = false ]; then
  for argument in "$@"; do
    case "$argument" in
      *mukai-guest*|*mukai-display*|*mukai-desktop*|*shutdown.target*|*poweroff.target*|*reboot.target*|*halt.target*|*kexec.target*|*rescue.target*|*emergency.target*|*sleep.target*|*suspend.target*|*hibernate.target*) deny ;;
    esac
  done
fi
exec /usr/lib/mukai-guest/systemctl "$@"
