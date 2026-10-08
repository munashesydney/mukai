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
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
  *) echo 'VM requires x86_64 or aarch64 Linux.' >&2; exit 1 ;;
esac
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl xz-utils git python3 build-essential sudo
# Ubuntu's minimal cloud image omits this module used to read the boot identity.
if ! modprobe qemu_fw_cfg; then
  apt-get install -y "linux-modules-extra-$(uname -r)"
  modprobe qemu_fw_cfg
fi
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
curl -fsS https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$scratch/SHASUMS256.txt"
archive=$(awk -v arch="$node_arch" '$2 ~ "^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$" { print $2; exit }' "$scratch/SHASUMS256.txt")
[ -n "$archive" ] || { echo 'Node 24 archive not found.' >&2; exit 1; }
curl -fsS "https://nodejs.org/dist/latest-v24.x/$archive" -o "$scratch/$archive"
(cd "$scratch"; awk -v name="$archive" '$2 == name' SHASUMS256.txt | sha256sum -c -)
tar -xJf "$scratch/$archive" -C /usr/local --strip-components=1
id mukai >/dev/null 2>&1 || useradd --create-home --shell /bin/bash mukai
install -d -o mukai -g mukai /home/mukai/workspace /var/lib/mukai-guest
install -d /opt/mukai-guest
install -m 0644 package.json /opt/mukai-guest/
(cd /opt/mukai-guest; /usr/local/bin/npm install --omit=dev)
if [ "$node_arch" = x64 ]; then
  curl -fsS https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$scratch/chrome.deb"
  apt-get install -y "$scratch/chrome.deb"
else
  # Ubuntu's Chromium package is a snap wrapper. Use Playwright's pinned native
  # ARM64 build instead, in a shared root-owned directory readable by mukai.
  PLAYWRIGHT_BROWSERS_PATH=/opt/mukai-guest/browsers /usr/local/bin/node /opt/mukai-guest/node_modules/playwright-core/cli.js install --with-deps --no-shell chromium
  chmod -R a+rX /opt/mukai-guest/browsers
  browser=$(PLAYWRIGHT_BROWSERS_PATH=/opt/mukai-guest/browsers /usr/local/bin/node -e 'process.stdout.write(require("/opt/mukai-guest/node_modules/playwright-core").chromium.executablePath())')
  [ -x "$browser" ] || { echo 'ARM64 Chromium installation failed.' >&2; exit 1; }
  # Noble restricts user namespaces for downloaded browsers. Authorize only this
  # executable so desktop Chromium can retain its sandbox without a global change.
  apt-get install -y apparmor
  cat > /etc/apparmor.d/mukai-chromium <<POLICY
abi <abi/4.0>,
include <tunables/global>
profile mukai-chromium "$browser" flags=(unconfined) {
  userns,
}
POLICY
  apparmor_parser -r /etc/apparmor.d/mukai-chromium
  ln -sfn "$browser" /opt/mukai-guest/chromium
  install -m 0755 browser-start.sh /usr/local/bin/mukai-browser
  install -d /usr/local/share/applications
  cat > /usr/local/share/applications/mukai-browser.desktop <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Chromium
Exec=/usr/local/bin/mukai-browser %U
Icon=web-browser
Terminal=false
Categories=Network;WebBrowser;
MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;
DESKTOP
  update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/local/bin/mukai-browser 100
fi
# The account has administrator access INSIDE its VM, for package installation.
printf 'mukai ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/mukai
chmod 0440 /etc/sudoers.d/mukai
sh ./protect.sh .
echo 'Guest installed. Shut down before copying this disk as the base image.'
