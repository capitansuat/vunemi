#!/usr/bin/env bash
# Builds whisper.cpp's server for Linux — what Vunemi turns speech into text
# with — from the same pinned release as the macOS build (build-whisper.sh).
# The same rules as build-engine-linux.sh: from source, CPU only, no OpenMP,
# libstdc++ linked in, and no SDL, curl or ffmpeg: it reads the WAV Vunemi
# sends it over plain HTTP on 127.0.0.1. One arm64 machine builds both
# architectures.
#
# Usage: scripts/build-whisper-linux.sh [--arch x64|arm64]   (default: this machine's)
#
# Licence: whisper.cpp is MIT (its LICENSE ships next to the binary).
set -euo pipefail

tag="${VUNEMI_WHISPER_TAG:-v1.9.4}"
commit="${VUNEMI_WHISPER_COMMIT:-927cfce34f31707e17f2bff35c349632fb9e2c3a}"

if [ "$(uname -s)" != "Linux" ]; then
  echo "! bu betik Linux içindir; macOS için: scripts/build-whisper.sh" >&2
  exit 1
fi
source "$(dirname "$0")/linux/common.sh"
want=""
if [ "${1:-}" = "--arch" ]; then want="${2:-}"; fi
linux_target "$want"
out="${VUNEMI_BUILD_DIR:-$HOME/.vunemi-build}"
cache="$out/whisper-cache/$tag-linux-$arch"
src="$out/whisper-src/$tag"
build="$src/build-linux-$arch"

if [ -x "$cache/whisper-server" ] && [ "$(cat "$cache/ARCH" 2>/dev/null)" = "$arch" ] && ! grep -q -a -F "$HOME/" "$cache/whisper-server"; then
  echo "› ses motoru hazır ($tag, $arch)"
  exit 0
fi

if [ ! -d "$src/.git" ]; then
  echo "› whisper.cpp $tag indiriliyor"
  mkdir -p "$(dirname "$src")"
  git clone --quiet --depth 1 --branch "$tag" https://github.com/ggml-org/whisper.cpp.git "$src"
fi
actual="$(git -C "$src" rev-parse HEAD)"
if [ "$actual" != "$commit" ]; then
  echo "! $tag beklenen commit değil: $actual (beklenen $commit)"
  exit 1
fi

echo "› ses motoru derleniyor ($tag, $arch)"
rm -rf "$build"
cmake -S "$src" -B "$build" -DCMAKE_BUILD_TYPE=Release "${cmake_arch_args[@]}" \
  -DCMAKE_C_FLAGS="-ffile-prefix-map=$src=." -DCMAKE_CXX_FLAGS="-ffile-prefix-map=$src=." \
  -DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc" \
  -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
  -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF -DWHISPER_FFMPEG=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_SERVER=ON >/dev/null
cmake --build "$build" --config Release --target whisper-server -j "$(nproc)" >/dev/null
bin="$build/bin/whisper-server"

check_linux_binary "$bin" "ses motoru"
"$strip_tool" "$bin"
mkdir -p "$cache"
cp "$bin" "$cache/whisper-server"
cp "$src/LICENSE" "$cache/LICENSE"
echo "$arch" > "$cache/ARCH"
echo "› ses motoru hazır → $cache"
