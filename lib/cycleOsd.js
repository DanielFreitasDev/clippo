// cycleOsd.js
//
// A small on-screen overlay shown while cycling through the clipboard history
// with the keyboard shortcuts (paste next / previous). It is deliberately NOT a
// libnotify notification — those are the wrong UX for rapid cycling — but a
// transient St widget placed in the Shell's overlay, auto-hidden a moment after
// the last keypress. extension.js drives it: show(items, index) on each press,
// dismiss() when cycling ends or on disable.
//
// Like the popup, this paints its own surface and follows the system light/dark
// scheme via a clippo-dark / clippo-light class pushed in by extension.js. It
// owns its actor (composition) rather than subclassing St, so it never shadows
// Clutter.Actor's own show()/hide().

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const HIDE_DELAY_MS = 1500;  // hides this long after the last cycle keypress
const PREVIEW_MAX = 70;      // characters shown per line

export class CycleOsd {
    constructor() {
        this._hideId = 0;
        this._darkTheme = true;

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'clippo-cycle-osd',
            visible: false,
            reactive: false,
        });
        this._applyColorScheme();

        this._prevLabel = new St.Label({ style_class: 'clippo-cycle-neighbor' });
        this._currentLabel = new St.Label({ style_class: 'clippo-cycle-current' });
        this._nextLabel = new St.Label({ style_class: 'clippo-cycle-neighbor' });
        this._counter = new St.Label({ style_class: 'clippo-cycle-counter' });
        for (const l of [this._prevLabel, this._currentLabel, this._nextLabel, this._counter]) {
            l.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            l.clutter_text.set_line_wrap(false);
            l.x_align = Clutter.ActorAlign.CENTER;
            this.actor.add_child(l);
        }

        Main.layoutManager.uiGroup.add_child(this.actor);
    }

    // Follows the system light/dark color scheme (pushed in from extension.js).
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

    _label(entry) {
        if (!entry)
            return '';
        if (entry.type === 'image') {
            const dims = entry.width && entry.height ? `${entry.width}×${entry.height}` : '';
            return dims ? _('Image %s').replace('%s', dims) : _('Image');
        }
        let t = (entry.text ?? '').replace(/\s+/g, ' ').trim();
        if (t.length > PREVIEW_MAX)
            t = `${t.slice(0, PREVIEW_MAX)}…`;
        return t;
    }

    // Shows the item at `index` prominently, with faint hints of its neighbors
    // and a position counter. Re-arms the auto-hide timer on every call.
    show(items, index) {
        const n = items.length;
        if (!n || !this.actor)
            return;

        this._currentLabel.text = this._label(items[index]);
        const prev = index > 0 ? items[index - 1] : null;
        const next = index < n - 1 ? items[index + 1] : null;
        this._prevLabel.text = prev ? `↑  ${this._label(prev)}` : '';
        this._prevLabel.visible = !!prev;
        this._nextLabel.text = next ? `↓  ${this._label(next)}` : '';
        this._nextLabel.visible = !!next;
        this._counter.text = `${index + 1} / ${n}`;

        this.actor.visible = true;
        this._reposition();
        this._armHide();
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const [, natWidth] = this.actor.get_preferred_width(-1);
        const [, natHeight] = this.actor.get_preferred_height(natWidth);
        const x = monitor.x + Math.floor((monitor.width - natWidth) / 2);
        const y = monitor.y + Math.floor(monitor.height * 0.78 - natHeight / 2);
        this.actor.set_position(x, y);
    }

    _armHide() {
        if (this._hideId)
            GLib.Source.remove(this._hideId);
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY_MS, () => {
            this._hideId = 0;
            if (this.actor)
                this.actor.visible = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    dismiss() {
        if (this._hideId) {
            GLib.Source.remove(this._hideId);
            this._hideId = 0;
        }
        if (this.actor)
            this.actor.visible = false;
    }

    destroy() {
        if (this._hideId) {
            GLib.Source.remove(this._hideId);
            this._hideId = 0;
        }
        if (this.actor) {
            this.actor.destroy();
            this.actor = null;
        }
    }
}
