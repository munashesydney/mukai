#!/bin/sh
# Trusted provisioning inside the guest. Never restarts the desktop or bridge.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Guest resilience setup requires root.' >&2; exit 1; }
umask 077

warn() { printf 'Mukai guest resilience: %s\n' "$*" >&2; }
pending=''
trap '[ -z "$pending" ] || rm -f -- "$pending"' EXIT

# The worker owns /var/lib/mukai-guest for screenshots. Keep privileged swap
# outside that writable directory so the worker cannot replace its pathname.
state_dir=/var/lib/mukai-guest-system
swapfile=$state_dir/swapfile
swap_mib=2048
reserve_kib=4194304

configure_swap() {
  # Respect swap supplied by the image or its administrator, including swap
  # configured for the next boot but not currently active.
  if awk -v path="$swapfile" 'NR > 1 && $1 != path { found=1 } END { exit !found }' /proc/swaps ||
    awk -v path="$swapfile" '$1 !~ /^#/ && $3 == "swap" && $1 != path { found=1 } END { exit !found }' /etc/fstab; then
    warn 'Existing swap detected; leaving its configuration unchanged.'
    return
  fi
  for utility in df stat dd mkswap swapon; do
    if ! command -v "$utility" >/dev/null 2>&1; then
      warn "Swap was not configured: required utility $utility is unavailable."
      return
    fi
  done
  if [ -L "$state_dir" ] || { [ -e "$state_dir" ] && [ ! -d "$state_dir" ]; }; then
    warn 'Swap was not configured: its state directory is not a regular directory.'
    return
  fi
  install -d -o root -g root -m 0700 "$state_dir"
  filesystem=$(df -PT "$state_dir" | awk 'NR == 2 { print $2 }')
  if [ "$filesystem" != ext4 ]; then
    warn "Swap was not configured: filesystem $filesystem is not supported by this provisioner."
    return
  fi
  if [ -L "$swapfile" ] || { [ -e "$swapfile" ] && [ ! -f "$swapfile" ]; }; then
    warn 'Swap was not configured: its pathname is not a regular file.'
    return
  fi
  if [ ! -e "$swapfile" ]; then
    free_kib=$(df -Pk "$state_dir" | awk 'NR == 2 { print $4 }')
    case "$free_kib" in
      ''|*[!0-9]*) warn 'Swap was not configured: free disk space could not be measured.'; return ;;
    esac
    if [ "$free_kib" -lt "$((swap_mib * 1024 + reserve_kib))" ]; then
      warn 'Swap was not configured: a 2 GiB swap file must leave at least 4 GiB free.'
      return
    fi
    pending=$(mktemp "$state_dir/swapfile.XXXXXX")
    # dd allocates every block; sparse or filesystem-dependent preallocation is
    # unsuitable for swap. Write once during provisioning, never on every boot.
    if ! dd if=/dev/zero of="$pending" bs=1M count="$swap_mib" conv=fsync status=none; then
      warn 'Swap was not configured: allocation failed.'
      rm -f -- "$pending"; pending=''; return
    fi
    free_kib=$(df -Pk "$state_dir" | awk 'NR == 2 { print $4 }')
    case "$free_kib" in
      ''|*[!0-9]*) free_kib=0 ;;
    esac
    if [ "$free_kib" -lt "$reserve_kib" ]; then
      warn 'Swap was not configured: allocation would leave less than 4 GiB free.'
      rm -f -- "$pending"; pending=''; return
    fi
    if ! mkswap "$pending" >/dev/null; then
      warn 'Swap was not configured: formatting failed.'
      rm -f -- "$pending"; pending=''; return
    fi
    chown root:root "$pending"
    chmod 0600 "$pending"
    mv -- "$pending" "$swapfile"
    pending=''
  fi
  if [ "$(stat -c %s "$swapfile")" -ne "$((swap_mib * 1024 * 1024))" ]; then
    warn 'Swap was not configured: an existing managed file has an unexpected size.'
    return
  fi
  chown root:root "$swapfile"
  chmod 0600 "$swapfile"
  if ! awk -v path="$swapfile" 'NR > 1 && $1 == path { found=1 } END { exit !found }' /proc/swaps; then
    if ! swapon "$swapfile"; then
      warn 'Swap was not activated; its file was retained for diagnosis. No fstab entry was added.'
      return
    fi
  fi
  # Normalize only our entry. Other mounts, comments and administrator swap
  # remain intact; rerunning an update cannot accumulate duplicate entries.
  pending=$(mktemp /etc/fstab.mukai.XXXXXX)
  awk -v path="$swapfile" '$1 != path { print } END { print path " none swap sw 0 0" }' /etc/fstab > "$pending"
  install -o root -g root -m 0644 "$pending" /etc/fstab
  rm -f -- "$pending"; pending=''
  install -d -o root -g root -m 0755 /etc/sysctl.d
  printf 'vm.swappiness = 20\n' > /etc/sysctl.d/60-mukai-swap.conf
  chmod 0644 /etc/sysctl.d/60-mukai-swap.conf
  if ! sysctl -w vm.swappiness=20 >/dev/null; then
    warn 'Swappiness will be applied on the next boot; applying it now failed.'
  fi
  warn 'Managed 2 GiB swap is active and configured for future boots.'
}

install -d -o root -g root -m 0750 /var/log/mukai-guest
install -d -o root -g systemd-journal -m 2755 /var/log/journal
install -d -o root -g root -m 0755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/60-mukai-resilience.conf <<'JOURNAL'
[Journal]
Storage=persistent
SystemMaxUse=100M
SystemMaxFileSize=16M
SystemKeepFree=1G
RuntimeMaxUse=32M
RateLimitIntervalSec=30s
RateLimitBurst=1000
JOURNAL
chmod 0644 /etc/systemd/journald.conf.d/60-mukai-resilience.conf
# The existing controlled upgrade reboot loads the limits. Flush current logs
# without restarting services or discarding any archived diagnostic evidence.
if ! journalctl --flush; then
  warn 'The journal will become persistent on the next boot; flushing it now failed.'
fi
configure_swap
