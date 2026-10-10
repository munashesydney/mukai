#!/bin/sh
# Image provisioning only: avoid inconsistent CET state with WHPX/Nehalem.
set -eu
[ "${1:-}" = whpx ] || exit 0
[ "$(uname -m)" = x86_64 ] || exit 0
[ "$(id -u)" = 0 ] || { echo 'Run WHPX image provisioning as root.' >&2; exit 1; }

# The installer has already verified QEMU hardware; do not infer acceleration
# from guest CPUID. The host passes its actual accelerator explicitly.
cfg=/etc/default/grub.d/99-mukai-whpx-cet.cfg
install -d -m 0755 /etc/default/grub.d
umask 022
temporary=$(mktemp)
trap 'rm -f -- "$temporary"' EXIT
cat > "$temporary" <<'CONFIG'
# WHPX exposes CET with the Nehalem model while this guest uses FXSAVE.
# Suppress SHSTK (519) and IBT (596) so Linux keeps CR4.CET disabled.
# This disables guest CET protection and taints the kernel. Revert by removing
# this file, running update-grub and rebooting the guest.
GRUB_CMDLINE_LINUX="${GRUB_CMDLINE_LINUX} clearcpuid=519,596 nousershstk"
CONFIG
if [ -f "$cfg" ] && cmp -s "$temporary" "$cfg"; then exit 0; fi
install -m 0644 "$temporary" "$cfg"
update-grub
echo 'WHPX image: CET disabled for subsequent guest boots.'
