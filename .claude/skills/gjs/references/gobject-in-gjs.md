# GObject in GJS: registerClass, properties, signals, interfaces, GType names

Summary: how to subclass GObjects (including St and Clutter widgets) with `GObject.registerClass`, declare properties and signals, and bind properties.
It also covers implementing interfaces, the Symbol-based static fields, and GType naming rules (with GNOME Shell's path-based names), plus vfunc overrides and signal-connection helpers.
Verified against gjs `doc/Mapping.md`, `doc/Overrides.md`, `modules/core/overrides/GObject.js` (master) and gnome-shell sources that use these patterns.

## Contents
1. registerClass forms
2. Construction: constructor vs _init
3. Properties
4. Signals
5. Interfaces and vfuncs
6. Symbol-based static fields and GTypeName
7. Connecting signals safely
8. Binding properties
9. Sources

## 1. registerClass forms
```js
// two-argument form (most Shell code)
export const Pill = GObject.registerClass({
    GTypeName: 'GuavaPill',                  // optional; see §6
    Properties: {/* … */},
    Signals: {/* … */},
}, class Pill extends St.Button {
    constructor(params = {}) { super({style_class: 'guava-pill', ...params}); }
});

// one-argument form
export const Plain = GObject.registerClass(class Plain extends GObject.Object {});

// static-block form (gnome-shell panel.js, runDialog.js)
export class Panel2 extends St.Widget {
    static { GObject.registerClass(this); }
}
```
Other metaInfo keys (`overrides/GObject.js`): `GTypeFlags`
(`GObject.TypeFlags.ABSTRACT`), `Implements: [Iface]`, `Requires` (for
interfaces), and the GTK-only `CssName`, `Template`, `Children` and
`InternalChildren` (prefs side only).

## 2. Construction
- Since gjs 1.72 use `constructor(params)` with `super(params)`. `_init()` with
  `super._init()` still works, and most Shell classes (QuickToggle,
  ModalDialog, PanelMenu.Button) use `_init`. **When subclassing a Shell class
  that uses `_init`, override `_init` too** and chain with `super._init(...)`.
  Shell code does that, for example `class DarkModeToggle extends QuickToggle { _init() { super._init({…}) } }`.
- 47+ (gjs 1.82): `new SomeGObject(arg)` accepts only one property-bag
  argument. For "new" C constructors with positional arguments, call the
  static `SomeType.new(a, b)`.
- Don't set GObject properties before `super()`. Plain JS fields are fine
  only after `super()`.

## 3. Properties
```js
Properties: {
    'corner-radius': GObject.ParamSpec.int('corner-radius', null, null,
        GObject.ParamFlags.READWRITE, 0, 64, 12),
    'material': GObject.ParamSpec.string('material', null, null,
        GObject.ParamFlags.READWRITE, 'glass'),
    'active': GObject.ParamSpec.boolean('active', null, null,
        GObject.ParamFlags.READWRITE | GObject.ParamFlags.EXPLICIT_NOTIFY, false),
    'source': GObject.ParamSpec.object('source', null, null,
        GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY, Clutter.Actor),
    'icon-name': GObject.ParamSpec.override('icon-name', St.Button),  // re-declare an inherited prop
},
```
- GJS ParamSpec helpers put **flags before the default** (the reverse of C).
  Nick and blurb can be `null` (the Shell does this).
- Helpers (complete list in gjs modules/core/overrides/GObject.js): `boolean`,
  `char`, `uchar`, `int`, `uint`, `long`, `ulong`, `int64`, `uint64`, `float`,
  `double`, `string`, `enum(name, nick, blurb, flags, EnumType, default)`,
  `flags(…, FlagsType, default)`, `object(…, Type)`, `boxed(…, Type)`,
  `jsobject(name, nick, blurb, flags)`, `param(…, ParamType)` and `override`.
  There is no `ParamSpec.variant` helper.
- **Never** put underscores in property names. JS access uses
  `obj.corner_radius`, `obj.cornerRadius` or `obj['corner-radius']`. camelCase
  works: the Shell reads its `'has-menu'` property as `this.hasMenu`
  (quickSettings.js).
- Without a getter/setter, GJS stores the value and emits `notify`. If you
  write a getter you must also write the setter, handle the default, and call
  `this.notify('corner-radius')` when the value changes. With
  `EXPLICIT_NOTIFY`, notify only on a real change (the Shell's
  `QuickSettingsItem` and BarLevel follow this).
- Property names are camelCase in constructor bags too:
  `new Foo({cornerRadius: 8})` and `{corner_radius: 8}` both work.

## 4. Signals
```js
Signals: {
    'item-activated': {param_types: [GObject.TYPE_STRING, GObject.TYPE_UINT]},
    'closed': {},
    'request': {flags: GObject.SignalFlags.RUN_LAST, return_type: GObject.TYPE_BOOLEAN,
                accumulator: GObject.AccumulatorType.TRUE_HANDLED},
},
// emit
this.emit('item-activated', id, index);
```
- Pass `param_types` as GTypes or constructors (`Clutter.Actor`, `Notification.$gtype`).
- For **non-GObject** JS classes, use the Shell's `Signals.EventEmitter`
  (`resource:///org/gnome/shell/misc/signals.js`). `Overview`,
  `PressureBarrier` and PopupMenu are EventEmitters. They support `connect`,
  `disconnect`, `emit`, `connectObject` and `disconnectObject`, but not
  `notify` or `bind_property`.

## 5. Interfaces and vfuncs
```js
const Model = GObject.registerClass({Implements: [Gio.ListModel]},
class Model extends GObject.Object {
    vfunc_get_item_type() { return GObject.Object.$gtype; }
    vfunc_get_n_items() { return this._items.length; }
    vfunc_get_item(i) { return this._items[i] ?? null; }
});
```
- Override virtual functions with `vfunc_<name>`, for example
  `vfunc_allocate(box)`, `vfunc_paint(node, ctx, flags)`,
  `vfunc_get_preferred_width(forHeight)` or `vfunc_key_press_event(event)`.
  Chain up with `super.vfunc_<name>(...)`.
- To replace a vfunc on an *existing* Shell class at runtime, use the Shell's
  `InjectionManager.overrideMethod(proto, 'vfunc_x', …)`, which hooks vfuncs
  correctly. Plain assignment does not.
- 51 (gjs 1.89+): interface methods are no longer static functions on the
  interface constructor. Chain up with
  `MyIface.prototype.method.call(this)`, not `MyIface.method(this)`.

## 6. Symbol-based static fields and GTypeName
`overrides/GObject.js` defines `GObject.GTypeName`, `GObject.GTypeFlags`,
`GObject.interfaces`, `GObject.properties`, `GObject.signals` and
`GObject.requires`. `registerClass` copies metaInfo into these symbols, so you
can also write:
```js
class Thing extends GObject.Object {
    static [GObject.GTypeName] = 'GuavaThing';
    static [GObject.properties] = {'n': GObject.ParamSpec.int('n', null, null, GObject.ParamFlags.READWRITE, 0, 10, 0)};
    static [GObject.signals] = {'changed': {}};
    static { GObject.registerClass(this); }
}
```
GType names:
- The default is `Gjs_<ClassName>`. GNOME Shell sets
  `GObject.gtypeNameBasedOnJSPath = true`, which makes the default
  `Gjs_<import path>_<ClassName>`, for example
  `Gjs_ui_messageTray_Notification`. Never set that flag yourself.
- A GType can be registered only once per process. Re-registering the same
  name throws. Modules load once per session, so this only bites when two
  extensions pick the same explicit `GTypeName`. Prefix them: Guava uses
  `GuavaBlurPaintSignal`.
- `Obj.$gtype` returns the GType. `instanceof` works against constructors.

## 7. Connecting signals safely
- `const id = obj.connect('sig', handler)` with `obj.disconnect(id)`, and
  `connect_after`.
- `obj.connect_object('sig', handler, lifetimeObj, flags)` is gjs core. It
  disconnects automatically when `lifetimeObj` is destroyed.
- Shell-only: `obj.connectObject('a', h1, 'b', h2, owner)` and
  `obj.disconnectObject(owner)` (signalTracker.js). This is the idiomatic
  choice in extensions. If `owner` is a destroyable actor, its connections
  are also dropped when it is destroyed.
- `GObject.signal_handlers_disconnect_by_func(obj, fn)` and
  `signal_handlers_block_by_func(...)` exist but are rarely needed.

## 8. Binding properties
```js
source.bind_property('checked', target, 'visible', GObject.BindingFlags.SYNC_CREATE);
const b = source.bind_property_full('value', target, 'opacity',
    GObject.BindingFlags.SYNC_CREATE,
    (_bind, v) => [true, Math.round(v * 255)], null);
// b.unbind() when you no longer need it, or destroy one side
settings.bind('key', widget, 'prop', Gio.SettingsBindFlags.DEFAULT);   // GSettings ↔ property
```
`bind_property_full` is a GJS override because the C version takes closures.

## 9. Sources
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/doc/Mapping.md
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/doc/Overrides.md (registerClass, ParamSpec, connect_object, gtypeNameBasedOnJSPath)
- https://gitlab.gnome.org/GNOME/gjs/-/blob/master/modules/core/overrides/GObject.js (Symbols, ParamSpec helpers)
- https://gjs.guide/guides/gobject/subclassing.html
- https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/misc/signalTracker.js
- gjs NEWS 1.81.1 (single property-bag constructor), 1.89.1 (Interface static methods)
