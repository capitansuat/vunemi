#!/usr/bin/env bash
# Starts an installed Vunemi (the .deb puts `vunemi` on PATH) on a virtual
# display and reports whether its window opened. For a distribution build,
# which refuses remote debugging, so the window is looked for in X itself.
# Used on a clean Ubuntu 22.04 after `apt install ./Vunemi-*.deb`.
# Needs: xvfb, x11-utils; imagemagick for the screenshot (optional).
# Usage: start-installed.sh [screenshot.png]
set -u
work="$(mktemp -d)"
export HOME="$work/home" LANG="${LANG:-en_US.UTF-8}" DISPLAY=:77
mkdir -p "$HOME/Documents"
Xvfb :77 -screen 0 1440x900x24 >"$work/xvfb.log" 2>&1 &
xvfb=$!
sleep 2
vunemi --no-sandbox >"$work/vunemi.log" 2>&1 &
app=$!
opened=no
for i in $(seq 1 40); do
  if xwininfo -root -tree 2>/dev/null | grep -qE '^ +0x[0-9a-f]+ "Vunemi":'; then opened=yes; break; fi
  sleep 1
done
echo "window: $opened (after ${i}s)"
xwininfo -root -tree 2>/dev/null | grep -E '^ +0x[0-9a-f]+ "Vunemi":' | head -3
sleep 5
if kill -0 "$app" 2>/dev/null; then echo "process: alive"; else echo "process: exited"; fi
if [ -n "${1:-}" ] && command -v import >/dev/null; then import -window root "$1" && echo "screenshot: $1"; fi
kill "$app" 2>/dev/null; sleep 2; kill -9 "$app" 2>/dev/null; kill "$xvfb" 2>/dev/null
echo "log: $work/vunemi.log"
[ "$opened" = yes ]
