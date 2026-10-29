#!/bin/bash
# Mukai CLI installer. Source of truth: the mukai application repository.
set -euo pipefail
repo='https://github.com/munashesydney/mukai/releases'
version="${MUKAI_VERSION:-}"
case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) echo 'Use the PowerShell installer on Windows.' >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo 'Unsupported CPU architecture.' >&2; exit 1 ;; esac
if [[ "$platform" == linux && "$arch" != x64 ]]; then echo 'Linux CLI currently supports x64 (glibc) only.' >&2; exit 1; fi
command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }

install_linux_vm_dependencies() {
  [[ "$platform" == linux && "${MUKAI_SKIP_VM_DEPS:-}" != 1 ]] || return 0
  if command -v qemu-system-x86_64 >/dev/null && command -v qemu-img >/dev/null; then return 0; fi
  if ! command -v apt-get >/dev/null; then
    echo 'Install QEMU with your Linux package manager before creating a VM workspace.' >&2
    return 0
  fi
  local admin=()
  if [[ "$(id -u)" != 0 ]]; then
    if ! command -v sudo >/dev/null; then
      echo 'QEMU is missing. Install it as an administrator: apt-get update && apt-get install -y qemu-system-x86 qemu-utils' >&2
      echo 'Then rerun this installer as your normal user. Set MUKAI_SKIP_VM_DEPS=1 to install Mukai without VM dependencies.' >&2
      return 1
    fi
    echo 'Installing QEMU for VM workspaces. Only system package commands require administrator approval.'
    # stdin contains the piped installer. Authenticate through the controlling terminal instead.
    if ! sudo -n true </dev/null 2>/dev/null; then
      if ! ( : </dev/tty ) 2>/dev/null; then
        echo 'QEMU installation needs administrator approval. Rerun from an interactive terminal, or run: sudo apt-get update && sudo apt-get install -y qemu-system-x86 qemu-utils' >&2
        echo 'Set MUKAI_SKIP_VM_DEPS=1 to install Mukai without VM dependencies.' >&2
        return 1
      fi
      if ! sudo -v </dev/tty; then
        echo 'Administrator approval failed. Install QEMU manually, then rerun the installer.' >&2
        return 1
      fi
    fi
    admin=(sudo -n)
  fi
  # ${admin[@]+...} keeps expansion safe when root leaves the array empty (bash <4.4 + set -u).
  if ! ${admin[@]+"${admin[@]}"} apt-get update </dev/null ||
    ! ${admin[@]+"${admin[@]}"} apt-get install -y qemu-system-x86 qemu-utils </dev/null; then
    echo 'QEMU installation failed. Resolve the package manager error above, then rerun the installer.' >&2
    return 1
  fi
  if ! command -v qemu-system-x86_64 >/dev/null || ! command -v qemu-img >/dev/null; then
    echo 'QEMU installation finished, but qemu-system-x86_64 or qemu-img is missing from PATH.' >&2
    return 1
  fi
}

configure_linux_kvm() {
  [[ "$platform" == linux && "${MUKAI_SKIP_VM_DEPS:-}" != 1 ]] || return 0
  if ! test -c /dev/kvm; then
    echo 'KVM hardware acceleration is unavailable. VM setup will test software emulation, which is considerably slower.' >&2
    return 0
  fi
  if test -r /dev/kvm && test -w /dev/kvm; then return 0; fi
  if [[ "$(id -u)" == 0 ]]; then
    echo 'The host restricts KVM device access even for root. VM setup can use slower software emulation.' >&2
    return 0
  fi
  if ! command -v stat >/dev/null || [[ "$(stat -c %G /dev/kvm)" != kvm ]] || ! command -v usermod >/dev/null; then
    echo 'KVM device permissions need administrator attention. VM setup can use slower software emulation.' >&2
    return 0
  fi
  local username groups admin=()
  username=$(id -un)
  groups=$(id -nG "$username")
  case " $groups " in *' kvm '*)
    echo 'Log out and back in, then start Mukai to activate KVM access. Until then, VM setup can use slower software emulation.' >&2
    return 0
  ;; esac
  if [[ "$(id -u)" != 0 ]]; then
    if ! command -v sudo >/dev/null; then
      echo 'KVM access requires administrator approval. VM setup can use slower software emulation.' >&2
      return 0
    fi
    echo 'Granting your OS user access to KVM. Administrator approval may be requested.'
    if ! sudo -n true </dev/null 2>/dev/null; then
      if ! ( : </dev/tty ) 2>/dev/null || ! sudo -v </dev/tty; then
        echo 'KVM access was not granted. VM setup can use slower software emulation.' >&2
        return 0
      fi
    fi
    admin=(sudo -n)
  fi
  if "${admin[@]}" usermod -a -G kvm -- "$username" </dev/null; then
    echo 'KVM group access granted. Log out and back in before starting Mukai to activate hardware acceleration.' >&2
  else
    echo 'KVM access could not be granted. VM setup can use slower software emulation.' >&2
  fi
}

root="$HOME/.local/share/mukai"
bin="$HOME/.local/bin"
mkdir -p "$root/versions" "$bin"
if [[ -e "$bin/mukai" ]] && ! grep -q '^# Mukai CLI launcher$' "$bin/mukai"; then
  echo "A different command exists at $bin/mukai. Move it before installing." >&2; exit 1
fi
existing=$(command -v mukai || true)
if [[ -n "$existing" && "$existing" != "$bin/mukai" ]]; then
  echo "Another mukai command is active at $existing. Remove its PATH registration before installing." >&2; exit 1
fi
stage=$(mktemp -d "$root/staging.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
if [[ -z "$version" ]]; then
  curl --proto '=https' --tlsv1.2 -fsSL "$repo/latest/download/cli-manifest.json" -o "$stage/manifest.json"
  version=$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)"[,]*$/\1/p' "$stage/manifest.json")
fi
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]]; then echo 'Invalid release version.' >&2; exit 1; fi
asset="mukai-cli-$version-$platform-$arch.tar.gz"
base="$repo/download/v$version"
curl --proto '=https' --tlsv1.2 -fsSL "$base/$asset" -o "$stage/$asset"
curl --proto '=https' --tlsv1.2 -fsSL "$base/SHA256SUMS.txt" -o "$stage/SHA256SUMS.txt"
expected=$(awk -v name="$asset" '$2 == name {print $1}' "$stage/SHA256SUMS.txt")
if [[ ! "$expected" =~ ^[a-f0-9]{64}$ ]]; then echo 'Release checksum is missing or ambiguous.' >&2; exit 1; fi
if command -v sha256sum >/dev/null; then actual=$(sha256sum "$stage/$asset" | awk '{print $1}');
else actual=$(shasum -a 256 "$stage/$asset" | awk '{print $1}'); fi
[[ "$actual" == "$expected" ]] || { echo 'Download checksum does not match.' >&2; exit 1; }
tar -xzf "$stage/$asset" -C "$stage"
"$stage/mukai/runtime/node" "$stage/mukai/app/cli.cjs" --version > "$stage/version.txt"
[[ "$(cat "$stage/version.txt")" == "$version" ]] || { echo 'Downloaded CLI has the wrong version.' >&2; exit 1; }
install_linux_vm_dependencies
configure_linux_kvm
installation="$version-${stage##*/}"
target="$root/versions/$installation"
mkdir "$stage/version"; mv "$stage/mukai" "$stage/version/mukai"; mv "$stage/version" "$target"
printf '%s\n' "$installation" > "$stage/active-version"
mv -f "$stage/active-version" "$root/active-version"
cat > "$stage/launcher" <<'LAUNCHER'
#!/bin/sh
# Mukai CLI launcher
set -eu
version=$(cat "$HOME/.local/share/mukai/active-version")
base="$HOME/.local/share/mukai/versions/$version/mukai"
exec "$base/runtime/node" "$base/app/cli.cjs" "$@"
LAUNCHER
chmod 755 "$stage/launcher"
mv -f "$stage/launcher" "$bin/mukai"
if [[ "${MUKAI_NO_MODIFY_PATH:-}" != 1 ]]; then
case ":$PATH:" in *":$bin:"*) ;; *)
  case "${SHELL:-}" in *zsh) profile="$HOME/.zshrc" ;; *bash) profile="$HOME/.bashrc" ;; *) profile="$HOME/.profile" ;; esac
  line='export PATH="$HOME/.local/bin:$PATH"'
  if [[ ! -f "$profile" ]] || ! grep -Fqx "$line" "$profile"; then printf '\n# Mukai CLI\n%s\n' "$line" >> "$profile"; fi
  echo "Added ~/.local/bin to $profile. Restart your terminal before using mukai."
;; esac
fi
echo "Installed Mukai $version. Run: mukai serve --open"
echo 'Re-run this installer to upgrade. Application data is preserved.'
