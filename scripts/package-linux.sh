#!/usr/bin/env bash
# Builds Vunemi for Linux: an AppImage and a .deb, for this machine's
# architecture (x64 or arm64). The macOS build is scripts/package.sh; nothing
# here signs anything.
#
#  * The engines are built from source for this architecture
#    (build-engine-linux.sh, build-whisper-linux.sh) and put into the
#    unpacked app before the AppImage and the .deb are made from it, so both
#    carry the same files.
#  * arm64 is built on an arm64 machine: the engines are native code and
#    are not cross-compiled here.
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
case "$(uname -m)" in
  x86_64) arch=x64; unpacked_name=linux-unpacked ;;
  aarch64 | arm64) arch=arm64; unpacked_name=linux-arm64-unpacked ;;
  *) echo "! desteklenmeyen mimari: $(uname -m)" >&2; exit 1 ;;
esac

if [ "$distribution" = "1" ]; then out="$root/linux-dist"; else out="$root/linux"; fi

echo "› motor"
bash "$here/scripts/build-engine-linux.sh"
echo "› ses motoru"
bash "$here/scripts/build-whisper-linux.sh"
engine_cache="$root/engine-cache/v0.5.0"
whisper_cache="$root/whisper-cache/v1.9.4"

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

# Nothing of the builder's own folders in what ships.
for bin in "$resources/llama-server" "$resources/whisper-server"; do
  if grep -q -a -F "$HOME/" "$bin"; then
    echo "! $(basename "$bin") derleme yolunu (kullanıcı klasörü) içeriyor"
    exit 1
  fi
done

echo "› AppImage ve deb"
pnpm --filter @vunemi/desktop exec electron-builder --linux AppImage deb "--$arch" --publish never \
  --prepackaged "$unpacked" --config.directories.output="$out"

echo "› hazır:"
ls -1 "$out"/*.AppImage "$out"/*.deb
echo "  Çalıştır: \"$unpacked/vunemi\"  ya da  \"$(ls "$out"/*.AppImage | head -1)\""
