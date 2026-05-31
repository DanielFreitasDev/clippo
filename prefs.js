// prefs.js
//
// Preferences window (libadwaita): number of items, panel icon and the
// (editable) keyboard shortcut. Runs in a separate process from gnome-shell.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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

        const detectRow = new Adw.SwitchRow({
            title: _('Detect content type'),
            subtitle: _('Recognize links, colors and emails, and offer quick actions'),
        });
        behavior.add(detectRow);
        settings.bind('detect-types', detectRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // --- Privacy ---
        const privacy = new Adw.PreferencesGroup({
            title: _('Privacy'),
            description: _('Control what gets captured into the history.'),
        });
        page.add(privacy);

        const switches = [
            ['private-mode', _('Private mode'), _('Pause capturing new items')],
            ['capture-images', _('Capture images'), _('Store copied images (PNG) in the history')],
            ['trim-whitespace', _('Trim whitespace'), _('Remove leading and trailing spaces and line breaks')],
            ['capture-primary', _('Capture the primary selection'), _('Also store text selected with the mouse (middle-click)')],
            ['order-by-recent-use', _('Order by recent use'), _('Show recently used items first')],
        ];
        for (const [key, title, subtitle] of switches) {
            const row = new Adw.SwitchRow({ title, subtitle });
            privacy.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        }

        // --- Excluded apps ---
        const excluded = new Adw.PreferencesGroup({
            title: _('Excluded applications'),
            description: _('Copies made while one of these apps is focused are not stored. Use its app id or window class, e.g. org.keepassxc.KeePassXC.'),
        });
        page.add(excluded);

        const addRow = new Adw.EntryRow({ title: _('Add an app id…') });
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        addRow.add_suffix(addButton);
        excluded.add(addRow);

        let excludedRows = [];
        const refreshExcluded = () => {
            for (const row of excludedRows)
                excluded.remove(row);
            excludedRows = [];
            for (const app of settings.get_strv('excluded-apps')) {
                const row = new Adw.ActionRow({ title: app });
                const del = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                del.connect('clicked', () => {
                    settings.set_strv('excluded-apps',
                        settings.get_strv('excluded-apps').filter(a => a !== app));
                });
                row.add_suffix(del);
                excluded.add(row);
                excludedRows.push(row);
            }
        };
        const addApp = () => {
            const text = addRow.get_text().trim();
            if (!text)
                return;
            const list = settings.get_strv('excluded-apps');
            if (!list.includes(text)) {
                list.push(text);
                settings.set_strv('excluded-apps', list);
            }
            addRow.set_text('');
        };
        addButton.connect('clicked', addApp);
        addRow.connect('entry-activated', addApp);
        const excludedChangedId = settings.connect('changed::excluded-apps', refreshExcluded);
        window.connect('destroy', () => settings.disconnect(excludedChangedId));
        refreshExcluded();

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
        const dialog = new Adw.Dialog({
            title: _('New shortcut'),
            content_width: 380,
            content_height: 140,
        });
        dialog.set_child(new Gtk.Label({
            label: _('Press the new key combination…\n\nBackspace to clear · Esc to cancel'),
            justify: Gtk.Justification.CENTER,
        }));

        // Capture phase: intercept the key combination before any default handling.
        const controller = new Gtk.EventControllerKey();
        controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
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

        dialog.present(parent);
    }
}
