#!/bin/sh
# Runs INSIDE the guest, as root. Keeps the kernel modules Mukai needs in step
# with the installed kernels.
#
# Ubuntu's cloud images install the linux-virtual meta, which does NOT depend on
# linux-modules-extra. qemu_fw_cfg lives in that package, so an automatic kernel
# upgrade (unattended-upgrades) installs a new linux-image without its extra
# modules. The guest then boots a kernel where /sys/firmware/qemu_fw_cfg is
# missing, every service that reads the boot identity fails, and the bridge
# never starts. This script closes that gap in three layers:
#
#   1. extras for the running kernel, so the guest works right now;
#   2. extras for every other installed kernel, so the next boot works;
#   3. the linux-image-generic meta, which depends on linux-modules-extra, so
#      future kernel upgrades arrive complete on their own.
#
# It is idempotent and safe at every boot: a healthy guest only reads dpkg state
# and loads the module, with no package-manager or network work. Set
# MUKAI_APT_UPDATED=1 when the caller already ran `apt-get update` this boot.
set -eu

[ "$(id -u)" = 0 ] || { echo 'Mukai kernel modules: run as root.' >&2; exit 1; }

module=qemu_fw_cfg
apt_ready=0
[ "${MUKAI_APT_UPDATED:-0}" = 1 ] && apt_ready=1

warn() { printf 'Mukai kernel modules: %s\n' "$*" >&2; }

installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q '^install ok installed$'
}

apt_run() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=1 "$@"
}

# Bound network waits so a broken boot cannot hang here indefinitely, and
# refresh package lists at most once per run whatever the outcome.
apt_get() {
  if [ "$apt_ready" = 0 ]; then
    apt_ready=1
    apt_run update || warn 'apt-get update failed'
  fi
  apt_run install -y --no-install-recommends "$@"
}

# linux-image-<abi>-<flavour> always has a matching modules-extra package.
ensure_extras_for() {
  case "$1" in
    linux-image-[0-9]*) ;;
    *) return 0 ;;
  esac
  extras="linux-modules-extra-${1#linux-image-}"
  installed "$extras" && return 0
  apt_get "$extras" || warn "could not install $extras"
}

# 1. The running kernel is what has to work before the bridge starts.
ensure_extras_for "linux-image-$(uname -r)"

# 2. A kernel installed by an earlier upgrade still needs its extras, or the
#    next boot lands in the same broken state.
images=$(dpkg-query -W -f='${Package} ${Status}\n' 'linux-image-[0-9]*' 2>/dev/null |
  awk '$4 == "installed" { print $1 }')
for image in $images; do
  ensure_extras_for "$image"
done

# 3. Keep the drift from coming back: this meta pulls the matching extras with
#    every later kernel upgrade.
if ! installed linux-image-generic; then
  apt_get linux-image-generic || warn 'could not install linux-image-generic'
fi

if [ "$apt_ready" = 1 ]; then
  depmod -a || warn 'depmod failed'
fi

if modprobe "$module" 2>/dev/null; then
  exit 0
fi

# Last resort: install the extras the running kernel needs, then retry.
ensure_extras_for "linux-image-$(uname -r)"
depmod -a || warn 'depmod failed'
if modprobe "$module" 2>/dev/null; then
  exit 0
fi

echo "Mukai kernel modules: $module is unavailable; the guest bridge cannot read its boot token." >&2
exit 1
