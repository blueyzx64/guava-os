// SPDX-License-Identifier: GPL-3.0-or-later
// Centred dialogs, macOS style: every Shell modal dialog (authentication, log out / restart /
// shut down, Run a Command, and other extensions' ModalDialogs) opens as a faux glass card
// with an icon on top and its buttons at the right, the default one in the accent colour.
// Theme only: the dialogs' own logic, keys and buttons are untouched.
//
// Each open dialog is "dressed" when it opens and undressed when it closes, or on disable
// (which also restores any dialog open at that moment). Dialogs that are kept between opens
// (end session, Run) are dressed again on their next open.
//
// Shell API: ModalDialog.prototype.open (js/ui/modalDialog.js), dialogLayout._dialog (the
// `.modal-dialog` box of js/ui/dialog.js Dialog), contentLayout, buttonLayout and its
// Clutter.BoxLayout; EndSessionDialog._type. Checked against 48.0, 49.0, 50.0 and main.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import { CleanupRegistry } from '../../lib/disposables.js';
import { Glass } from '../../lib/glass.js';
import { dialogIcon, dialogKind } from './model.js';

const ICON_SIZE = 56;

export class Dialogs {
    constructor(ctx, cleanup) {
        this._ctx = ctx;
        this._cleanup = cleanup;
        this._dressed = new Map();     // ModalDialog -> CleanupRegistry
    }

    enable() {
        const self = this;
        this._cleanup.add(() => {
            for (const reg of [...this._dressed.values()])
                reg.dispose();
            this._dressed.clear();
        });
        this._cleanup.inject(ModalDialog.ModalDialog.prototype, 'open', function (orig, ...args) {
            const opened = orig.apply(this, args);
            if (opened) {
                try {
                    self._dress(this);
                } catch (e) {
                    console.error('[Guava] could not restyle a dialog:', e);
                }
            }
            return opened;
        });
    }

    disable() {
        // Everything is in the cleanup registry
    }

    _dress(dialog) {
        const card = dialog.dialogLayout?._dialog;
        if (!card || this._dressed.has(dialog))
            return;
        const reg = new CleanupRegistry();
        this._dressed.set(dialog, reg);
        reg.add(() => this._dressed.delete(dialog));
        const undress = () => reg.dispose();
        reg.connect(dialog, 'closed', undress);
        reg.connect(dialog, 'destroy', undress);

        card.add_style_class_name('guava-dialog');
        reg.add(() => card.remove_style_class_name('guava-dialog'));

        // The card draws no outer shadow (lib/glass.js): a host with its rect sits behind it
        const shadow = new St.Widget({ style_class: 'guava-dialog-shadow' });
        shadow.add_constraint(new Clutter.BindConstraint({ source: card, coordinate: Clutter.BindCoordinate.ALL }));
        dialog.dialogLayout.insert_child_below(shadow, card);
        reg.actor(shadow);
        // The Shell paints its dialogs dark in both styles: the colour scheme decides, not the card's text
        const isDark = () => St.Settings.get().color_scheme !== St.SystemColorScheme.PREFER_LIGHT;
        const glass = Glass.attach(card, { surface: 'overlays', role: 'content', shadow, isDark });
        reg.add(() => glass.destroy());

        const iconName = dialogIcon(dialogKind(card.style_class), dialog._type ?? null);
        if (iconName && dialog.contentLayout) {
            const icon = new St.Icon({
                icon_name: iconName, icon_size: ICON_SIZE,
                style_class: 'guava-dialog-icon', x_align: Clutter.ActorAlign.CENTER,
            });
            dialog.contentLayout.insert_child_at_index(icon, 0);
            reg.actor(icon);
        }

        // Buttons at their natural width, at the right, like an NSAlert
        const buttons = dialog.buttonLayout;
        const layout = buttons?.layout_manager;
        if (layout instanceof Clutter.BoxLayout) {
            const { homogeneous } = layout;
            const xAlign = buttons.x_align;
            layout.homogeneous = false;
            buttons.x_align = Clutter.ActorAlign.END;
            reg.add(() => {
                layout.homogeneous = homogeneous;
                buttons.x_align = xAlign;
            });
        }
    }
}
