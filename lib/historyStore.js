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
//     hash,        // dedup key: sha256 of the text / of the image bytes
//     createdAt,   // ms epoch — first captured
//     lastUsedAt,  // ms epoch — refreshed on re-copy / re-select / edit
//     pinned,      // boolean — pinned entries are never trimmed
//   }
//
// Images keep their bytes in separate PNG files under images/, referenced by a
// relative path, so the JSON stays small and the debounced save stays cheap.
// When persist-history is off, the image files live under the user's runtime
// dir (tmpfs, RAM-backed) instead of the data dir, so nothing touches the disk.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const FILE_VERSION = 2;
const MAX_ITEM_CHARS = 100 * 1024; // caps the size of a single text item
const SAVE_DEBOUNCE_MS = 500;

export class HistoryStore {
    constructor(maxItems) {
        this._maxItems = maxItems;
        this._entries = [];  // newest first; pinned float to the top in getEntries()
        this._saveSourceId = 0;
        this._saveCancellable = null;
        // Set by extension.js from GSettings (lib classes never read GSettings).
        this.orderByRecentUse = false;
        // When false, the history is kept in memory only and never written to
        // disk (and any existing on-disk history is wiped). Must be set before
        // load(). See setPersist() for runtime changes.
        this.persist = true;
    }

    // Persistent base on disk. The JSON index always lives here.
    _dataDir() {
        return GLib.build_filenamev([GLib.get_user_data_dir(), 'clippo']);
    }

    // RAM-backed base (tmpfs): image files land here when not persisting, so
    // "nothing is written to disk" holds even with image capture on.
    _runtimeDir() {
        return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'clippo']);
    }

    // Active base for image files, depending on the persist mode.
    _dir() {
        return this.persist ? this._dataDir() : this._runtimeDir();
    }

    _path() {
        return GLib.build_filenamev([this._dataDir(), 'history.json']);
    }

    _imagesDir() {
        return GLib.build_filenamev([this._dir(), 'images']);
    }

    // Active base directory (disk or runtime), used by the popup to resolve
    // image paths. Re-pushed by extension.js whenever persist-history changes.
    dataDir() {
        return this._dir();
    }

    // Resolves a stored relative imagePath to an absolute path.
    absoluteImagePath(relPath) {
        return GLib.build_filenamev([this._dir(), relPath]);
    }

    load() {
        if (!this.persist) {
            // Not persisting across sessions: start empty and wipe whatever a
            // previous (persisting) session may have left on disk, plus any
            // runtime images left by a session that ended uncleanly.
            this._entries = [];
            this._purgeIndex();
            this._purgeImages(GLib.build_filenamev([this._dataDir(), 'images']));
            this._purgeImages(GLib.build_filenamev([this._runtimeDir(), 'images']));
            return;
        }

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

        // Drop image files left behind by a crash mid-write, and any runtime
        // images a previous non-persisting session failed to clean up.
        this._sweepOrphanImages();
        this._purgeImages(GLib.build_filenamev([this._runtimeDir(), 'images']));
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
                createdAt, lastUsedAt, pinned,
            };
        }

        // default to text
        if (typeof e.text !== 'string' || e.text.length === 0)
            return null;
        return {
            id, type: 'text',
            text: e.text,
            // Recomputed rather than trusted from the file: older versions
            // stored the text itself as its hash, doubling the JSON size.
            hash: this._textHash(e.text),
            createdAt, lastUsedAt, pinned,
        };
    }

    // Dedup key for a text (sha256, so the JSON never stores the text twice).
    _textHash(text) {
        return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
    }

    _makeTextEntry(text, extra = {}) {
        if (text.length > MAX_ITEM_CHARS)
            text = text.slice(0, MAX_ITEM_CHARS);
        const now = Date.now();
        return {
            id: GLib.uuid_string_random(),
            type: 'text',
            text,
            hash: this._textHash(text),
            createdAt: now,
            lastUsedAt: now,
            pinned: false,
            ...extra,
        };
    }

    // Adds (or refreshes) a text entry. Returns the entry.
    addText(text) {
        if (typeof text !== 'string' || text.length === 0)
            return null;
        return this._insert(this._makeTextEntry(text));
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
        const now = Date.now();
        const entry = {
            id, type: 'image', imagePath: relPath, mimetype, width, height,
            hash, createdAt: now, lastUsedAt: now, pinned: false,
        };
        this._entries.unshift(entry);
        this._trim();
        // Write the PNG asynchronously; if the write fails, drop the entry.
        this._writeImageFile(relPath, bytes, ok => {
            if (!ok)
                this.remove(id);
        });
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

    // Refreshes an entry's lastUsedAt when it is re-selected from the popup.
    // Deliberately does NOT reorder the list: with the default ordering the
    // history keeps copy order, and with order-by-recent-use getEntries()
    // sorts by the lastUsedAt this refresh feeds.
    touch(id) {
        const entry = this._entries.find(e => e.id === id);
        if (!entry)
            return;
        this._touchEntry(entry);
        this._scheduleSave();
    }

    // Replaces the text of a text entry (used by the edit feature). Keeps the
    // id, pinned flag and createdAt; refreshes hash and lastUsedAt.
    editText(id, newText) {
        const entry = this._entries.find(e => e.id === id);
        if (!entry || entry.type !== 'text')
            return null;
        if (typeof newText !== 'string' || newText.length === 0)
            return null;
        if (newText.length > MAX_ITEM_CHARS)
            newText = newText.slice(0, MAX_ITEM_CHARS);
        entry.text = newText;
        entry.hash = this._textHash(newText);
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

    _writeImageFile(relPath, bytes, done) {
        let file;
        try {
            GLib.mkdir_with_parents(this._imagesDir(), 0o700);
            file = Gio.File.new_for_path(this.absoluteImagePath(relPath));
        } catch (e) {
            logError(e, 'clippo: failed to prepare image file');
            done?.(false);
            return;
        }
        file.replace_contents_bytes_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
            (f, res) => {
                try {
                    f.replace_contents_finish(res);
                    // PRIVATE already creates it 0600; make the mode explicit too.
                    f.set_attribute_uint32('unix::mode', 0o600,
                        Gio.FileQueryInfoFlags.NONE, null);
                    done?.(true);
                } catch (e) {
                    logError(e, 'clippo: failed to write image');
                    done?.(false);
                }
            });
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

    // Switches persistence on or off at runtime. Turning it on moves the image
    // files onto disk and writes the index out; turning it off drops the
    // on-disk index and moves the image files to the RAM-backed runtime dir.
    setPersist(on) {
        if (this.persist === on)
            return;
        const oldImagesDir = this._imagesDir();
        this.persist = on;
        this._migrateImages(oldImagesDir, this._imagesDir());
        if (on)
            this.save();
        else
            this._purgeIndex();
    }

    // Moves the image files of the current entries between the disk and runtime
    // bases when the persist mode flips. Entries whose file cannot be moved are
    // dropped (their image would be unreachable).
    _migrateImages(fromDir, toDir) {
        const images = this._entries.filter(e => e.type === 'image' && e.imagePath);
        if (!images.length)
            return;
        GLib.mkdir_with_parents(toDir, 0o700);
        const failed = new Set();
        for (const e of images) {
            const name = GLib.path_get_basename(e.imagePath);
            const src = Gio.File.new_for_path(GLib.build_filenamev([fromDir, name]));
            const dst = Gio.File.new_for_path(GLib.build_filenamev([toDir, name]));
            try {
                src.move(dst, Gio.FileCopyFlags.OVERWRITE, null, null);
                dst.set_attribute_uint32('unix::mode', 0o600,
                    Gio.FileQueryInfoFlags.NONE, null);
            } catch (err) {
                logError(err, 'clippo: failed to move an image between storage modes');
                failed.add(e);
            }
        }
        if (failed.size)
            this._entries = this._entries.filter(e => !failed.has(e));
    }

    // Deletes the on-disk JSON index (best-effort).
    _purgeIndex() {
        try {
            const file = Gio.File.new_for_path(this._path());
            if (file.query_exists(null))
                file.delete(null);
        } catch (_e) {
            // ignore
        }
    }

    // Empties one images directory (best-effort).
    _purgeImages(dirPath) {
        try {
            const dir = Gio.File.new_for_path(dirPath);
            if (!dir.query_exists(null))
                return;
            const en = dir.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)) !== null) {
                try {
                    dir.get_child(info.get_name()).delete(null);
                } catch (_e) {
                    // ignore
                }
            }
            en.close(null);
        } catch (_e) {
            // ignore
        }
    }

    _serialize() {
        return new TextEncoder().encode(JSON.stringify({
            version: FILE_VERSION,
            entries: this._entries,
        }));
    }

    // Asynchronous atomic save (temp file + rename), so a large history never
    // blocks the compositor; PRIVATE creates the temp file as 0600 from the
    // start, so the data is never briefly world-readable (it may hold secrets).
    // Any save still in flight is cancelled first, so an older snapshot can
    // never land on disk after a newer one.
    save() {
        if (!this.persist)
            return; // kept in memory only; nothing is written to disk
        this._saveCancellable?.cancel();
        this._saveCancellable = new Gio.Cancellable();
        try {
            GLib.mkdir_with_parents(this._dataDir(), 0o700);
            const file = Gio.File.new_for_path(this._path());
            file.replace_contents_bytes_async(
                GLib.Bytes.new(this._serialize()),
                null,
                false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                this._saveCancellable,
                (f, res) => {
                    try {
                        f.replace_contents_finish(res);
                        // 0600 permissions, explicit besides PRIVATE (privacy:
                        // the history may contain sensitive data).
                        f.set_attribute_uint32('unix::mode', 0o600,
                            Gio.FileQueryInfoFlags.NONE, null);
                    } catch (e) {
                        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            logError(e, 'clippo: failed to save history');
                    }
                });
        } catch (e) {
            logError(e, 'clippo: failed to save history');
        }
    }

    // Synchronous variant, used only by destroy(): disable() must be able to
    // flush before the extension object goes away.
    _saveSync() {
        try {
            GLib.mkdir_with_parents(this._dataDir(), 0o700);
            const file = Gio.File.new_for_path(this._path());
            file.replace_contents(
                this._serialize(),
                null,
                false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                null);
            file.set_attribute_uint32('unix::mode', 0o600,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            logError(e, 'clippo: failed to save history');
        }
    }

    // Flushes synchronously and cancels any pending save (used on disable). When
    // not persisting, wipes the stored files instead so nothing survives.
    destroy() {
        if (this._saveSourceId) {
            GLib.Source.remove(this._saveSourceId);
            this._saveSourceId = 0;
        }
        this._saveCancellable?.cancel();
        this._saveCancellable = null;
        if (this.persist) {
            this._saveSync();
        } else {
            this._purgeIndex();
            this._purgeImages(GLib.build_filenamev([this._dataDir(), 'images']));
            this._purgeImages(GLib.build_filenamev([this._runtimeDir(), 'images']));
        }
    }
}
