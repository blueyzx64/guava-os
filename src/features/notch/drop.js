// SPDX-License-Identifier: GPL-3.0-or-later
// Dropping files from apps onto the notch (Wayland, GNOME 50).
//
// The mechanism, measured in the real Shell (docs/features/notch.md, "File shelf"): a drag
// that starts in a Wayland client is not delivered to Shell actors (no Clutter DnD events,
// and the client gets no drop target, so it sees the drop as cancelled). But Mutter does
// share two things with the compositor while any drag runs:
//   - Meta.Dnd (global.backend.get_dnd(), the object the Shell's xdndHandler.js uses) emits
//     'dnd-enter', 'dnd-position-change' (x, y) on every pointer move, and 'dnd-leave' when
//     the drag ends;
//   - the dragged data is the DND selection (Meta.SelectionType.SELECTION_DND): its mimetypes
//     are readable and Meta.Selection.transfer_async() returns the bytes, like the clipboard.
// At the release the DND selection is dropped before 'dnd-leave', so the file links are read
// as soon as the drag reaches the notch, and kept if the drag ends there.
//
// Idle cost: three signal handlers; work happens only during a drag.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import { DROP_FILE_TYPES, inDropZone } from './model.js';

/**
 * @param {CleanupRegistry} cleanup
 * @param {{zone: () => {x: number, y: number, w: number, h: number}|null,
 *   onOver: (over: boolean) => void, onDrop: (uris: string[]) => void}} target
 */
export function watchDrops(cleanup, target) {
    const dnd = global.backend?.get_dnd?.();
    const selection = global.display.get_selection();
    if (!dnd || !selection)
        return;
    const cancellable = new Gio.Cancellable();
    cleanup.add(() => cancellable.cancel());

    let drag = null;   // {over, uris: string[]|null, reading, dropped}
    let zone = null;   // the drop zone, measured once per change of the notch's shape

    const read = () => {
        const offered = selection.get_mimetypes(Meta.SelectionType.SELECTION_DND) ?? [];
        const pick = DROP_FILE_TYPES.find(([mime]) => offered.includes(mime));
        if (!pick || drag.reading)
            return;
        const [mime, parse] = pick;
        const current = drag;
        current.reading = true;
        const out = Gio.MemoryOutputStream.new_resizable();
        selection.transfer_async(Meta.SelectionType.SELECTION_DND, mime, -1, out, cancellable, (s, res) => {
            try {
                s.transfer_finish(res);
                out.close(null);
                const bytes = out.steal_as_bytes();
                current.uris = parse(new TextDecoder().decode(bytes.toArray()));
                // Released on the notch before the read finished
                if (current.dropped && current.uris.length)
                    target.onDrop(current.uris);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`[Guava] notch: could not read the dragged files: ${e.message}`);
            }
        });
    };

    const setOver = over => {
        if (drag.over === over)
            return;
        drag.over = over;
        zone = null; // the notch is about to open or close
        if (over && drag.uris === null)
            read();
        target.onOver(over);
    };

    cleanup.connect(dnd, 'dnd-enter', () => {
        drag = { over: false, uris: null, reading: false, dropped: false };
        zone = null;
    });
    cleanup.connect(dnd, 'dnd-position-change', (_d, x, y) => {
        drag ??= { over: false, uris: null, reading: false, dropped: false };
        zone ??= target.zone();
        setOver(inDropZone(zone, x, y));
    });
    cleanup.connect(dnd, 'dnd-leave', () => {
        const done = drag;
        drag = null;
        if (!done?.over)
            return;
        target.onOver(false);
        // The links normally arrived during the hover; a fast drop finishes in read()
        done.dropped = true;
        if (done.uris?.length)
            target.onDrop(done.uris);
    });
    cleanup.add(() => {
        drag = null;
    });
}
