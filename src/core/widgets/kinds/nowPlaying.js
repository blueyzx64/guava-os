// SPDX-License-Identifier: GPL-3.0-or-later
// Now Playing: the current MPRIS track with buttons that act in place (Sonoma interactive
// widgets): previous, play/pause, next.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import { mediaState } from '../data.js';
import { N_, box, icon, label, spacer } from './common.js';

function button(name, iconName, size, fn) {
    const b = new St.Button({
        style_class: 'guava-widget-button',
        accessible_name: name,
        can_focus: true,
        child: icon(iconName, size),
    });
    b.connect('clicked', fn);
    return b;
}

export default {
    id: 'now-playing',
    title: N_('Now Playing'),
    category: N_('Music'),
    sizes: ['small', 'medium'],
    defaultSize: 'medium',
    provider: 'media',

    build(view) {
        const _ = view._;
        const s = view.scale;
        const root = view.content;
        const small = view.size === 'small';
        const artSize = Math.round((small ? 64 : 138) * s);
        const art = new St.Bin({ style_class: 'guava-widget-artwork', width: artSize, height: artSize });
        let artUrl = null;
        // Local art is a background (rounded by CSS); remote art loads as a FileIcon through
        // GIO/GVfs, asynchronously; no art shows a note on a soft tile
        const setArt = url => {
            if (url === artUrl)
                return;
            artUrl = url;
            const local = typeof url === 'string' && url.startsWith('file://') && !/["\\]/.test(url);
            art.style = local ? `background-image: url("${url}"); background-size: cover;` : null;
            const remote = !local && typeof url === 'string' && /^https?:\/\//.test(url);
            art.set_child(local ? null : new St.Icon({
                gicon: remote ? new Gio.FileIcon({ file: Gio.File.new_for_uri(url) }) : null,
                icon_name: remote ? null : 'folder-music-symbolic',
                icon_size: remote ? artSize : Math.round(artSize * 0.45),
                style_class: 'guava-widget-art-icon',
            }));
        };
        const title = label('', 'guava-widget-headline');
        const artist = label('', 'guava-widget-body guava-widget-dim');
        const act = fn => () => {
            const p = view.provider;
            if (p)
                fn(p);
        };
        const glyph = Math.round((small ? 18 : 22) * s);
        const prev = button(_('Previous'), 'media-skip-backward-symbolic', glyph, act(p => p.previous()));
        const play = button(_('Play'), 'media-playback-start-symbolic', glyph, act(p => p.playPause()));
        const next = button(_('Next'), 'media-skip-forward-symbolic', glyph, act(p => p.next()));
        const controls = box('guava-widget-controls', false);
        if (!small)
            controls.add_child(prev);
        controls.add_child(play);
        if (!small)
            controls.add_child(next);

        const text = box('guava-widget-column', true, { x_expand: true });
        if (small) {
            const top = box('guava-widget-row', false, { x_expand: true });
            top.add_child(art);
            top.add_child(spacer());
            top.add_child(controls);
            controls.y_align = Clutter.ActorAlign.START;
            root.add_child(top);
            root.add_child(spacer());
            text.add_child(title);
            text.add_child(artist);
            root.add_child(text);
        } else {
            const row = box('guava-widget-row', false, { x_expand: true, y_expand: true });
            row.add_child(art);
            const right = box('guava-widget-column', true, { x_expand: true, y_expand: true });
            text.add_child(title);
            text.add_child(artist);
            right.add_child(text);
            right.add_child(spacer());
            right.add_child(controls);
            row.add_child(right);
            root.add_child(row);
        }

        return {
            update(d) {
                const m = mediaState(d?.player ?? null);
                title.text = m.has ? m.title || _('Unknown title') : _('Not Playing');
                artist.text = m.has ? m.artist || m.app : '';
                controls.visible = m.has;
                play.child.icon_name = m.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
                play.accessible_name = m.playing ? _('Pause') : _('Play');
                prev.reactive = m.canPrev;
                next.reactive = m.canNext;
                setArt(m.art || '');
            },
        };
    },

    open(view) {
        view.provider?.raise();
    },
};
