// prefs.js
//
// Janela de preferências (libadwaita): número de itens, ícone na barra e o
// atalho de teclado (editável). Roda em um processo separado do gnome-shell.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';

import { ExtensionPreferences } from 'resource:///org/gnome/shell/extensions/prefs.js';

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

        // --- Comportamento ---
        const behavior = new Adw.PreferencesGroup({ title: 'Comportamento' });
        page.add(behavior);

        const maxRow = new Adw.SpinRow({
            title: 'Itens no histórico',
            subtitle: 'Quantas cópias manter (mais recentes primeiro)',
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
            title: 'Mostrar ícone na barra superior',
            subtitle: 'Abrir o histórico clicando no ícone, além do atalho',
        });
        behavior.add(indicatorRow);
        settings.bind('show-indicator', indicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // --- Atalho ---
        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Atalho',
            description: 'Enquanto o Clippo está ativo, ele assume o Super+V ' +
                '(normalmente usado pela bandeja de mensagens); o Super+M continua funcionando.',
        });
        page.add(shortcutGroup);

        const shortcutRow = new Adw.ActionRow({
            title: 'Abrir histórico',
            subtitle: 'Clique para definir; Backspace limpa; Esc cancela',
            activatable: true,
        });
        const shortcutLabel = new Gtk.ShortcutLabel({
            valign: Gtk.Align.CENTER,
            disabled_text: 'Desativado',
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
            title: 'Novo atalho',
            default_width: 380,
            default_height: 140,
            resizable: false,
        });
        dialog.set_child(new Gtk.Label({
            label: 'Pressione a nova combinação de teclas…\n\n' +
                'Backspace para limpar · Esc para cancelar',
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
            // espera uma tecla "real" junto de um modificador
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
