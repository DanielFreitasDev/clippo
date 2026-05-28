# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Clippo is a **GNOME Shell extension** (UUID `clippo@daniel.local`) that adds clipboard history — not a standalone app. On GNOME/Wayland only the Shell process can read the clipboard in the background (`Meta.Selection`), register a global shortcut, and place a window at the pointer, so this lives inside the Shell as an extension.

Plain **GJS / ESM, no build step** — the files in this directory *are* the running code (installed via symlink). Targets GNOME Shell 48–50. Code comments are in US English. UI strings are English at the source and localized via gettext (domain `clippo`): translations live in `po/*.po`, compiled to `locale/` by `install.sh`; pt_BR ships, other locales fall back to the English source. A Portuguese README (`README.pt-BR.md`) is also kept for Brazilian readers.

## Development

`install.sh` symlinks the project into `~/.local/share/gnome-shell/extensions/<uuid>` and compiles the GSettings schema. Because of the symlink, edits are "live" on disk — but on **Wayland the Shell cannot reload running JS without a logout/login**, so:

- After editing `extension.js` / `lib/*`: **log out and back in**, then `gnome-extensions enable clippo@daniel.local`.
- To re-run `enable()`/`disable()` without new code (e.g. testing lifecycle teardown): `gnome-extensions disable clippo@daniel.local && gnome-extensions enable clippo@daniel.local`.
- After editing `schemas/*.gschema.xml`: `glib-compile-schemas schemas/` (install.sh also does this).
- After editing UI strings or `po/*.po`: re-run `install.sh` to recompile the `.mo` files (needs `gettext`/`msgfmt`). Regenerate the template with `xgettext --from-code=UTF-8 -L JavaScript --keyword=_ -o po/clippo.pot prefs.js lib/*.js`.
- Logs: `journalctl -f -o cat /usr/bin/gnome-shell` (emit with `console.*` / `logError` from GJS).
- Interactive inspection: `Alt+F2` → `lg` (Looking Glass).
- Preferences window: `gnome-extensions prefs clippo@daniel.local`.

No test suite, linter, or package manager — there are no dependencies beyond the GNOME platform. `jsconfig.json` exists only for editor IntelliSense (`checkJs` is off).

## Architecture

`extension.js` is the **orchestrator** and the only stateful coordinator. The four `lib/` classes are decoupled — they never reference each other or the GSettings; `extension.js` wires them together through GObject signals in `enable()` and tears everything down in `disable()`.

Data flow on **copy**: `ClipboardManager` (watches `Meta.Selection`) emits `text-copied` → `extension.js` calls `HistoryStore.add()` → refreshes `ClipboardPopup` if open.

Data flow on **open** (Super+V or panel icon): `extension.js` reads `HistoryStore.getEntries()`, then `popup.refresh(entries)` + `popup.show({x,y})`. The popup emits `item-selected` / `item-pin-toggled` / `item-removed` / `clear-requested`; `extension.js` translates each into a store mutation plus a refresh. Selecting an item also writes back to the clipboard via `ClipboardManager.setClipboard()`.

Components:
- **`lib/clipboardManager.js`** — `GObject` with a `text-copied` signal. Handles only `SELECTION_CLIPBOARD` (Ctrl+C), ignores the primary/middle-click selection. **Anti-loop guard:** when *we* write the clipboard (`setClipboard`), the resulting `owner-changed` is suppressed via `_selfTriggered` (with a 500ms safety timeout) so the write isn't re-captured as new history.
- **`lib/historyStore.js`** — plain class (no GObject). Two arrays: `_pinned` (never trimmed) and `_items` (rotating, capped at `max-items`, deduped, newest-first). Persists to `~/.local/share/clippo/history.json` **atomically** (`replace_contents` + rename) at mode **0600**; saves are **debounced 500ms**. `destroy()` flushes synchronously — `disable()` must call it so nothing is lost on logout.
- **`lib/clipboardPopup.js`** — all the `St` UI. Uses the Shell's `GrabHelper` for the modal grab so Esc / click-outside / focus-loss close cleanly; don't hand-roll grabs (risks locking the session). Keyboard: typing filters, ↑/↓ move, Enter selects, Delete removes, Esc closes. Rows show a whitespace-collapsed, truncated preview but the store keeps/returns full text.
- **`lib/indicator.js`** — optional panel button; clicking calls back into `extension.js` to open the popup anchored below the icon.

## Cross-cutting constraints

- **Super+V conflict:** GNOME binds `<Super>v` to `toggle-message-tray` (`['<Super>v','<Super>m']`). `enable()` strips only `<Super>v` from that key (leaving `<Super>m`) and `disable()` restores it. Any change to keybinding setup must preserve restore-on-disable, or the user permanently loses Super+V for the message tray.
- **GNOME 48–50 API drift:** `St.ScrollView` child-setting and the scroll `vadjustment` getter changed across these versions; `clipboardPopup.js` has fallback shims (`_setScrollChild`, `_ensureRowVisible`). Keep new platform calls tolerant across the declared `shell-version` range.
- **Settings live in `schemas/`** (`max-items`, `toggle-clippo`, `show-indicator`). `extension.js` reacts to `changed::max-items` and `changed::show-indicator` at runtime; `prefs.js` (separate process, libadwaita) edits them and includes custom key-capture for `toggle-clippo`.
- **v1 is text-only** and captures **passwords like any other text** (only mitigation is the 0600 file). No private mode yet.
- **i18n:** user-facing strings are wrapped in `_()`; `lib/clipboardPopup.js` imports `gettext as _` from the extension resource module and `prefs.js` from the prefs resource module, both resolving the `clippo` domain set by `gettext-domain` in `metadata.json`. The base `Extension`/`ExtensionPreferences` classes auto-init translations. Keep new UI strings wrapped and add their `msgstr` to `po/*.po`; never let a string bypass `_()` or it won't translate.
