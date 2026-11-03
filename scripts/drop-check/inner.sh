#!/bin/bash
# Inside dbus-run-session: a GNOME Shell with no screen of its own, then check.mjs. Nothing here
# reaches the user's desktop: its own Wayland socket, no X display, settings in memory, a
# throwaway home.
D=$(cd "$(dirname "$0")" && pwd)
# What the check says goes to the terminal (fd 3 from run.sh); the desktop's services keep the rest.
exec >&3 2>&3 3>&-
W=$(mktemp -d "${TMPDIR:-/tmp}/studio-drop-check.XXXXXX")
export DROP_WORK=$W XDG_SESSION_TYPE=wayland GSETTINGS_BACKEND=memory
export HOME=$W/home XDG_CONFIG_HOME=$W/home/.config XDG_DATA_HOME=$W/home/.local/share XDG_CACHE_HOME=$W/home/.cache
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
unset DISPLAY
export WAYLAND_DISPLAY=studio-drop-$$
gnome-shell --headless --wayland --no-x11 --wayland-display "$WAYLAND_DISPLAY" --virtual-monitor "${DROP_SCREEN:-2800x1000}" >"$W/shell.log" 2>&1 &
SHELL_PID=$!
for i in $(seq 150); do [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break; sleep 0.1; done
sleep 2
[ -n "$DROP_SCALE" ] && python3 "$D/scale.py" "$DROP_SCALE" && sleep 1
node "$D/check.mjs"
CODE=$?
kill $SHELL_PID 2>/dev/null; wait $SHELL_PID 2>/dev/null
[ -z "$DROP_KEEP" ] && rm -rf "$W"
exit $CODE
