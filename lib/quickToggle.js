// quickToggle.js
//
// A Quick Settings toggle (the modern GNOME 45+ pattern) that pauses/resumes
// clipboard capture. It is bound to the 'private-mode' GSetting, so it stays in
// sync with the preferences window and the clipboard manager automatically. A
// small status-area icon also appears while capture is paused.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import { QuickToggle, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const PRIVATE_ICON = 'changes-prevent-symbolic';

const ClippoToggle = GObject.registerClass(
class ClippoToggle extends QuickToggle {
    _init(settings) {
        super._init({
            title: _('Private Mode'),
            subtitle: _('Pause clipboard history'),
            iconName: PRIVATE_ICON,
            toggleMode: true,
        });
        // Checked == private mode == capture paused.
        settings.bind('private-mode', this, 'checked', Gio.SettingsBindFlags.DEFAULT);
    }
});

export const ClippoQuickToggle = GObject.registerClass(
class ClippoQuickToggle extends SystemIndicator {
    _init(settings) {
        super._init();
        this._settings = settings;

        this._indicator = this._addIndicator();
        this._indicator.iconName = PRIVATE_ICON;

        this._toggle = new ClippoToggle(settings);
        this.quickSettingsItems.push(this._toggle);

        this._changedId = settings.connect('changed::private-mode', () => this._sync());
        this._sync();
    }

    _sync() {
        // Show the top-bar icon only while capture is paused.
        this._indicator.visible = this._settings.get_boolean('private-mode');
    }

    destroy() {
        if (this._changedId) {
            this._settings.disconnect(this._changedId);
            this._changedId = 0;
        }
        this._settings = null;
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems.length = 0;
        super.destroy();
    }
});
