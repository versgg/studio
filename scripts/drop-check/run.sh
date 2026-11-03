#!/bin/bash
# Real drag-and-drop into Studio on Linux: GTK4 file drags (as GNOME Files makes them) dropped on
# the library, its tabs, the player, the Inspector, the timeline and the Audio page, in a GNOME
# Shell with no screen, so nothing shows on the desktop. STUDIO_UI_APP=<dir> checks a staged
# copy; DROP_SCALE=1.3333 a scaled screen; DROP_KEEP=1 keeps the work folder.
D=$(cd "$(dirname "$0")" && pwd)
command -v gnome-shell >/dev/null || { echo "drop-check: needs GNOME Shell (Linux)"; exit 2; }
# The hidden desktop's own services (portals, keyring, calendar) talk as they start and as it shuts
# down; that's kept aside and shown only when the check fails. The check itself prints on fd 3.
LOG=$(mktemp "${TMPDIR:-/tmp}/studio-drop-check-log.XXXXXX")
systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 -- dbus-run-session -- "$D/inner.sh" 3>&1 >"$LOG" 2>&1
CODE=$?
[ $CODE -ne 0 ] && { echo "drop-check: the hidden desktop's last messages:"; tail -n 30 "$LOG"; } >&2
rm -f "$LOG"
exit $CODE
