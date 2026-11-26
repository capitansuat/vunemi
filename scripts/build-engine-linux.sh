#!/usr/bin/env bash
# Builds llama.cpp's server for Linux — the engine Vunemi runs downloaded
# models with — from the same pinned release as the macOS and Windows builds
# (engine-version.sh), once per release and architecture. One arm64 machine
# builds both: arm64 natively, x64 with Ubuntu's cross compiler.
#
# Usage: scripts/build-engine-linux.sh [--arch x64|arm64]   (default: this machine's)
#
#  * From source, pinned to a commit: the binary ends up inside the package,
#    so it must be something we can rebuild and account for.
#  * CPU only, for now: no CUDA, ROCm or Vulkan runtime to find on the user's
#    machine. GGML_NATIVE is off so it runs on any CPU of the architecture,
#    not just the builder's.
#  * Static where it matters: no OpenMP runtime, libstdc++ and libgcc linked
#    in, so only glibc's own libraries are needed at run time.
#  * No OpenSSL, no downloads of its own, no subprocesses: plain HTTP on
#    127.0.0.1 and the one model file Vunemi downloaded and checked.
#
# Licence: llama.cpp is MIT (its LICENSE ships next to the binary).
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "! bu betik Linux içindir; macOS için: scripts/build-engine.sh" >&2
  exit 1
fi
source "$(dirname "$0")/engine-version.sh"
source "$(dirname "$0")/linux/common.sh"
tag="$engine_tag"
commit="$engine_commit"
want=""
if [ "${1:-}" = "--arch" ]; then want="${2:-}"; fi
linux_target "$want"
out="${VUNEMI_BUILD_DIR:-$HOME/.vunemi-build}"
cache="$out/engine-cache/$tag-linux-$arch"
src="$out/engine-src/$tag"
build="$src/build-linux-$arch"

if [ -x "$cache/llama-server" ] && [ "$(cat "$cache/ARCH" 2>/dev/null)" = "$arch" ] && ! grep -q -a -F "$HOME/" "$cache/llama-server"; then
  echo "› motor hazır ($tag, $arch)"
  exit 0
fi

if [ ! -d "$src/.git" ]; then
  echo "› llama.cpp $tag indiriliyor"
  mkdir -p "$(dirname "$src")"
  git clone --quiet --depth 1 --branch "$tag" https://github.com/ggml-org/llama.cpp.git "$src"
fi
actual="$(git -C "$src" rev-parse HEAD)"
if [ "$actual" != "$commit" ]; then
  echo "! $tag beklenen commit değil: $actual (beklenen $commit)"
  exit 1
fi

echo "› motor derleniyor ($tag, $arch)"
rm -rf "$build"
cmake -S "$src" -B "$build" -DCMAKE_BUILD_TYPE=Release "${cmake_arch_args[@]}" \
  -DCMAKE_C_FLAGS="-ffile-prefix-map=$src=." -DCMAKE_CXX_FLAGS="-ffile-prefix-map=$src=." \
  -DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc" \
  -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
  -DLLAMA_OPENSSL=OFF -DLLAMA_SUBPROCESS=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON >/dev/null
cmake --build "$build" --config Release --target llama-server -j "$(nproc)" >/dev/null
bin="$build/bin/llama-server"

# The target's machine, only glibc's own libraries (anything else may be missing elsewhere), no builder path.
check_linux_binary "$bin" motor
"$strip_tool" "$bin"
mkdir -p "$cache"
cp "$bin" "$cache/llama-server"
cp "$src/LICENSE" "$cache/LICENSE"
echo "$arch" > "$cache/ARCH"
echo "› motor hazır → $cache"
