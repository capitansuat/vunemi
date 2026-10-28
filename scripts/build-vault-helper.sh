#!/usr/bin/env bash
# Keep the exact signed Keychain caller across desktop/UI/SDK updates.
# Only this broker's sources and signing configuration invalidate its cache.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${VUNEMI_BUILD_DIR:-$HOME/.vunemi-build}"
identity="${1:?signing identity required}"
developer_id="${2:-0}"
source_dir="$here/native/VunemiVaultHelper"
key="$({ cat "$source_dir/Package.swift" "$source_dir"/Sources/VunemiVaultHelper/*.swift; echo "$identity" "$developer_id" vault-broker-v1; } | shasum -a 256 | cut -c1-16)"
cache="$out/vault-helper-cache/$key/VunemiVaultHelper"
destination="$source_dir/.build/release/VunemiVaultHelper"
if [ ! -x "$cache" ] || [ "$identity" = "-" ]; then
  echo "› Kasa yardımcısı derleniyor ($key)"
  swift build --package-path "$source_dir" --scratch-path "$out/vault-helper-build" -c release \
    -Xswiftc -file-prefix-map -Xswiftc "$source_dir=." -Xswiftc -debug-prefix-map -Xswiftc "$source_dir=."
  mkdir -p "$(dirname "$cache")"
  cp "$out/vault-helper-build/release/VunemiVaultHelper" "$cache"
  strip -S "$cache"
  timestamp=(--timestamp=none)
  if [ "$developer_id" = "1" ]; then timestamp=(--timestamp); fi
  codesign --force --options runtime "${timestamp[@]}" --identifier com.vunemi.vault-helper --sign "$identity" "$cache"
else
  echo "› Kasa yardımcısı değişmedi ($key): aynı imzalı dosya"
fi
codesign --verify --strict "$cache"
mkdir -p "$(dirname "$destination")"
cp -p "$cache" "$destination"
