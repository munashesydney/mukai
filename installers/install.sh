#!/bin/bash
# Mukai CLI installer. Source of truth: the mukai application repository.
set -euo pipefail
repo='https://github.com/munashesydney/mukai/releases'
version="${MUKAI_VERSION:-}"
case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) echo 'Use the PowerShell installer on Windows.' >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo 'Unsupported CPU architecture.' >&2; exit 1 ;; esac
if [[ "$platform" == linux && "$arch" != x64 ]]; then echo 'Linux CLI currently supports x64 (glibc) only.' >&2; exit 1; fi
command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }
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
