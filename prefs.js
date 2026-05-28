// prefs.js
//
// Preferences window (libadwaita): number of items, panel icon and the
// (editable) keyboard shortcut. Runs in a separate process from gnome-shell.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/shell/extensions/prefs.js';

const MODIFIER_KEYVALS = [
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
    Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
    Gdk.KEY_Super_L, Gdk.KEY_Super_R,
    Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
    Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
    Gdk.KEY_ISO_Level3_Shift,
];

export default class ClippoPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- Behavior ---
        const behavior = new Adw.PreferencesGroup({ title: _('Behavior') });
        page.add(behavior);

        const maxRow = new Adw.SpinRow({
            title: _('History items'),
            subtitle: _('How many copies to keep (most recent first)'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 500,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        behavior.add(maxRow);
        settings.bind('max-items', maxRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        const indicatorRow = new Adw.SwitchRow({
            title: _('Show icon in the top bar'),
            subtitle: _('Open the history by clicking the icon, in addition to the shortcut'),
        });
        behavior.add(indicatorRow);
        settings.bind('show-indicator', indicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // --- Shortcut ---
        const shortcutGroup = new Adw.PreferencesGroup({
            title: _('Shortcut'),
            description: _('While Clippo is active it takes over Super+V (normally used by the message tray); Super+M keeps working.'),
        });
        page.add(shortcutGroup);

        const shortcutRow = new Adw.ActionRow({
            title: _('Open history'),
            subtitle: _('Click to set; Backspace clears; Esc cancels'),
            activatable: true,
        });
        const shortcutLabel = new Gtk.ShortcutLabel({
            valign: Gtk.Align.CENTER,
            disabled_text: _('Disabled'),
        });
        const syncLabel = () => {
            const accels = settings.get_strv('toggle-clippo');
            shortcutLabel.set_accelerator(accels.length ? accels[0] : '');
        };
        syncLabel();
        const changedId = settings.connect('changed::toggle-clippo', syncLabel);
        window.connect('destroy', () => settings.disconnect(changedId));

        shortcutRow.add_suffix(shortcutLabel);
        shortcutRow.connect('activated', () => this._captureShortcut(window, settings));
        shortcutGroup.add(shortcutRow);
    }

    _captureShortcut(parent, settings) {
        const dialog = new Gtk.Window({
            modal: true,
            transient_for: parent,
            title: _('New shortcut'),
            default_width: 380,
            default_height: 140,
            resizable: false,
        });
        dialog.set_child(new Gtk.Label({
            label: _('Press the new key combination…\n\nBackspace to clear · Esc to cancel'),
            justify: Gtk.Justification.CENTER,
        }));

        const controller = new Gtk.EventControllerKey();
        dialog.add_controller(controller);
        controller.connect('key-pressed', (_c, keyval, _keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();

            if (keyval === Gdk.KEY_Escape && mask === 0) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (keyval === Gdk.KEY_BackSpace && mask === 0) {
                settings.set_strv('toggle-clippo', []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // expect a "real" key together with a modifier
            if (MODIFIER_KEYVALS.includes(keyval))
                return Gdk.EVENT_STOP;
            if (mask === 0)
                return Gdk.EVENT_STOP;

            const accel = Gtk.accelerator_name(keyval, mask);
            if (accel)
                settings.set_strv('toggle-clippo', [accel]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });

        dialog.present();
    }
}
