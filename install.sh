#!/usr/bin/env bash
#
# Installs Clippo by symlinking the project directory into the GNOME extensions
# folder and compiling the schemas. Edits to the project stay "live" (just log
# out and back in for gnome-shell to reload the code on Wayland).

set -euo pipefail

UUID="clippo@daniel.local"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

# Compile the schemas in the project itself (required in symlink mode).
glib-compile-schemas "$SRC/schemas"

mkdir -p "$(dirname "$DEST")"
ln -sfn "$SRC" "$DEST"

echo "Clippo installed: $DEST -> $SRC"
echo
echo "Next steps:"
echo "  1. Log out and back in (on Wayland you can't restart gnome-shell)."
echo "  2. Enable the extension:"
echo "       gnome-extensions enable $UUID"
echo "  3. Press Super+V to open the history."
echo
echo "Preferences:  gnome-extensions prefs $UUID"
echo "Logs:         journalctl -f -o cat /usr/bin/gnome-shell"
