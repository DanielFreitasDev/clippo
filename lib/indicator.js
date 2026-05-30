// indicator.js
//
// Icon in the GNOME top bar. Clicking it opens the history popup anchored just
// below the icon (an alternative to the Super+V shortcut).

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

export const ClippoIndicator = GObject.registerClass(
class ClippoIndicator extends PanelMenu.Button {
    _init(onActivate) {
        // dontCreateMenu = true: we don't use the default menu; we open our own popup.
        super._init(0.0, 'Clippo', true);
        this._onActivate = onActivate;

        this.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        }));

        this.connect('button-press-event', (_actor, event) => {
            // Only the primary (left) button opens the popup; leave the others
            // alone instead of swallowing them.
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            if (this._onActivate)
                this._onActivate(this);
            return Clutter.EVENT_STOP;
        });
    }
});
