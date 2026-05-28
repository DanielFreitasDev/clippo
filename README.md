# Clippo

**English** · [Português (Brasil)](README.pt-BR.md)

Clipboard history manager for the **GNOME Shell** (Wayland), built as a native
GNOME extension. It captures everything you copy and opens your history at the
pointer with **Super+V**.

## Features

- Automatically captures everything you copy (text).
- **Super+V** opens the popup at the pointer.
- History in descending order (the most recent copy on top).
- Shows the last **25** copies by default (configurable from 1 to 500).
- Auto-focused search bar: type to filter, clear it to return to the full list.
- Keyboard navigation: **↑/↓** to move, **Enter** to select, **Delete** to remove, **Esc** to close.
- Selecting an item puts it back on the clipboard (paste with **Ctrl+V**) and closes the window.
- The window closes on selection, on Esc, on click-outside, or when it loses focus.
- **Pinned items (favorites):** click the star; they stay on top and never fall off the limit.
- **Clear history:** the trash button (keeps the pinned items).
- **Top-bar icon** (optional) to open it with the mouse.
- Persists across logout/reboot in `~/.local/share/clippo/history.json` (`600` permissions).
- Starts with your session (Shell extensions run at login — no autostart needed).
- **Localized UI:** follows your system language — English and Brazilian Portuguese included, with English as the fallback.

## Why a GNOME extension?

On GNOME/Wayland, only the Shell process has privileged background access to the
clipboard (`Meta.Selection`), can register a global shortcut like Super+V, and
can place a window at the pointer. Standalone apps (CopyQ, etc.) can't do this on
GNOME Wayland.

## Installation

```bash
./install.sh
```

Then:

1. **Log out and back in** (on Wayland gnome-shell can't be restarted in-session).
2. Enable it:
   ```bash
   gnome-extensions enable clippo@daniel.local
   ```
3. Press **Super+V**.

> While it's active, Clippo takes over the **Super+V** shortcut (normally used by
> the *message tray*); **Super+M** still opens the tray. When you disable the
> extension, Super+V is handed back to the tray.

## Preferences

```bash
gnome-extensions prefs clippo@daniel.local
```

Lets you adjust the number of items, show/hide the top-bar icon, and change the shortcut.

## Development

The extension is pure JavaScript (GJS, ESM, GNOME 45+), with **no build step** —
the project files are the code itself (symlinked by `install.sh`).

- To apply code changes: **log out / back in** (a Wayland limitation).
- To re-run `enable()`/`disable()` without new code:
  ```bash
  gnome-extensions disable clippo@daniel.local && gnome-extensions enable clippo@daniel.local
  ```
- Shell logs:
  ```bash
  journalctl -f -o cat /usr/bin/gnome-shell
  ```
- Interactive console: `Alt+F2` → `lg` → Enter (Looking Glass).
- After changing `schemas/*.gschema.xml`, recompile: `glib-compile-schemas schemas/`.

### Translations

The UI is localized with gettext (domain `clippo`). Source strings are in
English; translations live in `po/<lang>.po` and are compiled to
`locale/<lang>/LC_MESSAGES/clippo.mo` by `install.sh` (needs the `gettext`
package — `sudo apt install gettext`). With no compiled translation for the
active locale, the UI falls back to English.

To add a language, copy `po/clippo.pot` to `po/<lang>.po` (e.g. `po/fr.po`),
fill in each `msgstr`, and re-run `./install.sh`. After changing strings in the
code, regenerate the template:

```bash
xgettext --from-code=UTF-8 -L JavaScript --keyword=_ -o po/clippo.pot prefs.js lib/*.js
```

### Packaging for distribution

```bash
gnome-extensions pack --extra-source=lib --extra-source=stylesheet.css --podir=po .
gnome-extensions install --force clippo@daniel.local.shell-extension.zip
```

## Structure

| File | Role |
|---|---|
| `extension.js` | Lifecycle; wires monitor ↔ store ↔ popup ↔ icon; shortcut. |
| `lib/clipboardManager.js` | Watches the clipboard (`Meta.Selection`), emits `text-copied`. |
| `lib/historyStore.js` | History + pinned items in memory and in atomic JSON. |
| `lib/clipboardPopup.js` | Popup UI: search, list, keyboard, modal grab, dismissal. |
| `lib/indicator.js` | Top-bar icon. |
| `prefs.js` | Preferences (libadwaita). |
| `schemas/` | GSettings schema (`max-items`, `toggle-clippo`, `show-indicator`). |
| `po/` | Translation catalogs (gettext); compiled to `locale/` at install. |

## Known limitations / roadmap

- **Text only** in v1 (images come later).
- Clippo captures copied **passwords** like any other text. Current mitigation: the `600` file.
  Future: a private mode, ignoring sensitive content, and per-app exclusions.
