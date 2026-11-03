import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {startTrace} from './startupTrace.js';
const XML = `<node><interface name="org.x2.Probe"><method name="Eval"><arg type="s" direction="in"/><arg type="s" direction="out"/></method></interface></node>`;
const AF = Object.getPrototypeOf(async function () {}).constructor;
export default class P extends Extension {
    enable() {
        // Login perf trace (startupTrace.js): once per Shell process, from the first enable
        try { startTrace(); } catch (e) { logError(e, 'x2 startup trace'); }
        this._impl = Gio.DBusExportedObject.wrapJSObject(XML, this);
        this._impl.export(Gio.DBus.session, '/org/x2/Probe');
        this._own = Gio.bus_own_name_on_connection(Gio.DBus.session, 'org.x2.Probe', 0, null, null);
    }
    disable() { this._impl?.unexport(); Gio.bus_unown_name(this._own); }
    EvalAsync(params, inv) {
        const [code] = params;
        const f = new AF('Main', 'Gio', 'GLib', 'St', 'Clutter', 'Shell', 'Meta', 'global', code);
        f(Main, Gio, GLib, St, Clutter, Shell, Meta, global).then(r => {
            inv.return_value(new GLib.Variant('(s)', [JSON.stringify(r) ?? 'undefined']));
        }).catch(e => inv.return_value(new GLib.Variant('(s)', ['ERR ' + e + '\n' + e.stack])));
    }
}
