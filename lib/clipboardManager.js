// clipboardManager.js
//
// Watches the system clipboard and emits 'text-copied' whenever new text is
// copied (Ctrl+C). On GNOME Wayland sessions, only the Shell process has
// privileged background access to the clipboard, through Meta.Selection — which
// is why this lives inside an extension.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Meta from 'gi://Meta';

export const ClipboardManager = GObject.registerClass({
    Signals: {
        'text-copied': { param_types: [GObject.TYPE_STRING] },
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
        this._resetSourceId = 0;
    }

    start() {
        if (this._ownerChangedId)
            return;
        this._ownerChangedId = this._selection.connect('owner-changed',
            (_selection, selectionType) => {
                // We only care about the clipboard selection (Ctrl+C),
                // not the primary selection (middle mouse button).
                if (selectionType !== Meta.SelectionType.SELECTION_CLIPBOARD)
                    return;
                if (this._selfTriggered) {
                    this._selfTriggered = false;
                    this._clearResetTimer();
                    return;
                }
                this._readClipboard();
            });
    }

    _readClipboard() {
        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            if (!text)
                return; // images/files/empty: ignored in v1 (text only)
            if (text === this._lastText)
                return;
            this._lastText = text;
            this.emit('text-copied', text);
        });
    }

    // Puts text back on the clipboard (when a history item is selected), so the
    // next Ctrl+V pastes that content.
    setClipboard(text) {
        this._selfTriggered = true;
        this._lastText = text;
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        // Safety: if for some reason the 'owner-changed' never arrives, we release
        // the guard after a short while so the next capture isn't blocked.
        this._clearResetTimer();
        this._resetSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
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
        this._clipboard = null;
        this._selection = null;
    }
});
