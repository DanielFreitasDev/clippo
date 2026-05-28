// indicator.js
//
// Ícone na barra superior do GNOME. Clicar nele abre o popup do histórico
// ancorado logo abaixo do ícone (alternativa ao atalho Super+V).

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

export const ClippoIndicator = GObject.registerClass(
class ClippoIndicator extends PanelMenu.Button {
    _init(onActivate) {
        // dontCreateMenu = true: não usamos o menu padrão; abrimos nosso popup.
        super._init(0.0, 'Clippo', true);
        this._onActivate = onActivate;

        this.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        }));

        this.connect('button-press-event', () => {
            if (this._onActivate)
                this._onActivate(this);
            return Clutter.EVENT_STOP;
        });
    }
});
