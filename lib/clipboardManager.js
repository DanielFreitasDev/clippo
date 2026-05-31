// clipboardManager.js
//
// Watches the system clipboard and emits 'text-copied' / 'image-copied' whenever
// new content is copied (Ctrl+C). On GNOME Wayland sessions, only the Shell
// process has privileged background access to the clipboard, through
// Meta.Selection — which is why this lives inside an extension.
//
// Capture is gated by a few guards configured from extension.js (this class
// never reads GSettings itself):
//   - privateMode    pause capture entirely
//   - excludedApps   skip copies made while a given app is focused
//   - trimWhitespace strip leading/trailing whitespace before storing
//   - capturePrimary also capture the PRIMARY (middle-click) selection
//   - captureImages  capture image/png when no usable text is offered
// plus a built-in guard that skips content marked sensitive by password
// managers (the x-kde-passwordManagerHint MIME hint).

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import St from 'gi://St';
import Meta from 'gi://Meta';

const PRIMARY_DEBOUNCE_MS = 400;
const SELF_RESET_MS = 500;
// Lowercased fragment of the MIME hints password managers advertise to mark
// secret content (e.g. 'x-kde-passwordManagerHint').
const SENSITIVE_HINT = 'passwordmanagerhint';

export const ClipboardManager = GObject.registerClass({
    Signals: {
        'text-copied': { param_types: [GObject.TYPE_STRING] },
        // payload: { bytes: GLib.Bytes, hash, width, height }
        'image-copied': { param_types: [GObject.TYPE_JSOBJECT] },
    },
}, class ClipboardManager extends GObject.Object {
    _init() {
        super._init();
        this._clipboard = St.Clipboard.get_default();
        this._selection = global.get_display().get_selection();
        this._ownerChangedId = 0;
        // Anti-loop guard: when we write to the clipboard ourselves we trigger an
        // 'owner-changed'; we want to ignore it so we don't re-capture/duplicate it.
        this._selfTriggered = false;
        this._lastText = null;
        this._lastPrimaryText = null;
        this._lastImageHash = null;
        this._resetSourceId = 0;
        this._primarySourceId = 0;

        // Configuration injected by extension.js.
        this.privateMode = false;
        this.capturePrimary = false;
        this.trimWhitespace = false;
        this.captureImages = false;
        this.excludedApps = [];
    }

    start() {
        if (this._ownerChangedId)
            return;
        this._ownerChangedId = this._selection.connect('owner-changed',
            (_selection, selectionType) => this._onOwnerChanged(selectionType));
    }

    _onOwnerChanged(selectionType) {
        if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
            if (this._selfTriggered) {
                this._selfTriggered = false;
                this._clearResetTimer();
                return;
            }
            this._readClipboard();
        } else if (selectionType === Meta.SelectionType.SELECTION_PRIMARY) {
            if (!this.capturePrimary)
                return; // primary/middle-click capture is opt-in
            // PRIMARY fires continuously while dragging a selection; debounce it
            // so only the settled selection is captured.
            this._schedulePrimaryRead();
        }
    }

    // True when the current contents must NOT be captured.
    _shouldSkip(selectionType) {
        return this.privateMode ||
            this._isSensitive(selectionType) ||
            this._isExcludedApp();
    }

    // Password managers advertise a hint MIME type to mark secret content.
    _isSensitive(selectionType) {
        let mimetypes;
        try {
            mimetypes = this._selection.get_mimetypes(selectionType) ?? [];
        } catch (_e) {
            return false;
        }
        return mimetypes.some(t => t.toLowerCase().includes(SENSITIVE_HINT));
    }

    // Best-effort: skip copies made while an excluded app is focused. Some pure
    // Wayland clients expose no id, in which case they can't be excluded.
    _isExcludedApp() {
        if (!this.excludedApps.length)
            return false;
        const win = global.display.get_focus_window?.() ?? global.display.focus_window;
        if (!win)
            return false;
        const ids = [
            win.get_gtk_application_id?.(),
            win.get_sandboxed_app_id?.(),
            win.get_wm_class?.(),
            win.get_wm_class_instance?.(),
        ].filter(Boolean).map(s => s.toLowerCase());
        return this.excludedApps.some(x => ids.includes(x.trim().toLowerCase()));
    }

    _processText(text) {
        if (!text)
            return '';
        return this.trimWhitespace ? text.replace(/^\s+|\s+$/g, '') : text;
    }

    _readClipboard() {
        if (this._shouldSkip(Meta.SelectionType.SELECTION_CLIPBOARD))
            return;
        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, raw) => {
            // A file copy (file manager) exposes the path(s) as text; when image
            // capture is on, load any image files from disk — asynchronously, so
            // the Shell never blocks on decoding a large image — instead of
            // storing the paths. If the copy held no image, fall back to text.
            if (this.captureImages && this._isFileCopy()) {
                this._captureImageFiles(raw, hadImage => {
                    if (!hadImage)
                        this._handleText(raw);
                });
                return;
            }
            this._handleText(raw);
        });
    }

    // Stores usable text, or — when there is none and image capture is on —
    // tries to read a raw image off the clipboard.
    _handleText(raw) {
        const text = this._processText(raw);
        if (text) {
            if (text === this._lastText)
                return;
            this._lastText = text;
            this.emit('text-copied', text);
            return;
        }
        if (this.captureImages)
            this._maybeReadImage();
    }

    _maybeReadImage() {
        let mimetypes;
        try {
            mimetypes = this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD) ?? [];
        } catch (_e) {
            return;
        }
        if (!mimetypes.includes('image/png'))
            return;
        const stream = Gio.MemoryOutputStream.new_resizable();
        this._selection.transfer_async(
            Meta.SelectionType.SELECTION_CLIPBOARD,
            'image/png', -1, stream, null,
            (sel, res) => {
                try {
                    sel.transfer_finish(res);
                    stream.close(null);
                    const bytes = stream.steal_as_bytes();
                    const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
                    if (hash === this._lastImageHash)
                        return; // our own write, or an exact duplicate
                    this._lastImageHash = hash;
                    const [width, height] = this._pngSize(bytes);
                    this.emit('image-copied', { bytes, hash, width, height });
                } catch (e) {
                    logError(e, 'clippo: image transfer failed');
                }
            });
    }

    // Reads the pixel dimensions straight from the PNG IHDR header (big-endian
    // uint32 at offsets 16 and 20), avoiding a full decode.
    _pngSize(bytes) {
        const data = bytes.get_data();
        if (!data || data.length < 24)
            return [0, 0];
        const u32 = o => ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
        return [u32(16), u32(20)];
    }

    // True when the clipboard holds a file copy (file manager), whose payload is
    // a list of file paths rather than plain text.
    _isFileCopy() {
        let types;
        try {
            types = this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD) ?? [];
        } catch (_e) {
            return false;
        }
        return types.some(t =>
            t === 'text/uri-list' ||
            t.includes('gnome-copied-files') ||
            t.includes('nautilus-clipboard'));
    }

    // Loads any image files referenced by a file copy (normalized to PNG) and
    // emits 'image-copied' for each. Runs asynchronously; calls done(true) if at
    // least one image was captured, done(false) otherwise (so the caller can
    // fall back to storing the paths as text, as before).
    _captureImageFiles(raw, done) {
        const paths = this._parsePaths(raw).slice(0, 10);
        if (!paths.length) {
            done(false);
            return;
        }
        let pending = paths.length;
        let captured = false;
        for (const path of paths) {
            this._loadImageFileAsync(path, img => {
                if (img) {
                    captured = true;
                    if (img.hash !== this._lastImageHash) {
                        this._lastImageHash = img.hash;
                        this.emit('image-copied', img);
                    }
                }
                if (--pending === 0)
                    done(captured);
            });
        }
    }

    _parsePaths(raw) {
        if (!raw)
            return [];
        return raw.split(/[\r\n]+/)
            .map(s => s.trim())
            .filter(s => s.length && s !== 'copy' && s !== 'cut')
            .map(s => {
                if (!s.startsWith('file://'))
                    return s;
                try {
                    const r = GLib.filename_from_uri(s);
                    return Array.isArray(r) ? r[0] : r;
                } catch (_e) {
                    return null;
                }
            })
            .filter(Boolean);
    }

    // Loads an image file and normalizes it to PNG bytes without blocking the
    // Shell (decode and encode both run asynchronously). Calls
    // cb({ bytes, hash, width, height }) or cb(null) if the path isn't a
    // readable image.
    _loadImageFileAsync(path, cb) {
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
            cb(null);
            return;
        }
        Gio.File.new_for_path(path).read_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
            let stream;
            try {
                stream = file.read_finish(res);
            } catch (_e) {
                cb(null);
                return;
            }
            GdkPixbuf.Pixbuf.new_from_stream_async(stream, null, (_o, pres) => {
                let pixbuf;
                try {
                    pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(pres);
                } catch (_e) {
                    cb(null); // not an image, or unreadable
                    return;
                }
                const out = Gio.MemoryOutputStream.new_resizable();
                pixbuf.save_to_streamv_async(out, 'png', [], [], null, (_p, sres) => {
                    try {
                        GdkPixbuf.Pixbuf.save_to_stream_finish(sres);
                        out.close(null);
                        const bytes = out.steal_as_bytes();
                        cb({
                            bytes,
                            hash: GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes),
                            width: pixbuf.get_width(),
                            height: pixbuf.get_height(),
                        });
                    } catch (_e) {
                        cb(null);
                    }
                });
            });
        });
    }

    _schedulePrimaryRead() {
        if (this._primarySourceId)
            GLib.Source.remove(this._primarySourceId);
        this._primarySourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PRIMARY_DEBOUNCE_MS, () => {
            this._primarySourceId = 0;
            this._readPrimary();
            return GLib.SOURCE_REMOVE;
        });
    }

    _readPrimary() {
        if (this._shouldSkip(Meta.SelectionType.SELECTION_PRIMARY))
            return;
        this._clipboard.get_text(St.ClipboardType.PRIMARY, (_clipboard, raw) => {
            const text = this._processText(raw);
            if (!text || text === this._lastPrimaryText || text === this._lastText)
                return;
            this._lastPrimaryText = text;
            this._lastText = text; // avoid a duplicate if the same is then Ctrl+C'd
            this.emit('text-copied', text);
        });
    }

    // Puts text back on the clipboard (when a history item is selected), so the
    // next Ctrl+V pastes that content.
    setClipboard(text) {
        this._selfTriggered = true;
        this._lastText = text;
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        this._armSafetyTimer();
    }

    // Puts an image back on the clipboard from its stored PNG file. The file is
    // read asynchronously so a large image never blocks the Shell.
    setImage(path, mimetype = 'image/png') {
        Gio.File.new_for_path(path).load_bytes_async(null, (file, res) => {
            let bytes;
            try {
                [bytes] = file.load_bytes_finish(res);
            } catch (e) {
                logError(e, 'clippo: failed to read image for the clipboard');
                return;
            }
            if (!bytes || !this._clipboard)
                return; // stopped while reading
            this._selfTriggered = true;
            this._lastImageHash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
            this._clipboard.set_content(St.ClipboardType.CLIPBOARD, mimetype, bytes);
            this._armSafetyTimer();
        });
    }

    // Safety: if for some reason the 'owner-changed' never arrives, release the
    // self-triggered guard after a short while so the next capture isn't blocked.
    _armSafetyTimer() {
        this._clearResetTimer();
        this._resetSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SELF_RESET_MS, () => {
            this._selfTriggered = false;
            this._resetSourceId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearResetTimer() {
        if (this._resetSourceId) {
            GLib.Source.remove(this._resetSourceId);
            this._resetSourceId = 0;
        }
    }

    stop() {
        if (this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = 0;
        }
        this._clearResetTimer();
        if (this._primarySourceId) {
            GLib.Source.remove(this._primarySourceId);
            this._primarySourceId = 0;
        }
        this._clipboard = null;
        this._selection = null;
    }
});
