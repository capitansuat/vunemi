#!/usr/bin/env bash
# Builds sherpa-onnx's speaker diarization program — what Vunemi tells the
# others in a meeting apart with — from a pinned release, once per release.
# The same rules as the other engines (build-engine.sh, build-whisper.sh):
#
#  * From source, pinned to a commit: the binary ends up inside the signed app.
#  * Static: one file that runs on any Apple Silicon Mac.
#  * Only what it needs: no speech synthesis, no microphone, no network code.
#    It reads the WAV and the two model files Vunemi names, and prints who
#    spoke when.
#
# One part is not compiled here. sherpa-onnx's build fetches its dependencies
# as source archives, each checked against the SHA-256 in its own cmake files
# at the pinned commit; ONNX Runtime (MIT, Microsoft) alone comes as a static
# library compiled by sherpa-onnx's maintainer
# (github.com/csukuangfj/onnxruntime-libs), checked the same way.
set -euo pipefail

tag="${VUNEMI_SPEAKERS_TAG:-v1.13.8}"
commit="${VUNEMI_SPEAKERS_COMMIT:-11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf}"
out="${VUNEMI_BUILD_DIR:-$HOME/.vunemi-build}"
cache="$out/speakers-cache/$tag"
src="$out/speakers-src/$tag"
name="sherpa-onnx-offline-speaker-diarization"

if [ -x "$cache/$name" ] && [ -s "$cache/LICENSE" ] && ! grep -q -a -F "$HOME/" "$cache/$name"; then
  echo "› konuşmacı motoru hazır ($tag)"
  exit 0
fi

if [ ! -d "$src/.git" ]; then
  echo "› sherpa-onnx $tag indiriliyor"
  mkdir -p "$(dirname "$src")"
  git clone --quiet --depth 1 --branch "$tag" https://github.com/k2-fsa/sherpa-onnx.git "$src"
fi
actual="$(git -C "$src" rev-parse HEAD)"
if [ "$actual" != "$commit" ]; then
  echo "! $tag beklenen commit değil: $actual (beklenen $commit)"
  exit 1
fi

echo "› konuşmacı motoru derleniyor ($tag)"
# A copy of ONNX Runtime installed on this Mac must not be picked up: the
# build uses the one its own cmake files pin.
env -u SHERPA_ONNXRUNTIME_LIB_DIR -u SHERPA_ONNXRUNTIME_INCLUDE_DIR \
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="-ffile-prefix-map=$src=." -DCMAKE_CXX_FLAGS="-ffile-prefix-map=$src=." \
  -DBUILD_SHARED_LIBS=OFF -DSHERPA_ONNX_USE_PRE_INSTALLED_ONNXRUNTIME_IF_AVAILABLE=OFF \
  -DSHERPA_ONNX_ENABLE_BINARY=ON -DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=ON \
  -DSHERPA_ONNX_ENABLE_TTS=OFF -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF -DSHERPA_ONNX_ENABLE_TESTS=OFF -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_GPU=OFF -DSHERPA_ONNX_BUILD_C_API_EXAMPLES=OFF >/dev/null
cmake --build "$src/build" --config Release --target "$name" -j "$(sysctl -n hw.ncpu)" >/dev/null

built="$src/build/bin/$name"

# Only macOS's own libraries: anything else would be missing on another Mac.
if otool -L "$built" | tail -n +2 | grep -Ev '^[[:space:]]*(/usr/lib/|/System/Library/)'; then
  echo "! konuşmacı motoru sistem dışı bir kütüphaneye bağlı"
  exit 1
fi

# Build paths are the builder's folders; the shipped binary must not name them.
if grep -q -a -F "$HOME/" "$built"; then
  echo "! konuşmacı motoru derleme yolunu (kullanıcı klasörü) içeriyor"
  exit 1
fi

# The notices of everything linked into the one file: sherpa-onnx's own, then
# each dependency's as its archive carries it.
notices="$(mktemp -t vunemi-speakers-licenses)"
{
  echo "sherpa-onnx $tag"
  echo
  cat "$src/LICENSE"
  for dep in "$src"/build/_deps/*-src; do
    [ -d "$dep" ] || continue
    for file in "$dep"/LICENSE* "$dep"/COPYING* "$dep"/ThirdPartyNotices*; do
      [ -f "$file" ] || continue
      printf '\n\n==== %s: %s ====\n\n' "$(basename "$dep" -src)" "$(basename "$file")"
      cat "$file"
    done
  done
} >"$notices"

mkdir -p "$cache"
cp "$built" "$cache/$name"
cp "$notices" "$cache/LICENSE"
echo "› konuşmacı motoru hazır → $cache"
