// extension.js
//
// Orchestrates Clippo's lifecycle: wires the clipboard monitor to the history
// store and the popup, registers the Super+V shortcut (handling the conflict
// with the message tray) and creates the panel icon. As a Shell extension, it
// starts automatically at login.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ClipboardManager } from './lib/clipboardManager.js';
import { HistoryStore } from './lib/historyStore.js';
import { ClipboardPopup } from './lib/clipboardPopup.js';
import { ClippoIndicator } from './lib/indicator.js';
import { ClippoQuickToggle } from './lib/quickToggle.js';
import { detectSubtype, actionUri } from './lib/contentType.js';

const KEYBINDING = 'toggle-clippo';
const SHELL_KB_SCHEMA = 'org.gnome.shell.keybindings';
const TRAY_KEY = 'toggle-message-tray';
const SUPER_V = '<Super>v';

export default class ClippoExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._store = new HistoryStore(this._settings.get_int('max-items'));
        this._store.load();

        this._clipboard = new ClipboardManager();
        this._clipboard.connect('text-copied', (_m, text) => {
            this._store.addText(text);
            this._refreshPopup();
        });
        this._clipboard.connect('image-copied', (_m, img) => {
            this._store.addImage(img.bytes, img.hash, { width: img.width, height: img.height });
            this._refreshPopup();
        });
        this._clipboard.start();

        this._popup = new ClipboardPopup();
        this._popup.connect('item-selected', (_p, id) => {
            const entry = this._store.getEntry(id);
            if (!entry)
                return;
            if (entry.type === 'text')
                this._clipboard.setClipboard(entry.text);
            else if (entry.type === 'image')
                this._clipboard.setImage(this._store.absoluteImagePath(entry.imagePath), entry.mimetype);
            this._store.touch(id); // move the chosen item to the top
        });
        this._popup.connect('item-pin-toggled', (_p, id) => {
            this._store.togglePin(id);
            this._refreshPopup();
        });
        this._popup.connect('item-removed', (_p, id) => {
            this._store.remove(id);
            this._refreshPopup();
        });
        this._popup.connect('clear-requested', () => {
            this._store.clear();
            this._refreshPopup();
        });
        this._popup.connect('action-invoked', (_p, id, action) => this._invokeAction(id, action));
        this._popup.connect('item-edited', (_p, id, text) => {
            this._store.editText(id, text);
            this._clipboard.setClipboard(text);
            this._popup.dismiss();
        });

        this._addKeybinding();

        this._indicator = null;
        if (this._settings.get_boolean('show-indicator'))
            this._createIndicator();

        this._quickToggle = new ClippoQuickToggle(this._settings);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._quickToggle);

        this._applyCaptureSettings();
        this._settingsIds = [
            this._settings.connect('changed::max-items', () => {
                this._store.setMaxItems(this._settings.get_int('max-items'));
                this._refreshPopup();
            }),
            this._settings.connect('changed::show-indicator', () => {
                if (this._settings.get_boolean('show-indicator'))
                    this._createIndicator();
                else
                    this._destroyIndicator();
            }),
            this._settings.connect('changed::order-by-recent-use', () => {
                this._store.orderByRecentUse = this._settings.get_boolean('order-by-recent-use');
                this._refreshPopup();
            }),
            this._settings.connect('changed::private-mode', () => this._applyCaptureSettings()),
            this._settings.connect('changed::capture-primary', () => this._applyCaptureSettings()),
            this._settings.connect('changed::trim-whitespace', () => this._applyCaptureSettings()),
            this._settings.connect('changed::capture-images', () => this._applyCaptureSettings()),
            this._settings.connect('changed::excluded-apps', () => this._applyCaptureSettings()),
            this._settings.connect('changed::detect-types', () => {
                this._applyCaptureSettings();
                this._refreshPopup();
            }),
        ];
    }

    // Pushes the capture-related settings into the manager and store. Those
    // classes never read GSettings themselves; extension.js is the only consumer.
    _applyCaptureSettings() {
        this._clipboard.privateMode = this._settings.get_boolean('private-mode');
        this._clipboard.capturePrimary = this._settings.get_boolean('capture-primary');
        this._clipboard.trimWhitespace = this._settings.get_boolean('trim-whitespace');
        this._clipboard.captureImages = this._settings.get_boolean('capture-images');
        this._clipboard.excludedApps = this._settings.get_strv('excluded-apps');
        this._store.orderByRecentUse = this._settings.get_boolean('order-by-recent-use');
        this._popup.detectTypes = this._settings.get_boolean('detect-types');
        this._popup.dataDir = this._store.dataDir();
    }

    // Opens a link or mailto for the given item (safe: no command execution).
    _invokeAction(id, action) {
        const entry = this._store.getEntry(id);
        if (!entry || entry.type !== 'text')
            return;
        if (action === 'open') {
            const uri = actionUri(detectSubtype(entry.text), entry.text);
            if (uri) {
                try {
                    Gio.AppInfo.launch_default_for_uri(uri, null);
                } catch (e) {
                    logError(e, 'clippo: failed to open uri');
                }
            }
            this._popup.dismiss();
        }
    }

    disable() {
        // Close the popup first to release any modal grab.
        if (this._popup)
            this._popup.dismiss();

        this._removeKeybinding();
        this._destroyIndicator();

        if (this._quickToggle) {
            this._quickToggle.destroy();
            this._quickToggle = null;
        }

        if (this._settings && this._settingsIds) {
            for (const id of this._settingsIds)
                this._settings.disconnect(id);
            this._settingsIds = null;
        }

        if (this._clipboard) {
            this._clipboard.stop();
            this._clipboard = null;
        }

        if (this._popup) {
            this._popup.destroy();
            this._popup = null;
        }

        if (this._store) {
            this._store.destroy(); // saves synchronously
            this._store = null;
        }

        this._settings = null;
    }

    _addKeybinding() {
        this._shellKb = new Gio.Settings({ schema_id: SHELL_KB_SCHEMA });
        this._removedTrayBinding = false;
        // Only take <Super>v from the message tray while Clippo is actually bound
        // to it; re-check whenever the user edits the shortcut at runtime.
        this._reconcileTrayConflict();
        this._toggleClippoId = this._settings.connect(`changed::${KEYBINDING}`,
            () => this._reconcileTrayConflict());

        Main.wm.addKeybinding(
            KEYBINDING,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._toggle());
    }

    // Known conflict: GNOME binds toggle-message-tray to ['<Super>v','<Super>m'].
    // Strip only <Super>v (keeping <Super>m), and only while our shortcut uses it;
    // hand it back as soon as we stop using it (or on disable).
    _reconcileTrayConflict() {
        const weUseSuperV = this._settings.get_strv(KEYBINDING).includes(SUPER_V);
        const tray = this._shellKb.get_strv(TRAY_KEY);
        if (weUseSuperV && tray.includes(SUPER_V)) {
            this._shellKb.set_strv(TRAY_KEY, tray.filter(a => a !== SUPER_V));
            this._removedTrayBinding = true;
        } else if (!weUseSuperV && this._removedTrayBinding) {
            if (!tray.includes(SUPER_V))
                this._shellKb.set_strv(TRAY_KEY, [...tray, SUPER_V]);
            this._removedTrayBinding = false;
        }
    }

    _removeKeybinding() {
        Main.wm.removeKeybinding(KEYBINDING);
        if (this._toggleClippoId) {
            this._settings.disconnect(this._toggleClippoId);
            this._toggleClippoId = 0;
        }
        if (this._shellKb && this._removedTrayBinding) {
            const tray = this._shellKb.get_strv(TRAY_KEY);
            if (!tray.includes(SUPER_V))
                this._shellKb.set_strv(TRAY_KEY, [...tray, SUPER_V]);
        }
        this._shellKb = null;
        this._removedTrayBinding = false;
    }

    _createIndicator() {
        if (this._indicator)
            return;
        this._indicator = new ClippoIndicator(button => this._openFromActor(button));
        Main.panel.addToStatusArea('clippo', this._indicator);
    }

    _destroyIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _toggle() {
        if (this._popup.visible)
            this._popup.dismiss();
        else
            this._openAtPointer();
    }

    _openAtPointer() {
        const [x, y] = global.get_pointer();
        this._popup.refresh(this._store.getEntries());
        this._popup.show({ x, y });
    }

    _openFromActor(actor) {
        const [bx, by] = actor.get_transformed_position();
        this._popup.refresh(this._store.getEntries());
        this._popup.show({ x: bx, y: by + actor.height });
    }

    _refreshPopup() {
        if (this._popup && this._popup.visible)
            this._popup.refresh(this._store.getEntries());
    }
}
