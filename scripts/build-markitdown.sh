#!/usr/bin/env bash
# Builds MarkItDown, Microsoft's converter of Office files, PDFs, web pages
# and more to Markdown (MIT), with a Python of its own, for the app's
# resources. scripts/package.sh calls it; a development run uses the folder
# it leaves in the build cache.
#
# MarkItDown is published only as a Python package, so this makes a program
# of it, from pinned parts only:
#
#  * Python is python-build-standalone's build, pinned by SHA-256: it needs
#    nothing that a Mac does not have.
#  * MarkItDown and every package it needs are pinned by version and hash in
#    markitdown/requirements.lock, and only prebuilt wheels are accepted:
#    nothing is compiled here, nothing is fetched that the lock did not name.
#  * Only the extras for local files. Speech (Google), YouTube and Azure are
#    left out; it also runs with no network (see apps/desktop/src/main/addons/sandbox.ts).
#  * Vunemi runs it through markitdown/convert.py: several files in one run,
#    so Python starts once for all of them.
#
# Built once per version, like the engine; the same lock gives the same files.
#
# VUNEMI_MARKITDOWN_TARGET=x86_64-unknown-linux-gnu builds the same thing for
# Linux, to try it there; it is not shipped.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
version="0.1.9"
py_release="20261110"
py_version="3.12.16"
target="${VUNEMI_MARKITDOWN_TARGET:-aarch64-apple-darwin}"
case "$target" in
  aarch64-apple-darwin) py_sha="2f11b8aa3726bdbd87dd9eb76568412faddf4f47e26913fa45d6a2e424972acd"; label="macos-arm64" ;;
  x86_64-unknown-linux-gnu) py_sha="6a9e62dad033790aef722dbd370e0ce76ce17b73627ba3ae679f537049350b39"; label="linux-x86_64" ;;
  *) echo "! bilinmeyen hedef: $target"; exit 1 ;;
esac

out="${VUNEMI_BUILD_DIR:-$HOME/.vunemi-build}/markitdown"
folder="markitdown-$version-$label"
cache="$out/$version/$folder"
stage="$out/.stage"
py_file="cpython-$py_version+$py_release-$target-install_only_stripped.tar.gz"
# What the build is made from: a change to any of these builds it again.
inputs="$(cat "$0" "$here/markitdown/requirements.lock" "$here/markitdown/convert.py" "$here/markitdown/markitdown-LICENSE")"

sha256() {
  if command -v shasum >/dev/null; then shasum -a 256 "$@" | cut -d' ' -f1; else sha256sum "$@" | cut -d' ' -f1; fi
}
key="$(printf '%s' "$inputs" | sha256 -)"

if [ -x "$cache/convert" ] && [ "$(cat "$cache/.built-from" 2>/dev/null)" = "$key" ]; then
  echo "› MarkItDown hazır ($version)"
  exit 0
fi

mkdir -p "$out"
if [ ! -f "$out/$py_file" ] || [ "$(sha256 "$out/$py_file")" != "$py_sha" ]; then
  echo "› Python $py_version indiriliyor"
  curl -fsSL -o "$out/$py_file.part" "https://github.com/astral-sh/python-build-standalone/releases/download/$py_release/${py_file//+/%2B}"
  mv "$out/$py_file.part" "$out/$py_file"
fi
if [ "$(sha256 "$out/$py_file")" != "$py_sha" ]; then
  echo "! Python arşivi beklenen SHA-256 değil"
  rm -f "$out/$py_file"
  exit 1
fi

rm -rf "$stage"
mkdir -p "$stage/$folder"
tar -xzf "$out/$py_file" -C "$stage/$folder"
root="$stage/$folder"
py="$root/python/bin/python3.12"
lib="$root/python/lib/python3.12"

echo "› MarkItDown $version ve bağımlılıkları kuruluyor (yalnızca kilitli, hazır paketler)"
"$py" -I -m pip install --quiet --disable-pip-version-check --no-cache-dir --no-compile \
  --only-binary=:all: --require-hashes --no-warn-script-location \
  -r "$here/markitdown/requirements.lock"

echo "› gereksizler çıkarılıyor"
# The installer and what only a person at a terminal uses: no job here needs them.
rm -rf "$lib"/site-packages/pip "$lib"/site-packages/pip-*.dist-info "$lib/ensurepip" "$lib/idlelib" "$lib/tkinter" "$lib/turtledemo" "$lib/lib2to3"
rm -f "$lib"/lib-dynload/_tkinter*.so
rm -rf "$root/python/lib"/tcl* "$root/python/lib"/tk* "$root/python/lib"/itcl* "$root/python/lib"/thread* "$root/python/share" "$root/python/include"
# Scripts pip wrote name this build folder; the launcher below is the only way in.
find "$root/python/bin" -mindepth 1 ! -name python3.12 -exec rm -rf {} +
find "$root/python" -name "__pycache__" -type d -prune -exec rm -rf {} +
find "$root/python" \( -name "tests" -o -name "test" \) -type d -path "*site-packages*" -prune -exec rm -rf {} +
rm -rf "$lib/test"
# olefile ships its old Python 2 module too; nothing imports it and it does not compile.
rm -f "$lib/site-packages/olefile/olefile2.py"
# onnxruntime (for magika, which tells file kinds apart) needs sympy only for its
# model-building tools, which magika never loads; together about 50 MB.
rm -rf "$lib/site-packages/sympy" "$lib/site-packages/mpmath" "$lib"/site-packages/onnxruntime/{transformers,tools,quantization}

cp "$here/markitdown/convert.py" "$root/convert.py"
# Compiled once here: in the sandbox the folder is read only, and pandas
# compiled again on every run would cost seconds each time.
# -s: the compiled files name their sources from this folder's own root, not the build folder.
"$py" -I -B -m compileall -f -q -j 0 --invalidation-mode unchecked-hash -s "$root" "$lib" >/dev/null

cat > "$root/convert" <<'LAUNCH'
#!/bin/sh
# Vunemi's way into MarkItDown: convert IN OUT [IN OUT ...] (see convert.py).
# -I: no environment variables, no user site, no current folder on the import
# path; only this folder's Python and packages.
exec "${0%/*}/python/bin/python3.12" -I "${0%/*}/convert.py" "$@"
LAUNCH
chmod 755 "$root/convert"

mkdir -p "$root/licenses"
cp "$lib/LICENSE.txt" "$root/licenses/python-LICENSE.txt"
# The wheel carries no licence file; this is the repository's LICENSE, as published.
cp "$here/markitdown/markitdown-LICENSE" "$root/licenses/markitdown-LICENSE"
cat > "$root/README.txt" <<EOF
MarkItDown $version (https://github.com/microsoft/markitdown), MIT licence,
Copyright (c) Microsoft Corporation, with Python $py_version from
python-build-standalone $py_release. Built for Vunemi by scripts/build-markitdown.sh.

Every package's licence is in its folder under
python/lib/python3.12/site-packages/*.dist-info; Python's and MarkItDown's are in licenses/.
EOF

# The build folder is in this Mac's user folder; the shipped files must not name it.
if grep -r -q -a -F "$out" "$root"; then
  echo "! paket derleme yolunu içeriyor:"
  grep -r -l -a -F "$out" "$root" | head
  exit 1
fi

native=no
case "$target/$(uname -sm)" in "aarch64-apple-darwin/Darwin arm64"|"x86_64-unknown-linux-gnu/Linux x86_64") native=yes ;; esac
if [ "$native" = yes ]; then
  echo "› deneniyor"
  try="$(mktemp -d)"
  printf '<html><body><h1>Vunemi</h1><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>' > "$try/t.html"
  # -B for the trial: the folder must stay as built, with no caches of the run.
  said="$("$py" -I -B "$root/convert.py" "$try/t.html" "$try/t.md" "$try/none.docx" "$try/none.md")"
  if ! grep -q "^# Vunemi" "$try/t.md" || ! grep -q "| a | b |" "$try/t.md" || [ "$(printf '%s\n' "$said" | grep -c '"ok": true')" != 1 ] || [ "$(printf '%s\n' "$said" | grep -c '"ok": false')" != 1 ]; then
    echo "! deneme çıktısı beklenen gibi değil:"; printf '%s\n' "$said"; cat "$try/t.md" 2>/dev/null; rm -rf "$try"; exit 1
  fi
  rm -rf "$try"
fi

printf '%s' "$key" > "$root/.built-from"
rm -rf "$out/$version"
mkdir -p "$out/$version"
mv "$root" "$cache"
rm -rf "$stage"
echo "› MarkItDown hazır → $cache ($(du -sh "$cache" | cut -f1))"
