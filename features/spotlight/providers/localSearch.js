// SPDX-License-Identifier: GPL-3.0-or-later
// Files from LocalSearch (Tracker 3), for the "/" filters and the Files view. Async only: the
// connection, the statement run and every cursor step go through the main loop with the
// search's Cancellable. The query text comes from queryModel.js fileQuery(); the search words
// are bound parameters. Spotlight never indexes anything itself: when LocalSearch is not
// installed or not running, these results are simply missing.
//
// Shell API: none. gi://Tsparql (libtinysparql 3) is loaded on first use, so a system without
// it never fails to start Spotlight.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { displayFolder, fileQuery, fileScore } from '../queryModel.js';

const SERVICE = 'org.freedesktop.LocalSearch3';

function promise(start) {
    return new Promise((resolve, reject) => start((obj, res, finish) => {
        try {
            resolve(finish(res));
        } catch (e) {
            reject(e);
        }
    }));
}

export class LocalSearch {
    constructor() {
        this._conn = null;
        this._connecting = null;
        this._home = GLib.get_home_dir();
        this._reachable = null;
    }

    /** False once LocalSearch failed to answer (not installed, not running); null before. */
    get reachable() {
        return this._reachable;
    }

    /** Try again on the next search (Spotlight opened). */
    retry() {
        if (this._reachable === false)
            this._reachable = null;
    }

    /** Close the connection (feature disable). */
    close() {
        this._connecting = null;
        try {
            this._conn?.close();
        } catch (e) {
            // already gone
        }
        this._conn = null;
    }

    _connection(cancellable) {
        if (this._conn)
            return Promise.resolve(this._conn);
        this._connecting ??= (async () => {
            const { default: Tsparql } = await import('gi://Tsparql?version=3.0');
            const conn = await promise(done => Tsparql.SparqlConnection.bus_new_async(SERVICE, null,
                Gio.DBus.session, cancellable,
                (o, res) => done(o, res, r => Tsparql.SparqlConnection.bus_new_finish(r))));
            this._conn = conn;
            return conn;
        })().catch(e => {
            this._connecting = null;
            throw e;
        });
        return this._connecting;
    }

    /**
     * File rows, newest first.
     * @param {{text?:string, filter?:object, limit?:number}} opts
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<object[]>} Spotlight items (kind 'file')
     */
    async search(opts, cancellable) {
        try {
            const items = await this._search(opts, cancellable);
            this._reachable = true;
            return items;
        } catch (e) {
            if (!cancellable?.is_cancelled())
                this._reachable = false;
            throw e;
        }
    }

    async _search(opts, cancellable) {
        const conn = await this._connection(cancellable);
        const { sparql, bindings } = fileQuery(opts);
        const statement = conn.query_statement(sparql, cancellable);
        for (const [name, value] of Object.entries(bindings))
            statement.bind_string(name, value);
        const cursor = await promise(done => statement.execute_async(cancellable,
            (o, res) => done(o, res, r => o.execute_finish(r))));
        const items = [];
        try {
            while (await promise(done => cursor.next_async(cancellable, (o, res) => done(o, res, r => o.next_finish(r))))) {
                const uri = cursor.get_string(0)[0];
                const name = cursor.get_string(1)[0];
                const mime = cursor.get_string(2)[0] ?? 'application/octet-stream';
                if (!uri?.startsWith('file://') || !name)
                    continue;
                items.push(this._item(uri, name, mime, fileScore(name, opts.text ?? '', items.length)));
            }
        } finally {
            cursor.close();
        }
        return items;
    }

    _item(uri, name, mime, score) {
        return {
            id: `file:${uri}`,
            kind: 'file',
            group: 'documents',
            title: name,
            subtitle: displayFolder(uri, this._home),
            gicon: Gio.content_type_get_icon(mime),
            uri,
            mime,
            score,
        };
    }

    /** A file row from a stored recent result. */
    itemFor(recent) {
        return this._item(recent.uri, recent.title, recent.mime ?? 'application/octet-stream', 0);
    }
}
