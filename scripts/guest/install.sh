#!/bin/sh
# Run INSIDE a disposable Ubuntu/Debian QEMU guest, as root.
set -eu
# WHPX exposes Hyper-V CPUID even though QEMU supplies the virtual hardware.
case "$(systemd-detect-virt --vm)" in
  qemu|kvm) ;;
  microsoft)
    [ "$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)" = QEMU ] || {
      echo 'Install only inside a QEMU/KVM guest.' >&2; exit 1;
    } ;;
  *) echo 'Install only inside a QEMU/KVM guest.' >&2; exit 1 ;;
esac
[ "$(id -u)" = 0 ] || { echo 'Run as root inside the guest.' >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo 'VM v1 requires x86_64.' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl xz-utils git python3 build-essential sudo
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
curl -fsS https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$scratch/SHASUMS256.txt"
archive=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ { print $2; exit }' "$scratch/SHASUMS256.txt")
[ -n "$archive" ] || { echo 'Node 24 archive not found.' >&2; exit 1; }
curl -fsS "https://nodejs.org/dist/latest-v24.x/$archive" -o "$scratch/$archive"
(cd "$scratch"; awk -v name="$archive" '$2 == name' SHASUMS256.txt | sha256sum -c -)
tar -xJf "$scratch/$archive" -C /usr/local --strip-components=1
curl -fsS https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$scratch/chrome.deb"
apt-get install -y "$scratch/chrome.deb"
id mukai >/dev/null 2>&1 || useradd --create-home --shell /bin/bash mukai
install -d -o mukai -g mukai /home/mukai/workspace /var/lib/mukai-guest
install -d /opt/mukai-guest
cp guest.cjs package.json /opt/mukai-guest/
(cd /opt/mukai-guest; /usr/local/bin/npm install --omit=dev)
# The account has administrator access INSIDE its VM, for package installation.
printf 'mukai ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/mukai
chmod 0440 /etc/sudoers.d/mukai
install -m 0644 mukai-guest.service /etc/systemd/system/mukai-guest.service
systemctl daemon-reload
systemctl enable mukai-guest.service
echo 'Guest installed. Shut down before copying this disk as the base image.'
