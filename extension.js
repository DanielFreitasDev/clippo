// extension.js
//
// Orquestra o ciclo de vida do Clippo: liga o monitor de clipboard ao store de
// histórico e ao popup, registra o atalho Super+V (tratando o conflito com a
// bandeja de mensagens) e cria o ícone na barra. Como extensão do Shell, é
// iniciada automaticamente no login.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ClipboardManager } from './lib/clipboardManager.js';
import { HistoryStore } from './lib/historyStore.js';
import { ClipboardPopup } from './lib/clipboardPopup.js';
import { ClippoIndicator } from './lib/indicator.js';

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
            this._store.add(text);
            this._refreshPopup();
        });
        this._clipboard.start();

        this._popup = new ClipboardPopup();
        this._popup.connect('item-selected', (_p, text) => {
            this._clipboard.setClipboard(text);
            this._store.add(text); // move o item escolhido para o topo
        });
        this._popup.connect('item-pin-toggled', (_p, text) => {
            this._store.togglePin(text);
            this._refreshPopup();
        });
        this._popup.connect('item-removed', (_p, text) => {
            this._store.remove(text);
            this._refreshPopup();
        });
        this._popup.connect('clear-requested', () => {
            this._store.clear();
            this._refreshPopup();
        });

        this._addKeybinding();

        this._indicator = null;
        if (this._settings.get_boolean('show-indicator'))
            this._createIndicator();

        this._maxItemsId = this._settings.connect('changed::max-items', () => {
            this._store.setMaxItems(this._settings.get_int('max-items'));
            this._refreshPopup();
        });
        this._showIndicatorId = this._settings.connect('changed::show-indicator', () => {
            if (this._settings.get_boolean('show-indicator'))
                this._createIndicator();
            else
                this._destroyIndicator();
        });
    }

    disable() {
        // Fecha o popup primeiro para liberar qualquer grab modal.
        if (this._popup)
            this._popup.dismiss();

        this._removeKeybinding();
        this._destroyIndicator();

        if (this._settings) {
            if (this._maxItemsId)
                this._settings.disconnect(this._maxItemsId);
            if (this._showIndicatorId)
                this._settings.disconnect(this._showIndicatorId);
            this._maxItemsId = 0;
            this._showIndicatorId = 0;
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
            this._store.destroy(); // salva de forma síncrona
            this._store = null;
        }

        this._settings = null;
    }

    _addKeybinding() {
        // Conflito conhecido: no GNOME, toggle-message-tray usa ['<Super>v','<Super>m'].
        // Removemos só o <Super>v (mantendo <Super>m) e restauramos no disable.
        this._shellKb = new Gio.Settings({ schema_id: SHELL_KB_SCHEMA });
        const tray = this._shellKb.get_strv(TRAY_KEY);
        this._removedTrayBinding = tray.includes(SUPER_V);
        if (this._removedTrayBinding)
            this._shellKb.set_strv(TRAY_KEY, tray.filter(a => a !== SUPER_V));

        Main.wm.addKeybinding(
            KEYBINDING,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._toggle());
    }

    _removeKeybinding() {
        Main.wm.removeKeybinding(KEYBINDING);
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
