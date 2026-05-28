// clipboardManager.js
//
// Monitora a área de transferência do sistema e emite 'text-copied' sempre que
// um novo texto é copiado (CTRL+C). Em sessões Wayland do GNOME, só o processo
// do Shell tem acesso privilegiado ao clipboard em segundo plano, via
// Meta.Selection — por isso isto vive dentro de uma extensão.

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
        // Guarda anti-loop: ao escrever no clipboard nós mesmos disparamos um
        // 'owner-changed'; queremos ignorá-lo para não recapturar/duplicar.
        this._selfTriggered = false;
        this._lastText = null;
        this._resetSourceId = 0;
    }

    start() {
        if (this._ownerChangedId)
            return;
        this._ownerChangedId = this._selection.connect('owner-changed',
            (_selection, selectionType) => {
                // Só nos interessa a área de transferência (CTRL+C),
                // não a seleção primária (botão do meio do mouse).
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
                return; // imagens/arquivos/vazio: ignorados na v1 (texto apenas)
            if (text === this._lastText)
                return;
            this._lastText = text;
            this.emit('text-copied', text);
        });
    }

    // Coloca um texto de volta no clipboard (ao selecionar um item do histórico),
    // para que o próximo CTRL+V cole esse conteúdo.
    setClipboard(text) {
        this._selfTriggered = true;
        this._lastText = text;
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        // Segurança: se por algum motivo o 'owner-changed' não chegar, liberamos
        // a guarda depois de um tempo curto para não travar a próxima captura.
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
