#!/usr/bin/env bash
# Packs a signed Vunemi.app into a DMG for the site, and puts the install
# page next to it, filled in with this build's version, size and checksum.
#
#   scripts/make-dmg.sh <Vunemi.app> <signing identity> <output folder>
#
# Called by package.sh for a distribution build. Nothing here uploads
# anything: <output folder>/site is what would go on the web server, and
# putting it there is the user's call.
set -euo pipefail

app="$1"
identity="$2"
out="$3"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# A distribution build must not outpace the public documentation review.
# The site lives in its own repository; skip when it isn't next to the app.
if [ -f "$here/site/launch/docs/build.mjs" ]; then
  node "$here/site/launch/docs/build.mjs" --release-check
fi

version="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$app/Contents/Info.plist")"
name="Vunemi-$version-arm64.dmg"
site="$out/site"
dmg="$site/$name"
rm -rf "$site"
mkdir -p "$site"

# dmgbuild lays out the window (background, icon places) without driving
# Finder. electron-builder keeps a checksum-verified copy in its cache; this
# script never downloads it.
dmgbuild="$(ls -d "$HOME"/Library/Caches/electron-builder/dmg-builder@*/dmgbuild-bundle-arm64-*/dmgbuild 2>/dev/null | grep -v '/\._' | tail -1 || true)"
if [ -z "$dmgbuild" ] || [ ! -x "$dmgbuild" ]; then
  echo "! dmgbuild bulunamadı (~/Library/Caches/electron-builder)" >&2
  exit 1
fi

echo "› DMG: $name"
stage="$(mktemp -d -t vunemi-dmg)"
trap 'rm -rf "$stage"' EXIT
swift "$here/scripts/dmg-background.swift" "$stage"
"$dmgbuild" -s "$here/scripts/dmg-settings.py" -D app="$app" -D background="$stage/background.png" \
  "Vunemi $version" "$dmg" > "$stage/dmgbuild.log" 2>&1 || { cat "$stage/dmgbuild.log" >&2; exit 1; }
codesign --force --timestamp=none --sign "$identity" "$dmg"
hdiutil verify -quiet "$dmg"

# What the user will run is the copy inside the image: check that one.
mount="$(mktemp -d -t vunemi-dmg-mount)"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mount" "$dmg"
if ! codesign --verify --deep --strict "$mount/Vunemi.app"; then
  hdiutil detach -quiet "$mount"
  echo "! DMG içindeki uygulamanın imzası doğrulanmadı" >&2
  exit 1
fi
hdiutil detach -quiet "$mount"
rmdir "$mount" 2>/dev/null || true

sha="$(shasum -a 256 "$dmg" | cut -d' ' -f1)"
echo "$sha  $name" > "$dmg.sha256"
size_mb="$(( ($(stat -f%z "$dmg") + 524287) / 1048576 ))"

for page in "$here"/site/*.html; do
  [ -f "$page" ] || continue
  sed -e "s/{{VERSION}}/$version/g" -e "s/{{DMG}}/$name/g" -e "s/{{SHA256}}/$sha/g" -e "s/{{SIZE_MB}}/$size_mb/g" \
    "$page" > "$site/$(basename "$page")"
done
cp "$here/apps/desktop/build/icon.png" "$site/icon.png"

echo "› site klasörü hazır (yayımlanmadı): $site"
echo "  $name · $size_mb MB · sha256 $sha"
