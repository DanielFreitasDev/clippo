// extension.js
//
// Orchestrates Clippo's lifecycle: wires the clipboard monitor to the history
// store and the popup, registers the open-history shortcut (handling the
// message-tray conflict when the user picks Super+V) and creates the panel
// icon. As a Shell extension, it starts automatically at login.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ClipboardManager } from './lib/clipboardManager.js';
import { HistoryStore } from './lib/historyStore.js';
import { ClipboardPopup } from './lib/clipboardPopup.js';
import { ClippoIndicator } from './lib/indicator.js';
import { ClippoQuickToggle } from './lib/quickToggle.js';
import { CycleOsd } from './lib/cycleOsd.js';
import { detectSubtype, actionUri } from './lib/contentType.js';

const KEYBINDING = 'toggle-clippo';
const CYCLE_NEXT = 'cycle-next';
const CYCLE_PREV = 'cycle-previous';
const CYCLE_RESET_MS = 1500;
const SHELL_KB_SCHEMA = 'org.gnome.shell.keybindings';
const TRAY_KEY = 'toggle-message-tray';
const SUPER_V = '<Super>v';
// Our own (hidden) key persisting that we took <Super>v from the message tray,
// so the hand-back survives sessions and crashes, not just a clean disable().
const TRAY_REMOVED_KEY = 'tray-super-v-removed';

export default class ClippoExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._store = new HistoryStore(this._settings.get_int('max-items'));
        this._store.persist = this._settings.get_boolean('persist-history');
        this._store.load();

        // History-cycling state (paste next/previous via shortcut).
        this._cycleIndex = -1;
        this._cycleResetId = 0;

        this._clipboard = new ClipboardManager();
        this._clipboard.connect('text-copied', (_m, text) => {
            this._resetCycle();
            this._store.addText(text);
            this._refreshPopup();
        });
        this._clipboard.connect('image-copied', (_m, img) => {
            this._resetCycle();
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
            this._store.touch(id); // refresh its last-use time
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
        this._popup.connect('open-with-invoked', (_p, id, appId) => this._openWith(id, appId));
        this._popup.connect('item-edited', (_p, id, text) => {
            this._store.editText(id, text);
            this._clipboard.setClipboard(text);
            this._popup.dismiss();
        });

        this._cycleOsd = new CycleOsd();

        // Follow the system light/dark color scheme (a separate schema from ours;
        // the lib modules stay GSettings-free, so extension.js pushes it in).
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._applyTheme();
        this._interfaceThemeId = this._interfaceSettings.connect('changed::color-scheme',
            () => this._applyTheme());

        this._addKeybinding();
        this._addCycleKeybindings();

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
            this._settings.connect('changed::persist-history', () => {
                this._store.setPersist(this._settings.get_boolean('persist-history'));
                // The image base dir may have moved (disk <-> runtime tmpfs).
                this._popup.dataDir = this._store.dataDir();
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

    // Pushes the current light/dark color scheme into the popup.
    _applyTheme() {
        const dark = this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
        this._popup.darkTheme = dark;
        if (this._cycleOsd)
            this._cycleOsd.darkTheme = dark;
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

    // Launches the app chosen in the "Open with…" list for an item's link/email
    // (safe: Gio.AppInfo, never a shell command). The popup dismissed itself
    // before emitting.
    _openWith(id, appId) {
        const entry = this._store.getEntry(id);
        if (!entry || entry.type !== 'text')
            return;
        const uri = actionUri(detectSubtype(entry.text), entry.text);
        if (!uri)
            return;
        try {
            const app = Gio.DesktopAppInfo.new(appId);
            if (app)
                app.launch_uris([uri], null);
        } catch (e) {
            logError(e, 'clippo: failed to open with the chosen app');
        }
    }

    disable() {
        // Close the popup first to release any modal grab.
        if (this._popup)
            this._popup.dismiss();

        this._removeKeybinding();
        this._removeCycleKeybindings();
        this._resetCycle();
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

        if (this._interfaceSettings && this._interfaceThemeId) {
            this._interfaceSettings.disconnect(this._interfaceThemeId);
            this._interfaceThemeId = 0;
        }
        this._interfaceSettings = null;

        if (this._clipboard) {
            this._clipboard.stop();
            this._clipboard = null;
        }

        if (this._popup) {
            this._popup.destroy();
            this._popup = null;
        }

        if (this._cycleOsd) {
            this._cycleOsd.destroy();
            this._cycleOsd = null;
        }

        if (this._store) {
            this._store.destroy(); // saves synchronously
            this._store = null;
        }

        this._settings = null;
    }

    _addKeybinding() {
        this._shellKb = new Gio.Settings({ schema_id: SHELL_KB_SCHEMA });
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
            this._settings.set_boolean(TRAY_REMOVED_KEY, true);
        } else if (!weUseSuperV && this._settings.get_boolean(TRAY_REMOVED_KEY)) {
            if (!tray.includes(SUPER_V))
                this._shellKb.set_strv(TRAY_KEY, [...tray, SUPER_V]);
            this._settings.set_boolean(TRAY_REMOVED_KEY, false);
        }
    }

    _removeKeybinding() {
        Main.wm.removeKeybinding(KEYBINDING);
        if (this._toggleClippoId) {
            this._settings.disconnect(this._toggleClippoId);
            this._toggleClippoId = 0;
        }
        if (this._shellKb && this._settings.get_boolean(TRAY_REMOVED_KEY)) {
            const tray = this._shellKb.get_strv(TRAY_KEY);
            if (!tray.includes(SUPER_V))
                this._shellKb.set_strv(TRAY_KEY, [...tray, SUPER_V]);
            this._settings.set_boolean(TRAY_REMOVED_KEY, false);
        }
        this._shellKb = null;
    }

    // History-cycling shortcuts (paste next/previous). They default to empty in
    // the schema (the store's review rules forbid a default clipboard shortcut),
    // so they do nothing until the user assigns keys in preferences.
    _addCycleKeybindings() {
        Main.wm.addKeybinding(
            CYCLE_NEXT,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._cycle(1));
        Main.wm.addKeybinding(
            CYCLE_PREV,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._cycle(-1));
    }

    _removeCycleKeybindings() {
        Main.wm.removeKeybinding(CYCLE_NEXT);
        Main.wm.removeKeybinding(CYCLE_PREV);
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
        this._resetCycle();
        const [x, y] = global.get_pointer();
        this._popup.refresh(this._store.getEntries());
        this._popup.show({ x, y });
    }

    _openFromActor(actor) {
        this._resetCycle();
        const [bx, by] = actor.get_transformed_position();
        this._popup.refresh(this._store.getEntries());
        this._popup.show({ x: bx, y: by + actor.height });
    }

    // Switches the live clipboard to the next/previous history item without
    // opening the full popup, showing a brief on-screen preview. The cycle
    // position resets after a short idle, when something new is copied, or when
    // the popup is opened (_resetCycle).
    _cycle(delta) {
        const entries = this._store.getEntries();
        if (!entries.length)
            return;
        if (this._cycleIndex < 0)
            this._cycleIndex = 0;
        const n = entries.length;
        this._cycleIndex = (this._cycleIndex + delta + n) % n;
        const entry = entries[this._cycleIndex];
        if (entry.type === 'text')
            this._clipboard.setClipboard(entry.text);
        else if (entry.type === 'image')
            this._clipboard.setImage(this._store.absoluteImagePath(entry.imagePath), entry.mimetype);
        this._cycleOsd.show(entries, this._cycleIndex);
        this._armCycleReset();
    }

    _armCycleReset() {
        if (this._cycleResetId)
            GLib.Source.remove(this._cycleResetId);
        this._cycleResetId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CYCLE_RESET_MS, () => {
            this._cycleResetId = 0;
            this._cycleIndex = -1;
            return GLib.SOURCE_REMOVE;
        });
    }

    _resetCycle() {
        this._cycleIndex = -1;
        if (this._cycleResetId) {
            GLib.Source.remove(this._cycleResetId);
            this._cycleResetId = 0;
        }
        if (this._cycleOsd)
            this._cycleOsd.dismiss();
    }

    _refreshPopup() {
        if (this._popup && this._popup.visible)
            this._popup.refresh(this._store.getEntries());
    }
}
