#!/bin/sh
set -eu
# Keep the VM's main profile at the existing Chrome discovery location. Explicit
# automation/profile arguments take precedence; no host browser is involved.
for argument in "$@"; do
  case "$argument" in
    --user-data-dir|--user-data-dir=*) exec /opt/mukai-guest/chromium "$@" ;;
  esac
done
exec /opt/mukai-guest/chromium --user-data-dir="$HOME/.config/google-chrome" "$@"
