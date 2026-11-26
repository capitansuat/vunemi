#!/usr/bin/env bash
# Builds Vunemi for Linux: an AppImage and a .deb, for x64 or arm64. The
# macOS build is scripts/package.sh; nothing here signs anything (the AppImage
# is signed for the update feed afterwards with scripts/sign-update.mjs).
#
#  * The engines are built from source for this architecture
#    (build-engine-linux.sh, build-whisper-linux.sh) and put into the
#    unpacked app before the AppImage and the .deb are made from it, so both
#    carry the same files.
#  * One arm64 machine builds both: arm64 natively, x64's engines with
#    Ubuntu's cross compiler (scripts/linux/x64-baseline.cmake).
#
# Usage: scripts/package-linux.sh [--arch x64|arm64]   (default: this machine's)
#  * A local test build (the default) may be opened with
#    --remote-debugging-port, as on macOS; VUNEMI_DISTRIBUTION=1 makes a
#    build for other people that refuses to.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="${VUNEMI_BUILD_DIR:-$HOME/.vunemi-build}"
distribution="${VUNEMI_DISTRIBUTION:-0}"

if [ "$(uname -s)" != "Linux" ]; then
  echo "! bu betik Linux içindir; macOS için: scripts/package.sh" >&2
  exit 1
fi
source "$here/scripts/engine-version.sh"
source "$here/scripts/linux/common.sh"
want=""
if [ "${1:-}" = "--arch" ]; then want="${2:-}"; fi
linux_target "$want"
case "$arch" in
  x64) unpacked_name=linux-unpacked ;;
  arm64) unpacked_name=linux-arm64-unpacked ;;
esac

if [ "$distribution" = "1" ]; then out="$root/linux-dist/$arch"; else out="$root/linux/$arch"; fi

echo "› motor"
bash "$here/scripts/build-engine-linux.sh" --arch "$arch"
echo "› ses motoru"
bash "$here/scripts/build-whisper-linux.sh" --arch "$arch"
engine_cache="$root/engine-cache/$engine_tag-linux-$arch"
whisper_cache="$root/whisper-cache/v1.9.4-linux-$arch"

echo "› uygulama paketleniyor → $out ($arch)"
pnpm --filter @vunemi/desktop exec electron-vite build
test_build=()
if [ "$distribution" != "1" ]; then
  test_build=(--config.extraMetadata.vunemiLocalTestBuild=true)
else
  echo "› dağıtım derlemesi: uzaktan hata ayıklama ile açılmaz"
fi
rm -rf "$out"
pnpm --filter @vunemi/desktop exec electron-builder --linux dir "--$arch" --publish never \
  --config.directories.output="$out" ${test_build[@]+"${test_build[@]}"}

unpacked="$out/$unpacked_name"
resources="$unpacked/resources"
cp -p "$engine_cache/llama-server" "$resources/llama-server"
cp -p "$whisper_cache/whisper-server" "$resources/whisper-server"
mkdir -p "$resources/licenses"
cp -p "$engine_cache/LICENSE" "$resources/licenses/llama.cpp-LICENSE"
cp -p "$whisper_cache/LICENSE" "$resources/licenses/whisper.cpp-LICENSE"
# The flight search is based on Fli (MIT); its notice ships with the app.
cp -p "$here/apps/desktop/src/main/flights/LICENSE" "$resources/licenses/fli-LICENSE"
cp -p "$here/LICENSE" "$resources/licenses/Vunemi-LICENSE"

# The right machine, glibc only, nothing of the builder's own folders in what ships.
for bin in "$resources/llama-server" "$resources/whisper-server"; do
  check_linux_binary "$bin" "$(basename "$bin")"
done

echo "› AppImage ve deb"
pnpm --filter @vunemi/desktop exec electron-builder --linux AppImage deb "--$arch" --publish never \
  --prepackaged "$unpacked" --config.directories.output="$out"

echo "› hazır:"
ls -1 "$out"/*.AppImage "$out"/*.deb
echo "  Çalıştır: \"$unpacked/vunemi\"  ya da  \"$(ls "$out"/*.AppImage | head -1)\""
