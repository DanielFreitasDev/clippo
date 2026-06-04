#!/usr/bin/env bash
#
# Installs Clippo by symlinking the project directory into the GNOME extensions
# folder and compiling the schemas. Edits to the project stay "live" (just log
# out and back in for gnome-shell to reload the code on Wayland).

set -euo pipefail

UUID="clippo@danielfreitasdev.github.io"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

# Compile the schemas in the project itself (required in symlink mode).
glib-compile-schemas "$SRC/schemas"

# Compile translations (po/<lang>.po -> locale/<lang>/LC_MESSAGES/clippo.mo).
# Optional: without them — or without gettext installed — the UI stays English.
if command -v msgfmt >/dev/null 2>&1; then
    for po in "$SRC"/po/*.po; do
        [ -e "$po" ] || continue
        lang="$(basename "$po" .po)"
        mo_dir="$SRC/locale/$lang/LC_MESSAGES"
        mkdir -p "$mo_dir"
        msgfmt "$po" -o "$mo_dir/clippo.mo"
        echo "Compiled translation: $lang"
    done
else
    echo "warning: 'msgfmt' not found — skipping translations (UI stays English)." >&2
    echo "         install it with: sudo apt install gettext, then re-run ./install.sh" >&2
fi

mkdir -p "$(dirname "$DEST")"
ln -sfn "$SRC" "$DEST"

echo "Clippo installed: $DEST -> $SRC"
echo
echo "Next steps:"
echo "  1. Log out and back in (on Wayland you can't restart gnome-shell)."
echo "  2. Enable the extension:"
echo "       gnome-extensions enable $UUID"
echo "  3. Set the open-history shortcut in the preferences (Super+V is a good"
echo "     choice) — or click the top-bar icon."
echo
echo "Preferences:  gnome-extensions prefs $UUID"
echo "Logs:         journalctl -f -o cat /usr/bin/gnome-shell"
