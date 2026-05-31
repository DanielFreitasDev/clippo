// clipboardPopup.js
//
// All of the popup's St UI: a search bar with a scrollable item list, plus a
// secondary "detail" view (item detail / edit / QR) shown in the same actor.
// Keyboard navigation and dismissal (selection / Esc / click-outside / focus
// loss) are handled here too. The popup is placed at the position passed in
// (pointer or below the icon).
//
// The modal grab uses GNOME's GrabHelper (the same one the Shell menus use),
// which robustly handles closing on Esc and on click-outside — avoiding session
// lockups. The detail view lives INSIDE the grabbed actor; we never open a
// second modal, and the back button (not Esc) returns to the list so we don't
// fight the GrabHelper's Esc handling.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';
import { gettext as _, ngettext } from 'resource:///org/gnome/shell/extensions/extension.js';
import { detectSubtype, colorValue } from './contentType.js';
import qrcode from './qrcodegen.js';

const PREVIEW_MAX = 120;   // characters shown per row (the full text is kept)
const QR_MAX_CHARS = 800;  // beyond this a QR code becomes hard to scan

export const ClipboardPopup = GObject.registerClass({
    Signals: {
        'item-selected': { param_types: [GObject.TYPE_STRING] },
        'item-pin-toggled': { param_types: [GObject.TYPE_STRING] },
        'item-removed': { param_types: [GObject.TYPE_STRING] },
        'item-edited': { param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING] },
        'action-invoked': { param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING] },
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
        this._mode = 'list';
        this.detectTypes = true;
        this.dataDir = null;
        this._darkTheme = true; // updated from the system color-scheme by extension.js
        this._buildUI();
        this._grabHelper = new GrabHelper.GrabHelper(this.actor, {
            actionMode: Shell.ActionMode.POPUP,
        });
    }

    get visible() {
        return this._visible;
    }

    // Follows the system light/dark color scheme (pushed in from extension.js).
    // The popup floats over the Shell, so we paint our own surface: toggle a
    // class and let the stylesheet supply the matching palette.
    set darkTheme(isDark) {
        this._darkTheme = !!isDark;
        this._applyColorScheme();
    }

    _applyColorScheme() {
        if (!this.actor)
            return;
        this.actor.remove_style_class_name('clippo-dark');
        this.actor.remove_style_class_name('clippo-light');
        this.actor.add_style_class_name(this._darkTheme ? 'clippo-dark' : 'clippo-light');
    }

    _buildUI() {
        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'clippo-popup',
            reactive: true,
            can_focus: true,
        });
        this._applyColorScheme();

        // --- List view (search + scrollable list) ---
        this._listView = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        const header = new St.BoxLayout({ style_class: 'clippo-header' });
        this._searchEntry = new St.Entry({
            style_class: 'clippo-search',
            hint_text: _('Search…'),
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
        this._clearButton.accessible_name = _('Clear history');
        this._clearButton.connect('clicked', () => this.emit('clear-requested'));

        header.add_child(this._searchEntry);
        header.add_child(this._clearButton);
        this._listView.add_child(header);

        this._scrollView = new St.ScrollView({
            style_class: 'clippo-scroll',
            x_expand: true,
            y_expand: true,
        });
        this._listBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'clippo-list',
        });
        this._setScrollChild(this._scrollView, this._listBox);
        this._listView.add_child(this._scrollView);
        this.actor.add_child(this._listView);

        // --- Detail view (item detail / edit / QR), hidden by default ---
        this._detailView = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'clippo-detail',
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this.actor.add_child(this._detailView);
    }

    // St.ScrollView changed its API across versions; this covers 48–50 safely.
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

    _entryById(id) {
        return this._entries.find(e => e.id === id) ?? null;
    }

    _rebuildRows() {
        this._listBox.destroy_all_children();
        this._rows = [];

        if (this._entries.length === 0) {
            this._listBox.add_child(new St.Label({
                style_class: 'clippo-empty',
                text: _('No items in history'),
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
        row._id = entry.id;
        // Kept separately because the signals now carry the id, but the search
        // filter still needs something to match against.
        row._searchText = entry.type === 'image'
            ? _('Image').toLowerCase()
            : (entry.text ?? '').toLowerCase();

        const subtype = (this.detectTypes && entry.type === 'text')
            ? detectSubtype(entry.text)
            : null;

        const lead = this._buildLead(entry, subtype);
        if (lead)
            row.add_child(lead);

        const selectButton = new St.Button({
            style_class: 'clippo-item-button',
            x_expand: true,
        });
        selectButton.set_child(this._buildRowContent(entry));
        selectButton.connect('clicked', () => this._select(entry.id));
        row.add_child(selectButton);

        const timeLabel = new St.Label({
            style_class: 'clippo-time',
            text: this._relativeTime(entry.createdAt),
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(timeLabel);

        if (subtype === 'url' || subtype === 'email') {
            const actionButton = new St.Button({
                style_class: 'clippo-icon-button',
                child: new St.Icon({ icon_name: 'go-jump-symbolic', icon_size: 16 }),
            });
            actionButton.accessible_name = subtype === 'email' ? _('Send email') : _('Open link');
            actionButton.connect('clicked', () => this.emit('action-invoked', entry.id, 'open'));
            row.add_child(actionButton);
        }

        const moreButton = new St.Button({
            style_class: 'clippo-icon-button',
            child: new St.Icon({ icon_name: 'view-more-symbolic', icon_size: 16 }),
        });
        moreButton.accessible_name = _('More actions');
        moreButton.connect('clicked', () => this._openDetail(entry.id));
        row.add_child(moreButton);

        const pinButton = new St.Button({
            style_class: 'clippo-icon-button',
            child: new St.Icon({
                icon_name: entry.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
                icon_size: 16,
            }),
        });
        pinButton.accessible_name = entry.pinned ? _('Unpin') : _('Pin');
        pinButton.connect('clicked', () => this.emit('item-pin-toggled', entry.id));
        row.add_child(pinButton);

        if (entry.pinned)
            row.add_style_class_name('clippo-row-pinned');

        return row;
    }

    // Leading widget: a color swatch for colors, a type icon for url/email/code,
    // or null for plain text.
    _buildLead(entry, subtype) {
        if (subtype === 'color') {
            const swatch = new St.Bin({
                style_class: 'clippo-swatch',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const value = colorValue(entry.text);
            if (value)
                swatch.style = `background-color: ${value};`;
            return swatch;
        }
        const iconName = {
            url: 'web-browser-symbolic',
            email: 'mail-unread-symbolic',
            code: 'text-x-generic-symbolic',
        }[subtype];
        if (!iconName)
            return null;
        return new St.Icon({
            style_class: 'clippo-type-icon',
            icon_name: iconName,
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    // Content of a row's main button: a thumbnail + size for images, otherwise
    // the truncated text preview.
    _buildRowContent(entry) {
        if (entry.type === 'image') {
            const box = new St.BoxLayout({ style_class: 'clippo-row-image' });
            const abs = this._absImagePath(entry);
            if (abs) {
                box.add_child(new St.Icon({
                    style_class: 'clippo-thumb',
                    gicon: Gio.FileIcon.new(Gio.File.new_for_path(abs)),
                    icon_size: 40,
                }));
            }
            const dims = entry.width && entry.height ? `${entry.width}×${entry.height}` : '';
            box.add_child(new St.Label({
                text: dims ? _('Image %s').replace('%s', dims) : _('Image'),
                y_align: Clutter.ActorAlign.CENTER,
            }));
            return box;
        }
        const label = new St.Label({ text: this._preview(entry.text ?? '') });
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        label.clutter_text.set_line_wrap(false);
        return label;
    }

    _absImagePath(entry) {
        if (!this.dataDir || !entry.imagePath)
            return null;
        return GLib.build_filenamev([this.dataDir, entry.imagePath]);
    }

    _preview(text) {
        let t = text.replace(/\s+/g, ' ').trim();
        if (t.length > PREVIEW_MAX)
            t = `${t.slice(0, PREVIEW_MAX)}…`;
        return t;
    }

    // Short "x min ago" label for a row, based on when the item was copied.
    // Recomputed on each refresh (the popup is rebuilt every time it opens).
    _relativeTime(ms) {
        if (!ms)
            return '';
        const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
        if (secs < 60)
            return _('just now');
        const mins = Math.floor(secs / 60);
        if (mins < 60)
            return ngettext('%d minute ago', '%d minutes ago', mins).replace('%d', String(mins));
        const hours = Math.floor(mins / 60);
        if (hours < 24)
            return ngettext('%d hour ago', '%d hours ago', hours).replace('%d', String(hours));
        const days = Math.floor(hours / 24);
        if (days < 7)
            return ngettext('%d day ago', '%d days ago', days).replace('%d', String(days));
        return new Date(ms).toLocaleDateString();
    }

    _select(id) {
        this.emit('item-selected', id);
        this.dismiss();
    }

    // ---- Detail / edit / QR views (shown inside the same grabbed actor) ----

    _detailTopbar(title) {
        const bar = new St.BoxLayout({ style_class: 'clippo-detail-header' });
        const back = new St.Button({
            style_class: 'clippo-icon-button',
            child: new St.Icon({ icon_name: 'go-previous-symbolic', icon_size: 16 }),
        });
        back.accessible_name = _('Back');
        back.connect('clicked', () => this._showList());
        bar.add_child(back);
        bar.add_child(new St.Label({
            text: title,
            style_class: 'clippo-detail-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return bar;
    }

    _switchToDetail(focusActor) {
        this._listView.visible = false;
        this._detailView.visible = true;
        if (focusActor)
            focusActor.grab_key_focus();
    }

    _showList() {
        this._mode = 'list';
        this._detailView.destroy_all_children();
        this._detailView.visible = false;
        this._listView.visible = true;
        this._editEntry = null;
        this._searchEntry.grab_key_focus();
    }

    _openDetail(id) {
        const entry = this._entryById(id);
        if (!entry)
            return;
        this._mode = 'detail';
        this._detailView.destroy_all_children();
        this._detailView.add_child(this._detailTopbar(_('Item')));

        const scroll = new St.ScrollView({ style_class: 'clippo-detail-scroll', y_expand: true });
        const bodyBox = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL });
        if (entry.type === 'image') {
            const abs = this._absImagePath(entry);
            if (abs) {
                bodyBox.add_child(new St.Icon({
                    style_class: 'clippo-detail-image',
                    gicon: Gio.FileIcon.new(Gio.File.new_for_path(abs)),
                    icon_size: 256,
                    x_align: Clutter.ActorAlign.CENTER,
                }));
            }
        } else {
            const body = new St.Label({ style_class: 'clippo-detail-text', text: entry.text ?? '' });
            body.clutter_text.set_line_wrap(true);
            body.clutter_text.set_selectable(true);
            bodyBox.add_child(body);
        }
        this._setScrollChild(scroll, bodyBox);
        this._detailView.add_child(scroll);

        const actions = new St.BoxLayout({ style_class: 'clippo-detail-actions' });
        const addAction = (label, fn) => {
            const btn = new St.Button({ style_class: 'clippo-detail-button', label });
            btn.connect('clicked', fn);
            actions.add_child(btn);
        };
        if (entry.type === 'text') {
            addAction(_('Edit'), () => this._openEdit(id));
            if ((entry.text ?? '').length <= QR_MAX_CHARS)
                addAction(_('QR code'), () => this._openQr(id));
            const sub = this.detectTypes ? detectSubtype(entry.text) : null;
            if (sub === 'url' || sub === 'email')
                addAction(_('Open'), () => this.emit('action-invoked', id, 'open'));
        }
        addAction(_('Remove'), () => {
            this.emit('item-removed', id);
            this._showList();
        });
        this._detailView.add_child(actions);

        this._switchToDetail(actions.get_first_child());
    }

    _openEdit(id) {
        const entry = this._entryById(id);
        if (!entry || entry.type !== 'text')
            return;
        this._mode = 'edit';
        this._detailView.destroy_all_children();
        this._detailView.add_child(this._detailTopbar(_('Edit')));

        this._editEntry = new St.Entry({ style_class: 'clippo-edit-entry', x_expand: true, y_expand: true });
        const ct = this._editEntry.get_clutter_text();
        ct.set_single_line_mode(false);
        ct.set_line_wrap(true);
        ct.set_activatable(false); // Enter inserts a newline, not "save"
        this._editEntry.set_text(entry.text);
        this._detailView.add_child(this._editEntry);

        const actions = new St.BoxLayout({ style_class: 'clippo-detail-actions' });
        const save = new St.Button({ style_class: 'clippo-detail-button', label: _('Save') });
        save.connect('clicked', () => {
            const text = this._editEntry.get_text();
            if (text && text.length)
                this.emit('item-edited', id, text);
        });
        const cancel = new St.Button({ style_class: 'clippo-detail-button', label: _('Cancel') });
        cancel.connect('clicked', () => this._showList());
        actions.add_child(save);
        actions.add_child(cancel);
        this._detailView.add_child(actions);

        this._switchToDetail(this._editEntry);
    }

    _openQr(id) {
        const entry = this._entryById(id);
        if (!entry || entry.type !== 'text')
            return;
        this._mode = 'qr';
        this._detailView.destroy_all_children();
        this._detailView.add_child(this._detailTopbar(_('QR code')));

        const area = new St.DrawingArea({ style_class: 'clippo-qr', x_expand: true, y_expand: true });
        area.connect('repaint', () => this._drawQr(area, entry.text));
        this._detailView.add_child(area);

        this._switchToDetail(area);
        area.queue_repaint();
    }

    _drawQr(area, text) {
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            const qr = qrcode(0, 'M');
            qr.addData(text);
            qr.make();
            const n = qr.getModuleCount();
            const quiet = 2;
            const total = n + quiet * 2;
            const scale = Math.max(1, Math.floor(Math.min(w, h) / total));
            const size = scale * total;
            const offX = Math.floor((w - size) / 2);
            const offY = Math.floor((h - size) / 2);

            cr.setSourceRGB(1, 1, 1);
            cr.rectangle(offX, offY, size, size);
            cr.fill();

            cr.setSourceRGB(0, 0, 0);
            for (let r = 0; r < n; r++) {
                for (let c = 0; c < n; c++) {
                    if (qr.isDark(r, c))
                        cr.rectangle(offX + (c + quiet) * scale, offY + (r + quiet) * scale, scale, scale);
                }
            }
            cr.fill();
        } catch (e) {
            logError(e, 'clippo: failed to render QR code');
        } finally {
            cr.$dispose();
        }
    }

    // ---- List filtering / keyboard ----

    _applyFilter() {
        const query = this._searchEntry.get_text().trim().toLowerCase();
        this._visibleRows = [];
        for (const row of this._rows) {
            const match = query === '' || row._searchText.includes(query);
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
        case Clutter.KEY_Right:
            if (this._highlight >= 0)
                this._openDetail(this._visibleRows[this._highlight]._id);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            if (this._highlight >= 0)
                this._select(this._visibleRows[this._highlight]._id);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete: {
            // Don't hijack forward-delete while a search query is being edited;
            // Shift+Delete forces removal.
            const editing = this._searchEntry.get_text().length > 0;
            const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
            if (this._highlight >= 0 && (shift || !editing)) {
                this.emit('item-removed', this._visibleRows[this._highlight]._id);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        default:
            return Clutter.EVENT_PROPAGATE; // normal characters filter; Esc -> GrabHelper
        }
    }

    show({ x, y }) {
        if (this._visible)
            return;

        if (!this.actor.get_parent())
            Main.layoutManager.uiGroup.add_child(this.actor);
        this.actor.show();

        // always start on the list view with the full list
        this._mode = 'list';
        this._detailView.destroy_all_children();
        this._detailView.visible = false;
        this._listView.visible = true;
        this._searchEntry.set_text('');
        this._applyFilter();

        const monitor = Main.layoutManager.currentMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        // cap the height to fit on screen; the ScrollView handles the overflow
        this.actor.style = `max-height: ${Math.floor(workArea.height * 0.6)}px;`;

        // measure only after it's in the tree and visible
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

        // Robust modal grab (Esc + click-outside handled by GrabHelper).
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

    // Called by GrabHelper when the grab ends (Esc, click-outside or ungrab).
    _onUngrabbed() {
        this._visible = false;
        this.actor.hide();
    }

    // Programmatic dismissal (after selection or on disable).
    dismiss() {
        if (!this._visible)
            return;
        // ungrab triggers onUngrab -> _onUngrabbed, which hides the popup
        this._grabHelper.ungrab({ isUser: false });
        // extra safety in case the callback doesn't run
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
