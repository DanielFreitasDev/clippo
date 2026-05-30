// historyStore.js
//
// Owns the history data: a single list of entry objects, kept in memory, with
// atomic JSON persistence in the user's data directory
// (~/.local/share/clippo/history.json). Survives logout/reboot.
//
// Entry shape:
//   {
//     id,          // GLib.uuid_string_random() — stable key carried by signals
//     type,        // 'text' | 'image'
//     text,        // type==='text': the full text
//     imagePath,   // type==='image': 'images/<id>.png' (relative to the data dir)
//     mimetype, width, height,   // image metadata
//     hash,        // dedup key: text === the text; image === sha256 of the bytes
//     subtype,     // text: 'url'|'color'|'email'|'code'|null (computed elsewhere)
//     createdAt,   // ms epoch — first captured
//     lastUsedAt,  // ms epoch — refreshed on re-copy / re-select / edit
//     pinned,      // boolean — pinned entries are never trimmed
//   }
//
// Images keep their bytes in separate PNG files under images/, referenced by a
// relative path, so the JSON stays small and the debounced save stays cheap.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const FILE_VERSION = 2;
const MAX_ITEM_BYTES = 100 * 1024; // caps the size of a single text item
const SAVE_DEBOUNCE_MS = 500;

export class HistoryStore {
    constructor(maxItems) {
        this._maxItems = maxItems;
        this._entries = [];  // newest first; pinned float to the top in getEntries()
        this._saveSourceId = 0;
        // Set by extension.js from GSettings (lib classes never read GSettings).
        this.orderByRecentUse = false;
    }

    _dir() {
        return GLib.build_filenamev([GLib.get_user_data_dir(), 'clippo']);
    }

    _path() {
        return GLib.build_filenamev([this._dir(), 'history.json']);
    }

    _imagesDir() {
        return GLib.build_filenamev([this._dir(), 'images']);
    }

    // Base data directory, used by the popup to resolve image paths.
    dataDir() {
        return this._dir();
    }

    // Resolves a stored relative imagePath to an absolute path.
    absoluteImagePath(relPath) {
        return GLib.build_filenamev([this._dir(), relPath]);
    }

    load() {
        let data = null;
        try {
            const file = Gio.File.new_for_path(this._path());
            const [ok, contents] = file.load_contents(null);
            if (ok)
                data = JSON.parse(new TextDecoder('utf-8').decode(contents));
        } catch (_e) {
            data = null; // missing or corrupted file: start empty, never throw
        }

        if (data && data.version === 1) {
            // Migrate v1 (plain string arrays) to v2 entry objects, no data loss.
            // The old format had no timestamps, so createdAt/lastUsedAt become now.
            this._entries = [
                ...this._migrateStrings(data.pinned, true),
                ...this._migrateStrings(data.items, false),
            ];
            this._trim();
            this.save(); // persist the upgraded format once
        } else if (data && Array.isArray(data.entries)) {
            this._entries = data.entries
                .map(e => this._sanitizeEntry(e))
                .filter(e => e !== null);
            this._trim();
        } else {
            this._entries = [];
        }

        // Drop image files left behind by a crash mid-write.
        this._sweepOrphanImages();
    }

    _migrateStrings(arr, pinned) {
        if (!Array.isArray(arr))
            return [];
        return arr
            .filter(t => typeof t === 'string' && t.length > 0)
            .map(text => this._makeTextEntry(text, { pinned }));
    }

    _sanitizeEntry(e) {
        if (!e || typeof e !== 'object')
            return null;
        const id = typeof e.id === 'string' && e.id.length ? e.id : GLib.uuid_string_random();
        const createdAt = Number(e.createdAt) || Date.now();
        const lastUsedAt = Number(e.lastUsedAt) || createdAt;
        const pinned = !!e.pinned;

        if (e.type === 'image') {
            // Drop entries whose backing file vanished (orphan guard on load).
            if (typeof e.imagePath !== 'string')
                return null;
            if (!GLib.file_test(this.absoluteImagePath(e.imagePath), GLib.FileTest.EXISTS))
                return null;
            return {
                id, type: 'image',
                imagePath: e.imagePath,
                mimetype: typeof e.mimetype === 'string' ? e.mimetype : 'image/png',
                width: Number(e.width) || 0,
                height: Number(e.height) || 0,
                hash: typeof e.hash === 'string' ? e.hash : e.imagePath,
                subtype: null,
                createdAt, lastUsedAt, pinned,
            };
        }

        // default to text
        if (typeof e.text !== 'string' || e.text.length === 0)
            return null;
        return {
            id, type: 'text',
            text: e.text,
            hash: typeof e.hash === 'string' ? e.hash : e.text,
            subtype: e.subtype ?? null,
            createdAt, lastUsedAt, pinned,
        };
    }

    _makeTextEntry(text, extra = {}) {
        if (text.length > MAX_ITEM_BYTES)
            text = text.slice(0, MAX_ITEM_BYTES);
        const now = Date.now();
        return {
            id: GLib.uuid_string_random(),
            type: 'text',
            text,
            hash: text,
            subtype: null,
            createdAt: now,
            lastUsedAt: now,
            pinned: false,
            ...extra,
        };
    }

    // Adds (or refreshes) a text entry. Returns the entry.
    addText(text, subtype = null) {
        if (typeof text !== 'string' || text.length === 0)
            return null;
        return this._insert(this._makeTextEntry(text, { subtype }));
    }

    // Adds (or refreshes) an image entry from raw PNG bytes (a GLib.Bytes).
    addImage(bytes, hash, { mimetype = 'image/png', width = 0, height = 0 } = {}) {
        const existing = this._entries.find(e => e.hash === hash);
        if (existing) {
            this._touchEntry(existing);
            this._reorder(existing);
            this._scheduleSave();
            return existing;
        }
        const id = GLib.uuid_string_random();
        const relPath = GLib.build_filenamev(['images', `${id}.png`]);
        if (!this._writeImageFile(relPath, bytes))
            return null;
        const now = Date.now();
        const entry = {
            id, type: 'image', imagePath: relPath, mimetype, width, height,
            hash, subtype: null, createdAt: now, lastUsedAt: now, pinned: false,
        };
        this._entries.unshift(entry);
        this._trim();
        this._scheduleSave();
        return entry;
    }

    _insert(entry) {
        const existing = this._entries.find(e => e.hash === entry.hash);
        if (existing) {
            // Already present: move it to the top and refresh its time. A pinned
            // duplicate stays pinned (we never demote it).
            this._touchEntry(existing);
            this._reorder(existing);
            this._scheduleSave();
            return existing;
        }
        this._entries.unshift(entry);
        this._trim();
        this._scheduleSave();
        return entry;
    }

    togglePin(id) {
        const entry = this._entries.find(e => e.id === id);
        if (!entry)
            return;
        entry.pinned = !entry.pinned;
        this._reorder(entry);
        if (!entry.pinned)
            this._trim(); // a freshly-unpinned item may now overflow the cap
        this._scheduleSave();
    }

    remove(id) {
        const idx = this._entries.findIndex(e => e.id === id);
        if (idx === -1)
            return;
        const [removed] = this._entries.splice(idx, 1);
        this._discardImage(removed);
        this._scheduleSave();
    }

    // Clears the rotating history, keeping the pinned items.
    clear() {
        const kept = [];
        for (const e of this._entries) {
            if (e.pinned)
                kept.push(e);
            else
                this._discardImage(e);
        }
        this._entries = kept;
        this._scheduleSave();
    }

    // Moves an item to the top of its group and refreshes its lastUsedAt. Used
    // when a history item is re-selected from the popup.
    touch(id) {
        const entry = this._entries.find(e => e.id === id);
        if (!entry)
            return;
        this._touchEntry(entry);
        this._reorder(entry);
        this._scheduleSave();
    }

    // Replaces the text of a text entry (used by the edit feature). Keeps the
    // id, pinned flag and createdAt; refreshes hash, subtype and lastUsedAt.
    editText(id, newText) {
        const entry = this._entries.find(e => e.id === id);
        if (!entry || entry.type !== 'text')
            return null;
        if (typeof newText !== 'string' || newText.length === 0)
            return null;
        if (newText.length > MAX_ITEM_BYTES)
            newText = newText.slice(0, MAX_ITEM_BYTES);
        entry.text = newText;
        entry.hash = newText;
        entry.subtype = null;
        this._touchEntry(entry);
        this._reorder(entry);
        this._scheduleSave();
        return entry;
    }

    setMaxItems(n) {
        this._maxItems = n;
        this._trim();
        this._scheduleSave();
    }

    getEntry(id) {
        return this._entries.find(e => e.id === id) ?? null;
    }

    // Pinned on top, followed by the history. Order is by insertion (newest
    // first) unless orderByRecentUse is set, in which case by lastUsedAt.
    getEntries() {
        const ordered = this.orderByRecentUse
            ? [...this._entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
            : this._entries;
        return [
            ...ordered.filter(e => e.pinned),
            ...ordered.filter(e => !e.pinned),
        ];
    }

    _touchEntry(entry) {
        entry.lastUsedAt = Date.now();
    }

    _reorder(entry) {
        const idx = this._entries.indexOf(entry);
        if (idx > 0) {
            this._entries.splice(idx, 1);
            this._entries.unshift(entry);
        }
    }

    _trim() {
        const nonPinned = this._entries.filter(e => !e.pinned);
        if (nonPinned.length <= this._maxItems)
            return;
        // _entries is newest-first, so the overflow sits at the tail.
        const overflow = new Set(nonPinned.slice(this._maxItems));
        this._entries = this._entries.filter(e => !overflow.has(e));
        for (const e of overflow)
            this._discardImage(e);
    }

    _writeImageFile(relPath, bytes) {
        try {
            GLib.mkdir_with_parents(this._imagesDir(), 0o700);
            const file = Gio.File.new_for_path(this.absoluteImagePath(relPath));
            file.replace_contents(
                bytes.get_data(),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null);
            file.set_attribute_uint32('unix::mode', 0o600,
                Gio.FileQueryInfoFlags.NONE, null);
            return true;
        } catch (e) {
            logError(e, 'clippo: failed to write image');
            return false;
        }
    }

    _discardImage(entry) {
        if (!entry || entry.type !== 'image' || !entry.imagePath)
            return;
        // Fire-and-forget; ignore errors (orphans are also swept on load).
        const file = Gio.File.new_for_path(this.absoluteImagePath(entry.imagePath));
        file.delete_async(GLib.PRIORITY_DEFAULT, null, (f, res) => {
            try {
                f.delete_finish(res);
            } catch (_e) {
                // ignore
            }
        });
    }

    _sweepOrphanImages() {
        try {
            const dir = Gio.File.new_for_path(this._imagesDir());
            if (!dir.query_exists(null))
                return;
            const referenced = new Set(
                this._entries
                    .filter(e => e.type === 'image' && e.imagePath)
                    .map(e => GLib.path_get_basename(e.imagePath)));
            const en = dir.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)) !== null) {
                const name = info.get_name();
                if (!referenced.has(name)) {
                    try {
                        dir.get_child(name).delete(null);
                    } catch (_e) {
                        // ignore
                    }
                }
            }
            en.close(null);
        } catch (e) {
            logError(e, 'clippo: failed to sweep orphan images');
        }
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
                entries: this._entries,
            });
            const file = Gio.File.new_for_path(this._path());
            // replace_contents writes to a temp file and renames it (atomic).
            file.replace_contents(
                new TextEncoder().encode(payload),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null);
            // 0600 permissions (privacy: the history may contain sensitive data).
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
