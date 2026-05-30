// historyStore.js
//
// Owns the history data: pinned items + a rotating history (items), kept in
// memory, with atomic JSON persistence in the user's data directory
// (~/.local/share/clippo/history.json). Survives logout/reboot.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const FILE_VERSION = 1;
const MAX_ITEM_CHARS = 100 * 1024; // caps the length of a single item (characters)
const SAVE_DEBOUNCE_MS = 500;

export class HistoryStore {
    constructor(maxItems) {
        this._maxItems = maxItems;
        this._items = [];   // rotating history, newest first
        this._pinned = [];  // pinned items, never trimmed
        this._saveSourceId = 0;
    }

    _dir() {
        return GLib.build_filenamev([GLib.get_user_data_dir(), 'clippo']);
    }

    _path() {
        return GLib.build_filenamev([this._dir(), 'history.json']);
    }

    load() {
        try {
            const file = Gio.File.new_for_path(this._path());
            const [ok, contents] = file.load_contents(null);
            if (ok) {
                const data = JSON.parse(new TextDecoder('utf-8').decode(contents));
                this._pinned = this._sanitize(data.pinned);
                this._items = this._sanitize(data.items);
            }
        } catch (_e) {
            // missing or corrupted file: start empty, never throw
            this._pinned = [];
            this._items = [];
        }
        this._trim();
    }

    _sanitize(arr) {
        if (!Array.isArray(arr))
            return [];
        return arr.filter(t => typeof t === 'string' && t.length > 0);
    }

    add(text) {
        if (typeof text !== 'string' || text.length === 0)
            return;
        if (text.length > MAX_ITEM_CHARS)
            text = text.slice(0, MAX_ITEM_CHARS);

        // If it's already pinned, leave it where it is (already preserved).
        if (this._pinned.includes(text))
            return;

        // Dedup: remove the previous occurrence and move it back to the top.
        const idx = this._items.indexOf(text);
        if (idx !== -1)
            this._items.splice(idx, 1);
        this._items.unshift(text);
        this._trim();
        this._scheduleSave();
    }

    togglePin(text) {
        const pIdx = this._pinned.indexOf(text);
        if (pIdx !== -1) {
            // unpin: move back to the top of the history
            this._pinned.splice(pIdx, 1);
            this._items.unshift(text);
            this._trim();
        } else {
            // pin: leave the history and go to the top of the pinned list
            const iIdx = this._items.indexOf(text);
            if (iIdx !== -1)
                this._items.splice(iIdx, 1);
            this._pinned.unshift(text);
        }
        this._scheduleSave();
    }

    remove(text) {
        let i = this._items.indexOf(text);
        if (i !== -1)
            this._items.splice(i, 1);
        i = this._pinned.indexOf(text);
        if (i !== -1)
            this._pinned.splice(i, 1);
        this._scheduleSave();
    }

    // Clears the rotating history, keeping the pinned items.
    clear() {
        this._items = [];
        this._scheduleSave();
    }

    setMaxItems(n) {
        this._maxItems = n;
        this._trim();
        this._scheduleSave();
    }

    // Pinned on top, followed by the history (newest first).
    getEntries() {
        return [
            ...this._pinned.map(text => ({ text, pinned: true })),
            ...this._items.map(text => ({ text, pinned: false })),
        ];
    }

    _trim() {
        if (this._items.length > this._maxItems)
            this._items.length = this._maxItems;
    }

    _scheduleSave() {
        if (this._saveSourceId)
            GLib.Source.remove(this._saveSourceId);
        this._saveSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DEBOUNCE_MS, () => {
            this._saveSourceId = 0;
            this.save();
            return GLib.SOURCE_REMOVE;
        });
    }

    save() {
        try {
            GLib.mkdir_with_parents(this._dir(), 0o700);
            const payload = JSON.stringify({
                version: FILE_VERSION,
                pinned: this._pinned,
                items: this._items,
            });
            const file = Gio.File.new_for_path(this._path());
            // replace_contents writes to a temp file and renames it (atomic).
            // PRIVATE creates that temp file as 0600 from the start, so the data is
            // never briefly world-readable (the history may contain sensitive text).
            file.replace_contents(
                new TextEncoder().encode(payload),
                null,
                false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                null);
            // Defence in depth: pin the final file to 0600 as well.
            file.set_attribute_uint32('unix::mode', 0o600,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            logError(e, 'clippo: failed to save history');
        }
    }

    // Saves synchronously and cancels any pending save (used on disable).
    destroy() {
        if (this._saveSourceId) {
            GLib.Source.remove(this._saveSourceId);
            this._saveSourceId = 0;
        }
        this.save();
    }
}
