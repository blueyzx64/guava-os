# How to write a Guava OS feature

> **Summary:** one folder `features/<name>/` with `index.js` (the Shell adapter class),
> `model.js` (pure logic, tested), `prefs.js` (preference groups) and `style.css` (Shell CSS).
> One entry in `features.js`. Everything the feature sets up goes into the `cleanup` registry it
> is given. Read and change the desktop through `ctx` (core services), never through another
> feature. Run `make check` and the real-Shell harness before you hand off.

Layout reference: `code-map.md`.

## 1. Folder

```
features/<name>/
  index.js     export class <Name> { constructor(ctx, cleanup); enable(); disable(); }
  model.js     pure functions/classes: no gi://, no resource:// (eslint enforces it)
  prefs.js     export function buildPrefs({settings, window, extension, _}) -> Adw.PreferencesGroup[]
  style.css    /* feature: <id> */ rules, every selector scoped by a guava- class
  <more>.js    view.js, shellAdapter.js, ... when index.js grows past ~400 lines
```

- Name the folder in camelCase after the feature (`stageManager`), the registry id in
  kebab-case (`stage-manager`), schema keys with the feature prefix (`sm-`, `dock-`, `menubar-`,
  `notch-`, `windows-`, `glass-`).
- A feature never imports another feature's files (`tests/architecture.test.js`). To use another
  feature, call `ctx.features.instance('<id>')` at the moment you need it (null while it is off)
  and listen to `'feature-changed'` on `ctx.events` to learn when it comes and goes.
- Shared, feature-free helpers go to `lib/`; shared desktop state and policies go to `core/`.

## 2. Register it (features.js)

```js
{
    id: 'dock', setting: 'dock',                    // or when: ctx => ...
    restartOn: ['dock-position'],                   // keys that need a full restart
    needs: [], conflictsWith: [],                   // shared resources, see below
    load: async () => (await import('./features/dock/index.js')).Dock,
},
```

- Always `load` (lazy): a feature that is off costs no parsing. Start order is list order; stop
  runs in reverse.
- `enable()`/`disable()` run only on state changes. Watch your own keys with
  `GuavaSettings.watch()`; use `restartOn` only when a key changes too much to apply live.
- Shared resources get a rule here, not an ordering trick: `conflictsWith` (the winner pauses
  the loser and keeps its saved value), `needs` (held off until the other runs). Write the rule
  in the comment at the top of `features.js`.

## 3. The adapter (index.js)

```js
export class Dock {
    constructor(ctx, cleanup) {        // no work here: no actors, signals or settings reads
        this._ctx = ctx;
        this._cleanup = cleanup;
    }

    enable() {
        const { settings, events, motion } = this._ctx;
        const ks = new GuavaSettings(settings);
        ks.attach(this._cleanup);
        const desktop = this._ctx.desktop.acquire(this._cleanup);
        const layout = this._ctx.layout.acquire(this._cleanup);
        this._edge = layout.claim(this._cleanup, { id: 'dock', edge: 'bottom', size: 72, reserve: 'strut', actor });
        events.on('app-focused', ({ appId }) => this._sync(), this._cleanup);
        this._cleanup.actor(actor);
        ...
    }

    disable() {
        // Everything is in the cleanup registry, disposed right after this returns
    }
}
```

Rules:
- **Exact mirror.** Every signal, timeout, idle, injection, actor, style class and file goes into
  `cleanup` at the moment it is created (`cleanup.connect / timeout / idle / inject / actor / add`).
  `disable()` is then usually empty. A Shell object you change (style, visibility, parent) gets
  its undo registered right away (`cleanup.add(() => ...)`, `keepHidden()`).
- **No sync IO, no waiting.** No sync file/D-Bus/subprocess calls in `enable()` or handlers; use
  async Gio with a `Gio.Cancellable` cancelled from `cleanup`. To wait for the Shell, use a signal
  or a bounded retry (`whenQuickSettingsReady`), never an unbounded poll or a fixed delay.
- **Hot paths allocate nothing.** No objects, arrays or closures per frame (`new-frame`,
  `position-changed`, paint, allocate). Prefer signals that fire per change, not per frame;
  set actor properties directly (`set_position`, `set_size`).
- **Private Shell API** (`_rightBox`, `_grid`, prototypes) only in the adapter, guarded with `?.`,
  with a comment naming the Shell file and the versions checked. Version differences go to
  `lib/compat.js`.
- **Logging:** `console.error/warn` with a `[Guava]` prefix, only for real failures.

## 4. Core services (ctx)

| Need | Use |
|---|---|
| windows, apps, focus, workspaces, monitors | `ctx.desktop.acquire(cleanup).model` + events `window-*`, `app-focused`, `workspaces-changed`, `monitors-changed` |
| a screen edge (menu bar, dock, strip, notch) or the usable area | `ctx.layout.acquire(cleanup)`, `claim()`, `workArea(monitor)`, event `work-area-changed` |
| any animation | `ctx.motion.ease()` / `spring()` with named durations, curves and springs, and an `owner` so `disable()` cancels it. Never read the animation or reduced-motion settings yourself |
| a GNOME setting Guava must change | `new SettingOwner(ctx.originals, gioSettings, key, {type, transform})`, released from `cleanup`; never write a GNOME key directly |
| a place in the top bar | `PanelLayout.claim(cleanup, {id, actor, box, anchor})`; hide a stock item with `PanelLayout.hide(cleanup, role)` |
| notifications / Do Not Disturb | `NotificationRouter` (`core/notificationRouter.js`) |
| why a window is hidden or moved | `WindowState` flags (`core/windowState.js`) |
| tell other features something | declare the event in `core/events.js` `EVENTS`, then `ctx.events.emit()` |

## 5. Pure model (model.js)

- Values in, values out; no Shell objects (pass plain descriptions, as `features/calendar/model.js`
  `isDndActor` does). Settings come in as a plain config object read by the adapter.
- Test it in `tests/<feature>Model.test.js` (`gjs -m`, the same `test()/eq()` style as the other
  tests). State machines get scenario tests; Stage Manager also gets fuzz tests.

## 6. Accessibility and motion rules

- Every `St.Button` has an `accessible_name` (or a text `label`); `tests/architecture.test.js`
  checks it. Icon-only toggles also need a tooltip or caption where the design allows.
- Every `St.Entry` has an `accessible_name` (a `hint_text` is not a name). Two-state buttons use
  `toggle_mode`/`checked` and the TOGGLE_BUTTON role, not a style class alone.
- Shared helpers are in `lib/a11y.js`: `name`, `control`, `toggle`, `dialog`, `setEnabled`,
  `focusGroup` (Ctrl+Alt+Tab entry for chrome such as the dock, notch and Stage Manager strip),
  `keyNavGroup` (Tab and arrow keys inside a popup) and `describeSelection` (the highlighted
  result of a list whose focus stays in a search field).
- A `ModalSurface` always passes `accessibleName`; it gets the DIALOG role, a key-navigation
  group and Esc to close. A popup that is not a modal handles Esc itself, on its root.
- A control that is hidden until hover (an auto-hiding dock, the Stage Manager strip) also
  reveals on keyboard focus inside it, and a disabled control is neither reactive nor focusable.
- Focus rings: any new focusable class gets a `:focus` rule (`styles/base.css` has the shared one).
- Animations go through `ctx.motion`, which applies the rules of `core/motionModel.js`:
  animations off -> no animation; reduced motion (`org.gnome.desktop.a11y.interface
  reduced-motion` on GNOME 50) -> no movement, scaling or springs, only a short crossfade.
- High contrast: solid surfaces (Glass does it); keep text at 4.5:1.

## 7. CSS (style.css)

- Start with `/* feature: <id> */`. Scope every rule by a `guava-` class the feature adds (to its
  own actors, or to a stock actor while it runs). Never style stock classes unscoped.
- No GType selectors (they depend on file paths). Avoid `!important` except against inline
  styles of other extensions.
- After editing, run `make css` and commit the regenerated `stylesheet.css` (CI runs
  `make css-check`). Rules for `lib/` services live in `styles/base.css`.

## 8. Preferences (prefs.js)

- `buildPrefs({settings, window, extension, _})` returns groups; build rows with
  `prefs/widgets.js` (`switchRow`, `comboRow`, `shortcutRow`, `linkRow`, `watchKey`).
- Place the groups on a page in `prefs/pages/`: a one-feature page is a `featurePage(...)` line
  in `prefs/pages/index.js`; a page that combines features gets its own module there.
- Prefs run in their own process: Adw/Gtk only, never Shell modules (eslint enforces it).
  Disconnect every settings handler when its widget is destroyed (`watchKey` does).

## 9. Settings

- Add keys in the feature's group of the schema, with a summary and a description. Defaults
  follow macOS; every behaviour stays toggleable.
- A key whose feature is dropped is removed with it; a renamed key is a new key.
- Writing outside the extension (user files) is a last resort: Guava-marked content only, async
  Gio through `lib/fileOps.js` and its `enqueueUserFileJob` queue, never delete what Guava
  did not create.

## 10. Tests and the harness scenario

1. `make check` (lint, schema, css-check, unit tests) and `make pack-check`.
2. Real Shell: `GUAVA_SRC=$PWD tools/harness/run-f44.sh 20` must end with `Guava errors: 0`.
3. Add a scenario for the feature in a `GUAVA_EXTRA` script (`tools/harness/README.md`):
   reach the instance with `inst('<id>')`, drive it with `P`, assert with `T name js` returning
   "PASS ..." or "FAIL ...", and take `SHOT name` screenshots of every state you changed.
   Never commit screenshots.
4. New source folders go into `--extra-source` in `.github/workflows/pack-release.yml` and the
   Makefile `EXTRA`.
