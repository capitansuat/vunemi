#!/usr/bin/env bash
# Builds llama.cpp's server — the engine Vunemi runs downloaded models with —
# from a pinned release, once per release.
#
#  * From source, pinned to a commit: the binary ends up inside the signed app,
#    so it must be something we can rebuild and account for.
#  * Static, with the Metal library embedded: one file that runs on any Apple
#    Silicon Mac, with nothing to find at run time.
#  * No OpenSSL, no downloads of its own, no subprocesses: it serves plain
#    HTTP on 127.0.0.1 and reads the one model file Vunemi downloaded and
#    checked. (With OpenSSL on, it also links Homebrew's copy, which another
#    Mac does not have.)
set -euo pipefail

tag="${VUNEMI_ENGINE_TAG:-v0.5.0}"
commit="${VUNEMI_ENGINE_COMMIT:-7fe450e19305b828c199d602c23a8337aaa1f03b}"
out="${VUNEMI_BUILD_DIR:-$HOME/.vunemi-build}"
cache="$out/engine-cache/$tag"
src="$out/engine-src/$tag"

# A copy built before paths were mapped still names this Mac's user folder; rebuild it.
if [ -x "$cache/llama-server" ] && ! grep -q -a -F "$HOME/" "$cache/llama-server"; then
  echo "› motor hazır ($tag)"
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

echo "› motor derleniyor ($tag)"
cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="-ffile-prefix-map=$src=." -DCMAKE_CXX_FLAGS="-ffile-prefix-map=$src=." -DCMAKE_OBJC_FLAGS="-ffile-prefix-map=$src=." \
  -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DLLAMA_OPENSSL=OFF -DLLAMA_SUBPROCESS=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON >/dev/null
cmake --build "$src/build" --config Release --target llama-server -j "$(sysctl -n hw.ncpu)" >/dev/null

# Only macOS's own libraries: anything else would be missing on another Mac.
if otool -L "$src/build/bin/llama-server" | tail -n +2 | grep -Ev '^[[:space:]]*(/usr/lib/|/System/Library/)'; then
  echo "! motor sistem dışı bir kütüphaneye bağlı"
  exit 1
fi

# Build paths are the builder's folders; the shipped binary must not name them.
if grep -q -a -F "$HOME/" "$src/build/bin/llama-server"; then
  echo "! motor derleme yolunu (kullanıcı klasörü) içeriyor"
  exit 1
fi
mkdir -p "$cache"
cp "$src/build/bin/llama-server" "$cache/llama-server"
cp "$src/LICENSE" "$cache/LICENSE"
echo "› motor hazır → $cache"
