#!/usr/bin/env bash
# Builds whisper.cpp's server — what Vunemi turns speech into text with —
# from a pinned release, once per release. The same rules as the language
# model's engine (build-engine.sh):
#
#  * From source, pinned to a commit: the binary ends up inside the signed app.
#  * Static, with the Metal library embedded: one file that runs on any Apple
#    Silicon Mac. Without this Vunemi needed Homebrew's whisper-cpp, which
#    someone who downloaded Vunemi from its site does not have.
#  * No SDL, no curl, no ffmpeg: it reads the WAV Vunemi sends it over plain
#    HTTP on 127.0.0.1, and the one model file Vunemi downloaded and checked.
set -euo pipefail

tag="${VUNEMI_WHISPER_TAG:-v1.9.4}"
commit="${VUNEMI_WHISPER_COMMIT:-927cfce34f31707e17f2bff35c349632fb9e2c3a}"
out="${VUNEMI_BUILD_DIR:-$HOME/.vunemi-build}"
cache="$out/whisper-cache/$tag"
src="$out/whisper-src/$tag"

# A copy built before paths were mapped still names this Mac's user folder; rebuild it.
if [ -x "$cache/whisper-server" ] && ! grep -q -a -F "$HOME/" "$cache/whisper-server"; then
  echo "› ses motoru hazır ($tag)"
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

echo "› ses motoru derleniyor ($tag)"
cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="-ffile-prefix-map=$src=." -DCMAKE_CXX_FLAGS="-ffile-prefix-map=$src=." -DCMAKE_OBJC_FLAGS="-ffile-prefix-map=$src=." \
  -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF -DWHISPER_FFMPEG=OFF -DWHISPER_COREML=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_SERVER=ON >/dev/null
cmake --build "$src/build" --config Release --target whisper-server -j "$(sysctl -n hw.ncpu)" >/dev/null

# Only macOS's own libraries: anything else would be missing on another Mac.
if otool -L "$src/build/bin/whisper-server" | tail -n +2 | grep -Ev '^[[:space:]]*(/usr/lib/|/System/Library/)'; then
  echo "! ses motoru sistem dışı bir kütüphaneye bağlı"
  exit 1
fi

# Build paths are the builder's folders; the shipped binary must not name them.
if grep -q -a -F "$HOME/" "$src/build/bin/whisper-server"; then
  echo "! ses motoru derleme yolunu (kullanıcı klasörü) içeriyor"
  exit 1
fi
mkdir -p "$cache"
cp "$src/build/bin/whisper-server" "$cache/whisper-server"
cp "$src/LICENSE" "$cache/LICENSE"
echo "› ses motoru hazır → $cache"
