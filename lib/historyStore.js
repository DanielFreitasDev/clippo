// historyStore.js
//
// Dono dos dados do histórico: itens fixados (pinned) + histórico rotativo
// (items), em memória, com persistência atômica em JSON no diretório de dados
// do usuário (~/.local/share/clippo/history.json). Sobrevive a logout/reboot.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const FILE_VERSION = 1;
const MAX_ITEM_BYTES = 100 * 1024; // limita o tamanho de um único item
const SAVE_DEBOUNCE_MS = 500;

export class HistoryStore {
    constructor(maxItems) {
        this._maxItems = maxItems;
        this._items = [];   // histórico rotativo, mais novo primeiro
        this._pinned = [];  // itens fixados, não sofrem trim
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
            // arquivo ausente ou corrompido: começa vazio, nunca lança
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
        if (text.length > MAX_ITEM_BYTES)
            text = text.slice(0, MAX_ITEM_BYTES);

        // Se já está fixado, mantém-se onde está (já é preservado).
        if (this._pinned.includes(text))
            return;

        // Dedup: remove ocorrência anterior e recoloca no topo.
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
            // desfixar: volta para o topo do histórico
            this._pinned.splice(pIdx, 1);
            this._items.unshift(text);
            this._trim();
        } else {
            // fixar: sai do histórico e vai para o topo dos fixados
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

    // Limpa o histórico rotativo, mantendo os itens fixados.
    clear() {
        this._items = [];
        this._scheduleSave();
    }

    setMaxItems(n) {
        this._maxItems = n;
        this._trim();
        this._scheduleSave();
    }

    // Fixados no topo, seguidos do histórico (mais novo primeiro).
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
            // replace_contents grava em arquivo temporário e renomeia (atômico).
            file.replace_contents(
                new TextEncoder().encode(payload),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null);
            // Permissões 0600 (privacidade: histórico pode conter dados sensíveis).
            file.set_attribute_uint32('unix::mode', 0o600,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            logError(e, 'clippo: falha ao salvar o histórico');
        }
    }

    // Salva de forma síncrona e cancela qualquer save pendente (usado no disable).
    destroy() {
        if (this._saveSourceId) {
            GLib.Source.remove(this._saveSourceId);
            this._saveSourceId = 0;
        }
        this.save();
    }
}
