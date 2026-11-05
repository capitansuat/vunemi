#!/usr/bin/env bash
# Runs a command with an unlocked GNOME Keyring, for the Linux smoke run.
# Use inside a private D-Bus session, e.g.:
#   dbus-run-session -- scripts/linux-smoke/with-keyring.sh xvfb-run -a node scripts/linux-smoke/smoke.mjs <app>
# The keyring password is synthetic test data. Needs gnome-keyring.
export XDG_CURRENT_DESKTOP=GNOME
eval "$(printf 'synthetic-keyring-pass' | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)"
export GNOME_KEYRING_CONTROL
exec "$@"
