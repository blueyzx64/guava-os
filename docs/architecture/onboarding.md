# Setup Assistant (onboarding): where it runs and why

Code: `features/onboarding/` (the Shell trigger and the declarative steps),
`prefs/setupAssistant.js` (the UI), the `onboarding` key.

## Decision: a flow in the preferences window, not a glass modal in the Shell

| | Prefs-window flow (chosen) | Glass modal in the Shell |
|---|---|---|
| EGO review | Ordinary prefs code; the Shell only calls `openPreferences()` once | A modal grab at login from an extension is what reviewers reject ("no windows or popups on every login"); one bug blocks the whole session |
| Widgets | libadwaita: toggle groups, sliders, switches, carousel, dialogs, with keyboard and screen-reader support built in | Hand-built St actors for every control, with focus, a11y and RTL to redo |
| Settings | Writes GSettings directly, the same rows as the rest of prefs | The same, but every control is new code |
| Safety | A crash takes down the prefs process only | A crash takes down the Shell (Wayland: the session) |
| Look | libadwaita cards, not faux glass | Matches Guava's glass |
| Live preview | The Shell applies each choice while the dialog is open (the dock moves as you pick a side) | Same |

The glass look is the only loss.

## Flow
1. `onboarding` is `'new'` after the first enable. `features.js` runs the `onboarding` feature
   only then.
2. After an idle, the feature asks `model.offerDecision`: only the normal
   user session (never `initial-setup`); while the overview (GNOME starts in it) or another
   modal (GNOME's welcome dialog) is up, it asks again when the overview closes or a window
   gets the focus. Then it sets `'requested'` and calls `openPreferences()`. If the prefs
   process fails to start, the key stays `'requested'` and the assistant shows the next time
   Guava Settings opens.
3. `prefs.js` sees `'requested'` and presents the assistant as an `Adw.Dialog` when the window
   maps; the key becomes `'shown'`, then `'done'` when the dialog closes (Get Started, Not Now,
   Escape or closing the window). The feature stops as soon as the key leaves `'new'`.
4. **Re-run:** Guava Settings > About > Setup Assistant > Run Again…
5. "Reset Everything" leaves the key alone (it is internal), so a reset never re-opens it.

## Steps
Welcome; Choose Your Look (Light / Dark / Auto, accent); Your Dock (position, size); The Menu
Bar (logo); Window Buttons (side right/left); Stage Manager on/off; Privacy (clipboard
history, notifications in the notch, with what they keep and show); You're All Set. Each step
is data in `features/onboarding/model.js` `STEPS`; `tests/onboardingModel.test.js` checks every
key, type and value against the schema.

Every control writes at once, like macOS, so Not Now keeps the choices made so far and the
macOS defaults for the rest. Light and Dark write GNOME's `color-scheme` (the user choosing it,
as in GNOME Settings; Guava does not own it, so nothing is saved for restore); Auto is Guava's
`appearance-auto`, which owns `color-scheme` through `core/originals`.
