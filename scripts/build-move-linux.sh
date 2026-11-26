#!/usr/bin/env bash
# Builds vunemi-move, files_move's native step (native/move), for Linux.
# Nothing is downloaded: the source is in this repository. One arm64 machine
# builds both architectures (x64 with Ubuntu's cross compiler), like the engines.
#
# Usage: scripts/build-move-linux.sh [--arch x64|arm64]   (default: this machine's)
set -euo pipefail

version="${VUNEMI_MOVE_VERSION:-1}"  # MOVE_VERSION in apps/desktop/src/main/native-move.ts

if [ "$(uname -s)" != "Linux" ]; then
  echo "! bu betik Linux içindir" >&2
  exit 1
fi
here="$(cd "$(dirname "$0")/.." && pwd)"
source "$here/scripts/linux/common.sh"
want=""
if [ "${1:-}" = "--arch" ]; then want="${2:-}"; fi
linux_target "$want"
out="${VUNEMI_BUILD_DIR:-$HOME/.vunemi-build}"
cache="$out/move-cache/$version-linux-$arch"
build="$out/move-build/linux-$arch"
key="$(cat "$0" "$here"/native/move/CMakeLists.txt "$here"/native/move/*.c "$here"/native/move/*.h | sha256sum | cut -d' ' -f1)"

if [ -x "$cache/vunemi-move" ] && [ "$(cat "$cache/.built-from" 2>/dev/null)" = "$key" ]; then
  echo "› taşıma programı hazır ($arch)"
  exit 0
fi

echo "› taşıma programı derleniyor ($arch)"
rm -rf "$build"
args=()
if [ "$arch" = "x64" ] && [ "$(uname -m)" != "x86_64" ]; then args=(-DCMAKE_TOOLCHAIN_FILE="$here/scripts/linux/x64-baseline.cmake"); fi
cmake -S "$here/native/move" -B "$build" -DCMAKE_BUILD_TYPE=Release "${args[@]}" \
  -DCMAKE_C_FLAGS="-ffile-prefix-map=$here=." -DCMAKE_EXE_LINKER_FLAGS="-static-libgcc" >/dev/null
cmake --build "$build" -j "$(nproc)" >/dev/null
bin="$build/vunemi-move"
check_linux_binary "$bin" "taşıma programı"
"$strip_tool" "$bin"
mkdir -p "$cache"
cp "$bin" "$cache/vunemi-move"
echo "$key" > "$cache/.built-from"
echo "› taşıma programı hazır → $cache"
