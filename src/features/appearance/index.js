// SPDX-License-Identifier: GPL-3.0-or-later
// Popup menu styling (key popup-menu-styling): accent hover and selection and tighter rows for
// every Shell menu. The rules in style.css reach stock Shell elements, so they hang off one
// class on the UI group (menus live there, not under the panel) and apply only while it is on.
// The GTK app fixes that share the key are imported by features/appButtons/gtkTheme.js.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const POPUP_CLASS = 'guava-popup-styled';

export class PopupMenuStyling {
    constructor(_ctx, cleanup) {
        this._cleanup = cleanup;
    }

    enable() {
        Main.uiGroup.add_style_class_name(POPUP_CLASS);
        this._cleanup.add(() => Main.uiGroup.remove_style_class_name(POPUP_CLASS));
    }

    disable() {
        // The cleanup registry, disposed right after this, removes the class
    }
}
