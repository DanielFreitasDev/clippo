// clipboardPopup.js
//
// Toda a interface St do popup: barra de busca, lista rolável de itens, fixados,
// navegação por teclado e fechamento (seleção / Esc / clique fora / perda de
// foco). O popup é posicionado na posição passada (cursor ou abaixo do ícone).
//
// O grab modal usa o GrabHelper do GNOME (o mesmo dos menus do Shell), que trata
// de forma robusta o fechamento por Esc e por clique fora — evitando travamentos.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';

const PREVIEW_MAX = 120; // caracteres exibidos por item (texto completo é guardado)

export const ClipboardPopup = GObject.registerClass({
    Signals: {
        'item-selected': { param_types: [GObject.TYPE_STRING] },
        'item-pin-toggled': { param_types: [GObject.TYPE_STRING] },
        'item-removed': { param_types: [GObject.TYPE_STRING] },
        'clear-requested': {},
    },
}, class ClipboardPopup extends GObject.Object {
    _init() {
        super._init();
        this._visible = false;
        this._entries = [];
        this._rows = [];
        this._visibleRows = [];
        this._highlight = -1;
        this._buildUI();
        this._grabHelper = new GrabHelper.GrabHelper(this.actor, {
            actionMode: Shell.ActionMode.POPUP,
        });
    }

    get visible() {
        return this._visible;
    }

    _buildUI() {
        this.actor = new St.BoxLayout({
            vertical: true,
            style_class: 'clippo-popup',
            reactive: true,
            can_focus: true,
        });

        // Cabeçalho: busca + botão limpar
        const header = new St.BoxLayout({ style_class: 'clippo-header' });

        this._searchEntry = new St.Entry({
            style_class: 'clippo-search',
            hint_text: 'Buscar…',
            can_focus: true,
            x_expand: true,
        });
        this._searchEntry.set_primary_icon(new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'clippo-search-icon',
        }));
        const clutterText = this._searchEntry.get_clutter_text();
        clutterText.connect('text-changed', () => this._applyFilter());
        clutterText.connect('key-press-event', (_ct, event) => this._onKeyPress(event));

        this._clearButton = new St.Button({
            style_class: 'clippo-icon-button',
            child: new St.Icon({ icon_name: 'user-trash-symbolic', icon_size: 16 }),
        });
        this._clearButton.connect('clicked', () => this.emit('clear-requested'));

        header.add_child(this._searchEntry);
        header.add_child(this._clearButton);
        this.actor.add_child(header);

        // Lista rolável
        this._scrollView = new St.ScrollView({
            style_class: 'clippo-scroll',
            x_expand: true,
            y_expand: true,
        });
        this._listBox = new St.BoxLayout({ vertical: true, style_class: 'clippo-list' });
        this._setScrollChild(this._scrollView, this._listBox);
        this.actor.add_child(this._scrollView);
    }

    // St.ScrollView trocou de API entre versões; isto cobre 48–50 com segurança.
    _setScrollChild(scroll, child) {
        if (typeof scroll.set_child === 'function')
            scroll.set_child(child);
        else if (typeof scroll.add_actor === 'function')
            scroll.add_actor(child);
        else
            scroll.add_child(child);
    }

    refresh(entries) {
        this._entries = entries || [];
        this._rebuildRows();
        this._applyFilter();
    }

    _rebuildRows() {
        this._listBox.destroy_all_children();
        this._rows = [];

        if (this._entries.length === 0) {
            this._listBox.add_child(new St.Label({
                style_class: 'clippo-empty',
                text: 'Nenhum item no histórico',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        for (const entry of this._entries) {
            const row = this._buildRow(entry);
            this._rows.push(row);
            this._listBox.add_child(row);
        }
    }

    _buildRow(entry) {
        const row = new St.BoxLayout({ style_class: 'clippo-row', x_expand: true });
        row._text = entry.text;

        const selectButton = new St.Button({
            style_class: 'clippo-item-button',
            x_expand: true,
        });
        const label = new St.Label({ text: this._preview(entry.text) });
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        label.clutter_text.set_line_wrap(false);
        selectButton.set_child(label);
        selectButton.connect('clicked', () => this._select(entry.text));

        const pinButton = new St.Button({
            style_class: 'clippo-icon-button',
            child: new St.Icon({
                icon_name: entry.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
                icon_size: 16,
            }),
        });
        pinButton.connect('clicked', () => this.emit('item-pin-toggled', entry.text));

        if (entry.pinned)
            row.add_style_class_name('clippo-row-pinned');

        row.add_child(selectButton);
        row.add_child(pinButton);
        return row;
    }

    _preview(text) {
        let t = text.replace(/\s+/g, ' ').trim();
        if (t.length > PREVIEW_MAX)
            t = `${t.slice(0, PREVIEW_MAX)}…`;
        return t;
    }

    _select(text) {
        this.emit('item-selected', text);
        this.dismiss();
    }

    _applyFilter() {
        const query = this._searchEntry.get_text().trim().toLowerCase();
        this._visibleRows = [];
        for (const row of this._rows) {
            const match = query === '' || row._text.toLowerCase().includes(query);
            row.visible = match;
            if (match)
                this._visibleRows.push(row);
        }
        this._highlight = this._visibleRows.length ? 0 : -1;
        this._updateHighlight();
    }

    _updateHighlight() {
        for (const row of this._rows)
            row.remove_style_class_name('clippo-row-selected');
        if (this._highlight >= 0 && this._highlight < this._visibleRows.length) {
            const row = this._visibleRows[this._highlight];
            row.add_style_class_name('clippo-row-selected');
            this._ensureRowVisible(row);
        }
    }

    _move(delta) {
        if (!this._visibleRows.length)
            return;
        const n = this._visibleRows.length;
        this._highlight = (this._highlight + delta + n) % n;
        this._updateHighlight();
    }

    _ensureRowVisible(row) {
        const vadj = this._scrollView.vadjustment
            ?? this._scrollView.get_vadjustment?.()
            ?? this._scrollView.vscroll?.adjustment;
        if (!vadj)
            return;
        const box = row.get_allocation_box();
        if (box.y1 < vadj.value)
            vadj.value = box.y1;
        else if (box.y2 > vadj.value + vadj.page_size)
            vadj.value = box.y2 - vadj.page_size;
    }

    _onKeyPress(event) {
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Down:
            this._move(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._move(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            if (this._highlight >= 0)
                this._select(this._visibleRows[this._highlight]._text);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete:
            if (this._highlight >= 0)
                this.emit('item-removed', this._visibleRows[this._highlight]._text);
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE; // caracteres normais filtram; Esc -> GrabHelper
        }
    }

    show({ x, y }) {
        if (this._visible)
            return;

        if (!this.actor.get_parent())
            Main.layoutManager.uiGroup.add_child(this.actor);
        this.actor.show();

        // começa sempre com a lista cheia
        this._searchEntry.set_text('');
        this._applyFilter();

        const monitor = Main.layoutManager.currentMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        // limita a altura para caber na tela; o ScrollView cuida do excedente
        this.actor.style = `max-height: ${Math.floor(workArea.height * 0.6)}px;`;

        // medir só depois de estar na árvore e visível
        const [, , natWidth, natHeight] = this.actor.get_preferred_size();

        let px = Math.round(x);
        let py = Math.round(y);
        if (px + natWidth > workArea.x + workArea.width)
            px = workArea.x + workArea.width - natWidth;
        if (py + natHeight > workArea.y + workArea.height)
            py = workArea.y + workArea.height - natHeight;
        px = Math.max(px, workArea.x);
        py = Math.max(py, workArea.y);
        this.actor.set_position(px, py);

        // Grab modal robusto (Esc + clique fora tratados pelo GrabHelper).
        const ok = this._grabHelper.grab({
            actor: this.actor,
            onUngrab: () => this._onUngrabbed(),
        });
        if (!ok) {
            this.actor.hide();
            return;
        }
        this._visible = true;
        this._searchEntry.grab_key_focus();
    }

    // Chamado pelo GrabHelper quando o grab termina (Esc, clique fora ou ungrab).
    _onUngrabbed() {
        this._visible = false;
        this.actor.hide();
    }

    // Fechamento programático (após seleção ou no disable).
    dismiss() {
        if (!this._visible)
            return;
        // ungrab dispara onUngrab -> _onUngrabbed, que esconde o popup
        this._grabHelper.ungrab({ isUser: false });
        // garantia extra caso o callback não rode
        this._visible = false;
        this.actor.hide();
    }

    destroy() {
        this.dismiss();
        this._grabHelper = null;
        if (this.actor) {
            this.actor.destroy();
            this.actor = null;
        }
    }
});
