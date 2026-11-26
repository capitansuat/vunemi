#!/usr/bin/env bash
# Builds espeak-ng, the speech synthesiser Vunemi reads answers aloud with on
# Linux, from a pinned release, for x64 or arm64, on the arm64 Linux machine.
# Only what writing a WAV needs: static, no sound output library, no MBROLA,
# no sonic, no asynchronous mode, no speech-player. espeak-ng's CMake would
# fetch sonic from GitHub when the system has none: that is switched off
# (FETCHCONTENT_FULLY_DISCONNECTED, and sonic named as present), so nothing is
# downloaded but the pinned source.
#
# The data (phonemes, intonations, dictionaries) is compiled once by the
# arm64 build and is the same for x64; only the dictionaries of Vunemi's
# eleven languages ship.
#
# Usage: scripts/build-espeak-linux.sh [--arch x64|arm64]   (default: this machine's)
#
# Licence: espeak-ng is GPL-3.0-or-later (its COPYING ships next to it).
set -euo pipefail

tag="${VUNEMI_ESPEAK_TAG:-1.52.0}"
commit="${VUNEMI_ESPEAK_COMMIT:-4870adfa25b1a32b4361592f1be8a40337c58d6c}"
# ESPEAK_DICTS in apps/desktop/src/main/speech-linux.ts must agree.
dicts=(tr en de fr es it pt ru ja ko cmn)

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
cache="$out/espeak-cache/$tag-linux-$arch"
src="$out/espeak-src/$tag"
build="$src/build-linux-$arch"
data="$src/build-linux-arm64/espeak-ng-data"

if [ -x "$cache/espeak-ng/espeak-ng" ] && [ -f "$cache/espeak-ng/espeak-ng-data/phondata" ] && [ "$(cat "$cache/ARCH" 2>/dev/null)" = "$arch" ]; then
  echo "› ses sentezi hazır ($tag, $arch)"
  exit 0
fi

if [ ! -d "$src/.git" ]; then
  echo "› espeak-ng $tag indiriliyor"
  mkdir -p "$(dirname "$src")"
  git clone --quiet --depth 1 --branch "$tag" https://github.com/espeak-ng/espeak-ng.git "$src"
fi
actual="$(git -C "$src" rev-parse HEAD)"
if [ "$actual" != "$commit" ]; then
  echo "! $tag beklenen commit değil: $actual (beklenen $commit)"
  exit 1
fi

configure() {
  local dir="$1"; shift
  rm -rf "$dir"
  cmake -S "$src" -B "$dir" -DCMAKE_BUILD_TYPE=Release "$@" \
    -DCMAKE_C_FLAGS="-ffile-prefix-map=$src=." -DCMAKE_CXX_FLAGS="-ffile-prefix-map=$src=." \
    -DCMAKE_EXE_LINKER_FLAGS="-static-libgcc" -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF \
    -DUSE_LIBPCAUDIO=OFF -DUSE_LIBSONIC=OFF -DUSE_MBROLA=OFF -DUSE_ASYNC=OFF -DUSE_KLATT=ON -DUSE_SPEECHPLAYER=OFF \
    -DSONIC_LIB=vunemi-none -DSONIC_INC=vunemi-none -DFETCHCONTENT_FULLY_DISCONNECTED=ON >/dev/null
}

# The data needs a binary that runs here: the arm64 build makes it.
if [ ! -f "$data/phondata" ]; then
  [ "$(uname -m)" = "aarch64" ] || { echo "! veri arm64 makinede derlenir" >&2; exit 1; }
  echo "› ses sentezi verisi derleniyor"
  configure "$src/build-linux-arm64"
  cmake --build "$src/build-linux-arm64" -j "$(nproc)" >/dev/null
fi

echo "› ses sentezi derleniyor ($tag, $arch)"
if [ "$arch" = "x64" ] && [ "$(uname -m)" != "x86_64" ]; then
  configure "$build" -DCMAKE_TOOLCHAIN_FILE="$here/scripts/linux/x64-baseline.cmake"
  cmake --build "$build" --target espeak-ng-bin -j "$(nproc)" >/dev/null
fi
bin="$build/src/espeak-ng"
check_linux_binary "$bin" "ses sentezi"

rm -rf "$cache"
mkdir -p "$cache/espeak-ng/espeak-ng-data"
cp "$bin" "$cache/espeak-ng/espeak-ng"
"$strip_tool" "$cache/espeak-ng/espeak-ng"
for f in phondata phondata-manifest phonindex phontab intonations; do cp "$data/$f" "$cache/espeak-ng/espeak-ng-data/$f"; done
cp -r "$data/lang" "$data/voices" "$cache/espeak-ng/espeak-ng-data/"
for d in "${dicts[@]}"; do cp "$data/${d}_dict" "$cache/espeak-ng/espeak-ng-data/${d}_dict"; done
cp "$src/COPYING" "$cache/COPYING"
echo "$arch" > "$cache/ARCH"
echo "› ses sentezi hazır → $cache ($(du -sh "$cache/espeak-ng" | cut -f1))"
