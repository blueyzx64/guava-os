# Guava feature design specs

Summary: implementer-ready spec for each planned macOS-inspired Guava feature: macOS reference
behaviour, Guava adaptation, states, sizes, motion and edge cases. Tokens come from SKILL.md, motion
recipes from motion-and-feedback.md, glass layers from liquid-glass.md. Sizes are logical px at 1x.

## Contents
1. Liquid Glass across the shell
2. Clipboard history (panel popover + Quick Paste)
3. Guava Search (Spotlight-style)
4. Island: notification notch and live activities
5. Stages (Stage Manager)
6. Control Center (Quick Settings grid)
7. Auto-hide top bar
8. Window controls in the top bar
9. Cross-feature rules

---

## 1. Liquid Glass across the shell

**macOS reference.** Tahoe applies Liquid Glass to the menu bar (transparent),
menus, Control Center, notifications, Spotlight and the Dock. Accessibility settings make it frostier or opaque.

**Guava adaptation.**
- One master toggle, `glass-enabled`.
- A per-surface list, `glass-surfaces`: `panel`, `menus`, `quick-settings`, `notifications`, `island`, `search`, `osd`, `dock` (existing dock-blur).
- Tiers in `glass-tier` (`auto|high|balanced|light|opaque`), plus `glass-reduce-transparency`.
- All surfaces use the shared `GlassSurface` (architecture lessons §10).
- The panel defaults to *transparent* with glyph shadows. "Show top bar background" switches it to regular glass.

**States:** off (stock theme), regular, clear (panel only, over the
wallpaper), opaque.

**Sizes:** radii come from the token table. Popover menus get 18px outer
radius and 6px padding, which reshapes GNOME `.popup-menu-content`.

**Motion:** tier changes crossfade over 180 ms. Don't animate blur radius.

**Edge cases:**
- Detect Blur my Shell or other blur extensions. If one is active on the same surface, skip Guava's blur for it and show a note in prefs.
- Keep the lock screen and unlock dialog opaque.
- Screenshot UI and screencast: leave them untouched.
- Non-Adwaita themes: derive the tint from the theme's popover colour.
- Fractional scaling: round blur widget geometry to whole device pixels.
- Multi-monitor: each monitor's panel or dock gets its own blur actor.

## 2. Clipboard history

**macOS reference.**
- Tahoe Spotlight has a Clipboard view (Cmd-Space, then Cmd-4): searchable recent copies, Clear History. An item is copied with its button or Cmd-C, then pasted with Cmd-V (Apple Support mchl40d5b86b). Retention (reported about 8 h) is **[unverified: Apple doesn't state it]**.
- Third-party managers add pins, search and a paste stack.

**Guava adaptation.** There are two entry points onto one `ClipboardService`.

- *Panel popover:* a status icon opens a menu-styled list. It is allowed as a popover because the content is rich.
- *Quick Paste:*
  - A shortcut (proposed Super+Shift+V) opens a Spotlight-style overlay near
    the pointer or caret. Fall back to the top-centre of the active monitor.
  - Typing filters the list. Return pastes into the previously focused window.
  - Shift+Return copies only.

Data model:
`{id, mime: text|image|uri|color, preview, bytesRef, sourceApp, time, pinned, sensitive}`.
- Capacity is `clipboard-size` (default 50, range 10–500).
- Retention is `clipboard-retention` (`session` default, or `8h`, `24h`, `7d`).
- Pinned items never expire. Persisted data lives in `$XDG_CACHE_HOME/guava/clipboard`, written only when retention ≠ session.

Capture and paste:
- **Capture:** `global.display.get_selection()` `owner-changed` for CLIPBOARD, then `St.Clipboard.get_default().get_content/get_text`.
- **Paste:** set the clipboard, restore focus to the target window, then after a 1-frame idle
  synthesize Ctrl+V with a Clutter virtual keyboard device (Ctrl+Shift+V in terminals, by WM_CLASS
  heuristics). If synthesis fails, show "Copied. Press Ctrl+V".

Sizes:
- Popover is 360 wide, max 480 tall.
- Rows are 44px with a 16px type glyph, 1-line preview, secondary-colour source and time, and a pin button on hover.
- Image rows are 64px with a 48px thumbnail.
- Quick Paste is 560 wide. Its search field is 44px with radius 22, and it shows up to 8 rows.
- "Clear" and "Pause capture" live in the footer.

States: empty ("Nothing copied yet"), paused (icon dimmed with a strike-through glyph), filtered with no match, private (lock screen or screencast: previews replaced by "Hidden").

Motion: Quick Paste uses the *standard* fade + translate. A row that is pasted flashes `fill-2` for 120 ms.

Edge cases:
- **Secrets:** skip entries whose mimetypes include `x-kde-passwordManagerHint` with value `secret` **[verify]**, and entries from an excluded-apps list (default: KeePassXC, Bitwarden, 1Password).
- Large images: thumbnails are capped at 256px. Originals are kept only up to `clipboard-image-max` (5 MB).
- Primary selection is ignored by default.
- Duplicate copies move the existing item to the top.
- Wayland focus: if the target window is gone, copy only.

## 3. Guava Search (Spotlight-style)

**macOS reference.**
- Cmd-Space opens a floating glass bar. Results are categorized with a top hit.
- Tahoe adds browse scopes (apps, files, actions, clipboard), actions with parameters through App Intents, and user-defined Quick Keys.

**Guava adaptation.**
- A modal overlay on the active monitor, opened with a configurable shortcut. Check for conflicts with input-source switching on Super+Space.
- The "Use overview search" fallback toggle opens GNOME's overview search instead.

Providers (from the registry):

| Provider | Source |
|---|---|
| Apps | `Shell.AppSystem` |
| GNOME remote providers | Reuse `remoteSearch.js` providers |
| Files | Via the LocalSearch/Tracker provider when present |
| Actions | Action registry |
| Calculator / units | Built in |
| Clipboard | ClipboardService |
| Settings panels | Built in |

- Scope chips: All · Apps · Files · Actions · Clipboard. Ctrl+1…5 switches scope (Ctrl, not Cmd).
- Quick Keys: users map 1–4 letter aliases to actions in prefs.

Sizes:
- The bar is 640 wide and sits 22 % from the top of the monitor.
- The field is 52px tall (capsule, radius 26), with title2 type and a 20px search glyph.
- Results:
  - Rows are 44px. The top hit is 64px with a 32px icon.
  - Section headers are caption weight 600, fg-secondary.
  - At most 8 rows are visible, and the list scrolls with a hard edge effect.
- The overall radius is 26 while collapsed. Once expanded it becomes 20 for the whole card, keeping the field concentric.

States: idle (field only, recent items optional), typing (live results within 50 ms; debounce remote providers by 150 ms), action parameter entry (token chip plus a second field), no results ("Search the web" action optional), error (provider timeout after 1 s; drop it silently).

Motion: open uses the *standard* fade + 8px drop. Results height animates over 180 ms through the clip, and is instant with reduced motion.

Edge cases: IME pre-edit must not trigger actions, RTL layout, very long file paths (ellipsize middle), the overview opening while search is open (close search first), multi-monitor (the monitor with the pointer).

## 4. Island: notification notch and live activities

**macOS reference.**
- Tahoe shows iPhone Live Activities in the menu bar, in compact, minimal and expanded presentations.
- iPhone's Dynamic Island morphs a black pill between those presentations.
- HIG rules:
  - Use it for events with a defined end, ≤ 8 h.
  - Text is medium weight or heavier.
  - Margins are concentric, and the limited-width fallback fits a 28pt
    circle.
  - Updates only on change, with animations ≤ 2 s.
  - No ads and no sensitive data.

**Guava adaptation.**
- A pill in the panel's centre box. It can take over the clock: setting `island-replaces-clock`, which shows the clock when idle.
- Style setting is `glass` (default) or `black`. Black matches the island look and suits transparent panels.

Providers:
- **Media** (MPRIS): artwork, then an equalizer glyph or elapsed time.
- **Timer / stopwatch**: Guava actions.
- **Screen recording**: red dot and elapsed time from the screenshot UI.
- **Downloads**: from the Downloads stack watcher.
- **Calls**: when a provider exposes them.
- **Banners**: notifications absorbed for 5 s.

| Presentation | Size | Content |
|---|---|---|
| Idle | auto × (panel h − 4), e.g. 24 | Clock (subhead weight 500), or hidden |
| Compact | 140–260 × 24, capsule | Leading 16–20px icon or art, trailing value (tabular digits) |
| Minimal (2nd activity) | 24 × 24 circle, 6px gap to the right of the pill | Icon or tiny progress ring |
| Banner | 360 × 64–96, radius 22 | App icon 32, headline title, 2-line body, up to 2 actions |
| Expanded | 380–420 × 84–160, radius 28 (concentric, 14 padding) | Title, primary value (title1), controls row of 28px hit targets |

Interaction: click to expand, click outside or Esc to collapse. Hovering for 600 ms shows a tooltip-style preview. Right-click opens a menu with "Hide this activity" and "Island settings".

Priority: active call > recording > timer ending < 1 min > media > downloads. The highest priority gets the compact slot, the next gets minimal, and the rest are reachable in the expanded view's pager.

Motion: compact ↔ expanded uses the *large* duration with a snappy spring (clone-scale and clip). Content fades in after 40 %. Banner absorption follows the recipe in motion §6. Reduced motion uses crossfades only.

Edge cases:
- **Fullscreen:** hide unless the activity is a call or an alarm.
- **Do Not Disturb:** no banners, but activities stay.
- **Lock screen:** show the compact view with details hidden.
- **Multi-monitor:** primary panel only.
- **Centre box occupied by another extension:** place the island before it and log once.
- **GNOME banners:** when absorption is on, suppress `Main.messageTray` banners for absorbed sources only. Never drop critical urgency.
- **Long titles:** marquee is off, so ellipsize.

## 5. Stages (Stage Manager)

**macOS reference.**
- The current window or group is centred, and recent stages show as thumbnails in a left strip.
- Drag a thumbnail onto the stage to group, and drag it out to ungroup.
- The strip auto-hides when windows overlap it and is revealed from the left edge. Toggle it from Control Center.

**Guava adaptation.**
- Per-workspace, per-monitor stages. A stage is an ordered set of `Meta.Window`s.
- A new window joins the active stage if it is transient or from the same app. Otherwise it creates a new stage (`stages-new-window`: `own-stage` | `join`).
- Switching hides the other stages' windows using Guava-tracked minimize, and marks them so Dash to Dock minimized previews and "Hide minimized windows" ignore them.
- On switch back, restore their stacking order.
- Toggle it from the Control Center tile and with a shortcut.

Sizes:
- The strip is 168px wide at the left of the work area with a 16px inset.
- Up to 6 stages are shown, scaled to fit monitor height.
- Thumbnails are 136 × ~96 (window clones, max 3 stacked with a 6px offset), with a 24px app icon badge at bottom-left and radius 12.
- The stage area is the work area minus the strip, and windows keep their sizes. Maximized windows are offered "fit beside strip" (setting).

States: strip visible, strip auto-hidden (any window intersects the strip rect), drag-over (target stage highlighted with accent ring), empty workspace (strip hidden).

Motion: switching uses the *large* duration with `EASE_OUT_EXPO`. The outgoing stage clones scale into their thumbnail and the incoming stage scales out of its thumbnail. The strip slides 24px and fades. Reduced motion uses a 200 ms crossfade.

Edge cases:
- **Fullscreen windows:** leave Stages and get their own workspace (existing feature).
- Always-on-top windows stay visible.
- Dialogs follow their parent.
- **Overview:** shows all windows normally.
- **Disable:** must unminimize every Guava-hidden window.
- **Workspaces:** with dynamic workspaces, a stage dies when its last window closes.

## 6. Control Center (Quick Settings grid)

**macOS reference.**
- A glass panel of modules (connectivity, Focus, display, sound, now playing, and more).
- Modules expand in place to show details.
- In Tahoe it is fully customizable: add, remove and resize, plus third-party controls.
- Controls show a symbol, title and value. The tint marks the on state.

**Guava adaptation.**
- Restyle and re-lay out GNOME Quick Settings (`Main.panel.statusArea.quickSettings`) rather than replacing its logic.
- Map items:
  - `QuickToggle` → 2×1
  - `QuickMenuToggle` → 2×1 with chevron, whose menu expands in place
  - `QuickSlider` → 4×1
  - Media → 4×2
  - Unknown third-party items → 2×1 in the "More" section
- The layout is stored as `cc-layout`: an array of `{id, w, h}` items.

Grid:
- 4 columns, 72px cells, 10px gaps and 12px padding, for 342px width.
- The radius is 26 outer and 14 for modules (concentric).
- A 1×1 module is a 44px circle with a 20px glyph, its title shown below in caption type.
- A 2×1 module is a 44px circle at the leading side, with title (callout 600) and value (caption, fg-secondary).

Module states:
- **off:** `fill-1`, fg-primary glyph
- **on:** circle `-st-accent-color`, glyph `-st-accent-fg-color`
- **busy:** a spinner replaces the glyph and the value reads "Connecting…"
- **unavailable:** 0.4 opacity, keeps its space
- **expanded:** the module grows to 4×N and the rest fade to 0.0

**Edit mode** opens from a footer "Edit Controls" button:
- Tiles jiggle-free (no wobble) with a remove "−" badge.
- An add sheet lists the hidden modules.
- Drag to reorder, with keyboard reorder through Alt+arrows.

Motion: open uses the *standard* duration. Module expand uses a clone-scale with a snappy spring over the *large* duration. A toggle colour change takes *short*. Reduced motion uses fades only.

Edge cases: GNOME version differences in QuickSettings internals (guard with feature detection), other extensions injecting items (never crash on an unknown class), the existing Guava features (username, notifications, calendar-right, DND button) placed as modules, keyboard grid navigation (accessibility §6), and the small-screen max height (80 % of the work area, then scroll).

## 7. Auto-hide top bar

**macOS reference.**
- The menu bar hides and slides down when the pointer reaches the top edge.
- Tahoe options: Always, On Desktop Only, In Full Screen Only, Never (Apple Support mchlad96d366). In Full Screen Only as default is **[unverified: secondary]**.

**Guava adaptation.**
- Setting `panel-autohide`: `never` | `fullscreen` (the existing hover feature) | `maximized` | `always`.
- Hidden means `translation_y = −panel height`. Struts are removed with `Main.layoutManager` chrome `affectsStruts: false`, so maximized windows use the full height.

Timing:
- **Reveal** happens when the pointer is in the top 1px and either a `Layout.PressureBarrier` threshold (100 px of pressure within 1 s) or a dwell of 200 ms is met.
- A **reveal zone** of 4px handles fractional or mis-scaled edges.
- **Hide** happens 600 ms after the pointer leaves the union of the panel, any open panel menu and a 6px margin.

Never hide while:
- a panel menu is open
- a modal or keyboard grab is active
- the overview is showing
- keyboard navigation focus is in the panel
- the island is expanded or a banner is showing
- a drag-and-drop is in progress

Motion: the *standard* reveal and *exit* hide recipes from motion §6. Reduced motion uses an opacity fade, or no motion at all when animations are off.

Edge cases:
- **Multi-monitor:** add one barrier per monitor top edge, and handle monitors stacked vertically (no barrier at shared edges).
- **Touch:** swipe down from the top reveals.
- **GTK4 fullscreen apps:** the hover issue noted in the README. Document it and prefer the pressure barrier.
- **Hot corner:** keep it working when the panel is hidden.
- **Screen sharing indicator:** force a brief reveal when sharing starts.

## 8. Window controls in the top bar

**macOS reference.**
- Close, minimize and zoom circles at the window's leading edge. Glyphs appear on group hover, and inactive windows show grey.
- The HIG says macOS never puts them in the menu bar. iPadOS does for full-screen apps. Guava follows that iPadOS precedent.

**Guava adaptation.**
- When the focused window is maximized (setting `show-window-controls`; `-fullscreen-only` exists), draw the controls at the panel's leading edge, before the window title (existing Show Window Title).
- Remove the window's titlebar using the existing hide-titlebar CSS.
- The `button-type` styles (default, alt, glass) apply to the panel copy as well.

Sizes:
- Circles are 12px, or 14px at the "large" size, with an 8px gap.
- Each circle has a 20×20 reactive area, and the group has 10px leading padding.
- They are vertically centred in the panel.

States:
- **focused:** colours from the theme files
- **group-hover:** glyphs shown
- **pressed:** −15 % lightness
- **window not focusable or no maximized window:** the group is hidden
- **action unavailable** (`!win.can_minimize()` / `!can_maximize()`): greyed but still present

Actions:
- Close calls `win.delete(global.get_current_time())`.
- Minimize calls `win.minimize()`.
- Zoom calls `win.unmaximize(Meta.MaximizeFlags.BOTH)`, restoring the window and bringing its titlebar back. Alt+click toggles fullscreen.
- Right-click or long-press opens the existing tiling menu.

Motion: glyph fade is *micro*. The group fades in or out over *short* when maximize state changes. Reduced motion keeps the same timing, because these are fades.

Edge cases:
- **CSD apps** (Electron, some KDE on Wayland): the titlebar can't be removed, so don't show panel controls for them, or the controls would be duplicated. Detect this with `win.decorated` / the client type.
- **Secondary monitors** have no panel, so keep the window's own titlebar.
- **RTL:** mirror to the right.
- **Dialogs:** transient windows never take over the panel controls.
- **Overview:** hide the group.

## 9. Cross-feature rules

- Only one Guava surface can be open at a time (HIG: one popover at a time). Opening one closes the others. A single click opens a sibling.
- All surfaces read tier, motion and scheme from the store, and none query settings directly.
- All new settings go in `schemas/org.gnome.shell.extensions.guava-os.gschema.xml` with translatable summaries. Prefs pages follow the GNOME HIG, not Apple's.
- Every feature must pass the SKILL.md review checklist and the accessibility test matrix.
- References: Apple HIG pages cited in macos-shell-patterns.md §13. GNOME APIs should be verified against gnome-shell 48–51 sources (`js/ui/panel.js`, `quickSettings.js`, `messageTray.js`, `layout.js`).
