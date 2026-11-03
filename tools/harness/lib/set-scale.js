// set-scale.js <scale>: give every monitor of the running Shell the scale closest to <scale> that
// Mutter supports for its mode, side by side left to right, the first one primary. Uses
// org.gnome.Mutter.DisplayConfig, as GNOME Settings does. Run with gjs inside the session.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const want = parseFloat(ARGV[0]);
const bus = Gio.DBus.session;
const call = (method, params, type) => bus.call_sync('org.gnome.Mutter.DisplayConfig',
    '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig', method, params,
    type ? new GLib.VariantType(type) : null, Gio.DBusCallFlags.NONE, -1, null);

const [serial, monitors] = call('GetCurrentState', null, '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})').deepUnpack();
let x = 0;
const logical = [];
monitors.forEach(([spec, modes], i) => {
    const mode = modes.find(m => m[6]['is-current']?.deepUnpack()) ?? modes[0];
    const [modeId, width, height, , , scales] = mode;
    const scale = scales.reduce((a, b) => Math.abs(b - want) < Math.abs(a - want) ? b : a, scales[0]);
    logical.push([x, 0, scale, 0, i === 0, [[spec[0], modeId, {}]]]);
    x += Math.round(width / scale);
    print(`${spec[0]} ${width}x${height} scale ${scale}`);
});
call('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [serial, 1, logical, {}]), null);
print('applied');
