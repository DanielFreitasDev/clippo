# Clippo

**English** · [Português (Brasil)](README.pt-BR.md)

Clipboard history manager for the **GNOME Shell** (Wayland), built as a native
GNOME extension. It captures the text **and images** you copy and opens your
history at the pointer with **Super+V**.

## Features

- Captures text and, optionally, **images** you copy.
- **Super+V** opens the popup at the pointer.
- History in descending order (most recent on top), each item showing **how long ago** it was copied.
- Shows the last **25** copies by default (configurable from 1 to 500).
- Auto-focused search bar: type to filter, clear it to return to the full list.
- Keyboard navigation: **↑/↓** to move, **→** for item details, **Enter** to select, **Delete** to remove (**Shift+Delete** while searching), **Esc** to close.
- Selecting an item puts it back on the clipboard (paste with **Ctrl+V**) and closes the window.
- **Content-type detection:** links, colors, e-mails and code get a fitting icon/swatch, with a quick **open** action — plus an **Open with…** chooser to pick the app — for links and e-mails.
- **Edit before paste** and **QR code** generation for any text item (handy for sending a link to your phone).
- **Pinned items (favorites):** click the star; they stay on top and never fall off the limit. A header toggle filters the list to **pinned only**, and removing a pinned item asks for confirmation.
- **Paste next / previous:** optional shortcuts cycle the clipboard through the history with an on-screen preview, without opening the popup. **Unset by default** — assign them in preferences.
- **Privacy:** a **private mode** to pause capture (also a Quick Settings toggle); copies a password manager marks as secret are skipped; optional **per-app exclusion**; whitespace trimming; and optional primary-selection (middle-click) capture.
- **Clear history:** the trash button (keeps the pinned items).
- **Top-bar icon** (optional) to open it with the mouse.
- Persists across logout/reboot in `~/.local/share/clippo/` (`600` permissions; images as separate PNGs) — or turn **“Keep history across sessions” off** to keep it in memory only and wipe it at logout (nothing written to disk).
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

Lets you adjust the number of items; toggle the top-bar icon, content-type detection, **keep-history-across-sessions**, image capture, private mode, whitespace trimming and primary-selection capture; manage the excluded-apps list; and set the shortcuts — open history, plus the optional **paste next / previous** cycling keys.

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
xgettext --from-code=UTF-8 -L JavaScript --keyword=_ --keyword=ngettext:1,2 -o po/clippo.pot prefs.js lib/*.js
```

### Packaging for distribution

```bash
gnome-extensions pack --extra-source=lib --extra-source=stylesheet.css --podir=po .
gnome-extensions install --force clippo@daniel.local.shell-extension.zip
```

## Structure

| File | Role |
|---|---|
| `extension.js` | Lifecycle; wires monitor ↔ store ↔ popup ↔ icon ↔ quick toggle; shortcut. |
| `lib/clipboardManager.js` | Watches the clipboard (`Meta.Selection`), emits `text-copied` / `image-copied`. |
| `lib/historyStore.js` | History (text + image entries) in memory and in atomic JSON. |
| `lib/clipboardPopup.js` | Popup UI: search, list (pinned-only filter), item-detail / edit / QR / open-with / remove-confirm views, keyboard, modal grab. |
| `lib/contentType.js` | Pure helpers: detect URL/color/e-mail/code, build safe action URIs, and the “open with” content type. |
| `lib/quickToggle.js` | Quick Settings toggle for the private mode. |
| `lib/cycleOsd.js` | On-screen preview shown while cycling the clipboard (paste next/previous). |
| `lib/qrcodegen.js` | Vendored QR encoder (kazuhikoarase/qrcode-generator, MIT). |
| `lib/indicator.js` | Top-bar icon. |
| `prefs.js` | Preferences (libadwaita). |
| `schemas/` | GSettings schema (items, shortcut, indicator, privacy and capture options). |
| `po/` | Translation catalogs (gettext); compiled to `locale/` at install. |

## Known limitations / roadmap

- Captures text and images; other content types (e.g. rich files) are not stored.
- Clippo skips copies a **password manager** flags as secret (via the `x-kde-passwordManagerHint` hint), but a password copied from anywhere else is still captured like normal text. Mitigations: the `600` history file, the private mode, and per-app exclusion.
- Per-app exclusion is best-effort on Wayland (some clients expose no app id).
