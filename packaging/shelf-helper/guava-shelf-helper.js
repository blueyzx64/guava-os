#!/usr/bin/gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later
// Guava shelf helper. A GNOME Shell extension cannot start a Wayland drag, so while the notch
// shelf is open Guava runs this program. It owns one transparent, undecorated window that Guava
// moves exactly over the shelf's items (a Shell extension may place windows). The user's press
// lands on this window, and a GtkDragSource starts a real drag carrying text/uri-list.
//
// Protocol: one JSON object per line.
//   stdin   {"type":"layout","w":W,"h":H,"items":[{"uri":"file:///x","icon":"text-x-generic","x":0,"y":0,"w":90,"h":70}]}
//             The window's size and each item's box inside it. An empty list closes the window.
//           {"type":"quit"}   Closing stdin quits as well, so the helper never outlives Guava.
//   stdout  {"event":"click","uri":U}              the item was pressed and released, no drag
//           {"event":"drag","state":"begin"|"end","uri":U,"ok":bool}
//           {"event":"hover","value":bool}         the pointer is over the window
// The window has the title TITLE and the app id APP_ID; Guava finds it by those.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix?version=2.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const APP_ID = 'org.guava.ShelfHelper';
const TITLE = 'Guava Shelf';
const ICON_SIZE = 48;
// Not fully transparent: GTK never maps a window that paints nothing at all, so the window
// keeps a 1 % tint (Guava hides the window's actor in the Shell anyway).
const CSS = `
window.guava-shelf { background: rgba(0, 0, 0, 0.01); }
.guava-shelf-item { background: transparent; }`;

const out = new GioUnix.OutputStream({ fd: 1, close_fd: false });
const emit = obj => {
    try {
        out.write_all(`${JSON.stringify(obj)}\n`, null);
    } catch (_e) {
        app.quit();   // Guava is gone
    }
};

const app = new Gtk.Application({ application_id: APP_ID, flags: Gio.ApplicationFlags.NON_UNIQUE });
let window = null;
let dragging = false;

function uriList(uri) {
    return Gdk.ContentProvider.new_for_bytes('text/uri-list', new GLib.Bytes(new TextEncoder().encode(`${uri}\r\n`)));
}

function dragIcon(source, drag, iconName) {
    try {
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        const icon = Gio.Icon.new_for_string(iconName || 'text-x-generic');
        const paintable = theme.lookup_icon(icon, null, ICON_SIZE, 1, Gtk.TextDirection.NONE, 0);
        Gtk.DragIcon.set_from_paintable(drag, paintable, ICON_SIZE / 2, ICON_SIZE / 2);
    } catch (_e) {
        // The default drag icon is fine
    }
}

function addItem(fixed, item) {
    const box = new Gtk.Box({ width_request: item.w, height_request: item.h });
    box.add_css_class('guava-shelf-item');
    const source = new Gtk.DragSource({ actions: Gdk.DragAction.COPY });
    source.connect('prepare', () => uriList(item.uri));
    source.connect('drag-begin', (_s, drag) => {
        dragging = true;
        dragIcon(source, drag, item.icon);
        emit({ event: 'drag', state: 'begin', uri: item.uri, ok: true });
    });
    source.connect('drag-end', (_s, _drag, deleteData) => {
        dragging = false;
        emit({ event: 'drag', state: 'end', uri: item.uri, ok: !deleteData });
    });
    source.connect('drag-cancel', () => false);
    box.add_controller(source);
    const click = new Gtk.GestureClick({ button: Gdk.BUTTON_PRIMARY });
    click.connect('released', () => emit({ event: 'click', uri: item.uri }));
    box.add_controller(click);
    fixed.put(box, item.x, item.y);
}

function layout(msg) {
    const items = Array.isArray(msg.items) ? msg.items : [];
    if (!items.length) {
        window?.destroy();
        window = null;
        return;
    }
    const fixed = new Gtk.Fixed();
    items.forEach(item => addItem(fixed, item));
    if (!window) {
        window = new Gtk.Window({ application: app, title: TITLE, decorated: false, resizable: false });
        window.add_css_class('guava-shelf');
        const motion = new Gtk.EventControllerMotion();
        motion.connect('enter', () => emit({ event: 'hover', value: true }));
        motion.connect('leave', () => {
            if (!dragging)
                emit({ event: 'hover', value: false });
        });
        window.add_controller(motion);
        window.connect('destroy', () => {
            window = null;
        });
    }
    window.set_default_size(msg.w, msg.h);
    window.set_child(fixed);
    window.present();
}

function handle(line) {
    let msg;
    try {
        msg = JSON.parse(line);
    } catch (_e) {
        return;
    }
    if (msg.type === 'layout')
        layout(msg);
    else if (msg.type === 'quit')
        app.quit();
}

function readLines(stream) {
    stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
        let line = null;
        try {
            [line] = s.read_line_finish_utf8(res);
        } catch (_e) {
            line = null;
        }
        if (line === null) {
            app.quit();
            return;
        }
        handle(line);
        readLines(s);
    });
}

app.connect('startup', () => {
    const css = new Gtk.CssProvider();
    css.load_from_string(CSS);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
});
app.connect('activate', () => {
    app.hold();
    readLines(new Gio.DataInputStream({ base_stream: new GioUnix.InputStream({ fd: 0, close_fd: false }) }));
    emit({ event: 'ready' });
});
app.run([]);
