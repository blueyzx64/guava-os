# Setup Assistant

## What it does
A short first-run flow in the preferences window that sets the main choices. Registry id `onboarding`; it runs only while the `onboarding` key is `new`. Code: `features/onboarding/` (trigger and steps), `prefs/setupAssistant.js` (UI). Design reasons: [architecture/onboarding.md](../architecture/onboarding.md).

## Use
- About an idle moment after the first enable, in the normal user session (never over the overview or another modal), Guava opens its preferences once with the assistant. Get Started, Not Now, Escape or closing the window finish it.
- Steps: Welcome; Choose Your Look (Light, Dark or Auto, accent colour); Your Dock (position, size); The Menu Bar (logo); Window Buttons (side: right or left); Stage Manager (on or off); Privacy (clipboard history, notifications in the notch); You're All Set.
- Every control writes at once, so Not Now keeps the choices made so far and the macOS defaults for the rest.
- Run it again from Guava Settings, About, Setup Assistant, Run Again.

## Settings
`onboarding` (internal: `new`, `requested`, `shown`, `done`). Reset Everything leaves it alone, so a reset never reopens the assistant.

## Limits
- Light and Dark write GNOME's own `color-scheme`, as GNOME Settings does; Auto is Guava's `appearance-auto`.
