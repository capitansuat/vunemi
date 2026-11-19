#!/usr/bin/env bash
# Builds the MarkItDown add-on: Microsoft's MarkItDown (MIT), which turns
# Office files, PDFs, web pages and more into Markdown, with a Python of its
# own, as one zip for Vunemi's release page (the add-on shelf).
#
# Why Vunemi builds it. The other add-ons are their projects' own signed,
# notarized programs. MarkItDown is published only as a Python package, so
# there is no such program to take. This makes one, from pinned parts only:
#
#  * Python is python-build-standalone's build, pinned by SHA-256: it needs
#    nothing that a Mac does not have.
#  * MarkItDown and every package it needs are pinned by version and hash in
#    markitdown/requirements.lock, and only prebuilt wheels are accepted:
#    nothing is compiled here, nothing is fetched that the lock did not name.
#  * Only the extras for local files. Speech (Google), YouTube and Azure are
#    left out; the add-on also runs with no network (see addons/sandbox.ts).
#
# Run it on an Apple Silicon Mac: the result is tried there before it is
# zipped. It prints the zip's size and SHA-256, which go into
# apps/desktop/src/main/addons/catalog.ts after the zip is uploaded to the
# shelf release.
#
# VUNEMI_MARKITDOWN_TARGET=x86_64-unknown-linux-gnu builds the same thing for
# Linux, to try the tools there; it is not shipped.
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
zip="$out/$folder.zip"
stage="$out/stage"
py_file="cpython-$py_version+$py_release-$target-install_only_stripped.tar.gz"

sha256() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

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

# Compiled once here: in the sandbox the folder is read only, and pandas or
# sympy compiled again on every run would cost seconds each time.
# -s: the compiled files name their sources from the add-on's folder, not this one.
"$py" -I -B -m compileall -f -q -j 0 --invalidation-mode unchecked-hash -s "$root" "$lib" >/dev/null

cat > "$root/markitdown" <<'LAUNCH'
#!/bin/sh
# Vunemi's MarkItDown add-on. -I: no environment variables, no user site, no
# current folder on the import path; only this folder's Python and packages.
exec "${0%/*}/python/bin/python3.12" -I -m markitdown "$@"
LAUNCH
chmod 755 "$root/markitdown"

mkdir -p "$root/licenses"
cp "$lib/LICENSE.txt" "$root/licenses/python-LICENSE.txt"
cat > "$root/README.txt" <<EOF
MarkItDown $version (https://github.com/microsoft/markitdown), MIT licence,
Copyright (c) Microsoft Corporation, with Python $py_version from
python-build-standalone $py_release. Built for Vunemi by scripts/build-markitdown.sh.

Every package's licence is in its folder under
python/lib/python3.12/site-packages/*.dist-info; Python's is in licenses/.
EOF

# The build folder is in this Mac's user folder; the shipped files must not name it.
if grep -r -q -a -F "$out" "$root"; then
  echo "! paket derleme yolunu içeriyor:"
  grep -r -l -a -F "$out" "$root" | head
  exit 1
fi

echo "› paketleniyor"
rm -f "$zip"
# The same files give the same zip: fixed times, sorted names, modes kept.
"$py" -I - "$stage" "$folder" "$zip" <<'PY'
import os, stat, sys, zipfile
stage, folder, out = sys.argv[1:]
entries = []
for base, dirs, files in os.walk(os.path.join(stage, folder)):
    dirs.sort()
    for name in sorted(files):
        entries.append(os.path.join(base, name))
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for path in sorted(entries):
        rel = os.path.relpath(path, stage)
        info = zipfile.ZipInfo(rel, (1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        if os.path.islink(path):
            info.external_attr = (stat.S_IFLNK | 0o755) << 16
            z.writestr(info, os.readlink(path))
            continue
        mode = os.stat(path).st_mode & 0o777
        info.external_attr = (stat.S_IFREG | (0o755 if mode & 0o111 else 0o644)) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        with open(path, "rb") as f:
            z.writestr(info, f.read())
PY

# Tried from the zip itself, unpacked the way Vunemi unpacks it, so what is
# tried is what is shipped.
native=no
case "$target/$(uname -sm)" in "aarch64-apple-darwin/Darwin arm64"|"x86_64-unknown-linux-gnu/Linux x86_64") native=yes ;; esac
if [ "$native" = yes ]; then
  echo "› deneniyor"
  try="$(mktemp -d)"
  if [ -x /usr/bin/ditto ]; then /usr/bin/ditto -x -k "$zip" "$try"; else "$py" -I -c 'import sys,zipfile,os
z=zipfile.ZipFile(sys.argv[1])
for i in z.infolist():
    z.extract(i, sys.argv[2]); os.chmod(os.path.join(sys.argv[2], i.filename), (i.external_attr >> 16) & 0o777)' "$zip" "$try"; fi
  printf '<html><body><h1>Vunemi</h1><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>' > "$try/t.html"
  "$try/$folder/markitdown" "$try/t.html" -o "$try/t.md"
  if ! grep -q "^# Vunemi" "$try/t.md" || ! grep -q "| a | b |" "$try/t.md"; then echo "! deneme çıktısı beklenen gibi değil:"; cat "$try/t.md"; rm -rf "$try"; exit 1; fi
  rm -rf "$try"
fi

echo "› hazır → $zip"
echo "  boyut:   $(wc -c < "$zip" | tr -d ' ')"
echo "  sha256:  $(sha256 "$zip")"
