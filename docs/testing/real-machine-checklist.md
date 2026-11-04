# Real-machine checklist

> **Summary:** everything that can be tested without your hardware has been tested in a real
> GNOME Shell 50.6 on Fedora 44 packages (the harness, `tools/harness/`). This page lists what is
> left: the things only your GPU, your monitors, your accounts, your apps and your eyes can check.
> Each item says what to do, what you should see, and what to send back if it is wrong.

## 1. What was verified here

The harness runs the real Shell headless, with software rendering (llvmpipe), on virtual monitors.

| Check | Result |
|---|---|
| Unit tests (`make check`: lint, strict schema, generated CSS, import and settings-key check, 95 test files) | all pass |
| The installable zip (`make pack-check`, built in Fedora 44) | 512 files, every source file present, nothing extra |
| Real Shell, every scenario (`tools/scenarios/run-all.sh`, 40 scenarios) | 0 Guava errors, 0 failed asserts |
| Enable / disable cycles, all features on | 0 Guava errors, 8/8 probes |
| Two monitors; one monitor at 1.25×; one at 2× (2560×1600) | probes and the 15 chrome scenarios pass on each |
| A real X11 app (xterm under Xwayland) | minimize, restore, maximize, tiling, full screen, close, app menu: 10/10; its Mutter-drawn green button enters full screen like a GTK app's |
| Lock and unlock (the harness drives the session mode; see §3) | 0 Guava errors; nothing of Guava visible or reactive while locked |
| Preferences window | opens in under 1 s (cold 0.77 s), every page builds, no blank rows |
| Performance and the 250 ms response rule | see §4 |

"Guava errors" counts JS errors and CRITICALs with a Guava frame in the Shell log and in the
preferences process, including errors whose stack follows a blank line.

## 2. What only your machine can check

Before you start: turn the old Kiwi extension off (both take over the same parts of the Shell),
then `make install`, log out and back in, `gnome-extensions enable guava-os@blueyzx64`.
If anything below is wrong, send the output of:

```sh
journalctl --user -b -o cat /usr/bin/gnome-shell | grep -i -A12 'guava\|JS ERROR' > guava-log.txt
```

plus a screenshot or a short screen recording (Ctrl+Shift+Alt+R).

### 2.1 Look and sharpness (your GPU, your displays)
- [ ] **Frosted blur (default, Liquid Glass off):** menu bar, Control Center, notch, dock and menus show a
      plain blur of what is behind them under a flat neutral fill, over your wallpaper and over windows;
      no sheen, rim or boosted colour. Text stays readable in Light and Dark. Move a window under the
      dock: the blur follows, with no squares, ghosts or darkening over time. Reduce Transparency
      makes them opaque.
- [ ] **Liquid Glass (Settings > Appearance, on):** the same surfaces gain the colour boost, the
      tint gradient with a sheen, the rim and the wallpaper tint, exactly as before.
- [ ] **Sharpness at your scale:** text, icons, the dock (also magnified), the big pointer
      (shake the mouse) and the Genie are crisp at your monitor's native resolution and scale
      (especially fractional scales like 125% / 150%). Nothing should look soft or stretched.
- [ ] **Heavier text** (Font Smoothing, on by default): after logging out and back in, text in
      GTK3 and GTK4 apps looks slightly bolder, macOS-like. The setting writes
      `~/.config/environment.d/60-guava-freetype.conf`.

### 2.2 Smoothness on your hardware
- [ ] The Genie for every minimize, also right after entering full screen (during the slide to its
      own Space) and when the dock brings back a window from another Space: always the Genie, at
      the same speed, never a plain scale or a window that just vanishes.
- [ ] Mission Control, Launchpad, the Genie, tiling snaps, the Stage Manager strip and the notch
      animate smoothly, and a second input mid-animation turns them around smoothly (no snap).
- [ ] Under heavy load (a big build), decorative work backs off first: the live glass refreshes
      less often and dock magnification stops; the Genie stays the Genie. Window management,
      the dock and the menu bar stay responsive.

### 2.3 Lock screen (your account)
- [ ] Lock (Super+L): the Tahoe clock, your photo and name, the "Enter Password" capsule.
- [ ] A wrong password shakes; a correct one unlocks. If you use a fingerprint reader or smart
      card, those prompts still work.
- [ ] With "Show password hint" on, the hint shows after real wrong attempts only.
- [ ] Sleep, Restart and Shut Down (when you turn them on) work; Restart and Shut Down ask twice.
- [ ] On several monitors the lock UI is centred on the primary one.

### 2.4 Your apps
- [ ] App menus in the menu bar for your apps. Expected today: GTK apps with a menu bar, Xwayland
      apps (Electron/Chromium if you use the "use X11" helper in Preferences > Menu Bar), and the
      generic File / Edit / Window / Help menus with real commands for everything else. Qt apps on
      native Wayland and Firefox show the generic menus (see §3).
- [ ] The Flatpak helper (Preferences > Menu Bar) for a Qt or Electron Flatpak you use.

### 2.5 Hardware the harness cannot fake
- [ ] Touchpad gestures: 4-finger down (App Exposé), pinch (Launchpad), spread (Show Desktop).
- [ ] Real devices in the notch and Control Center: Bluetooth headphones, battery and charging,
      volume and brightness keys, media players, downloads from your browser.
- [ ] Plug and unplug a monitor while Guava runs (and while locked): dock, menu bar, notch and
      Stage Manager move to the right places.

## 3. Known limitations (and why)

| What | Why |
|---|---|
| Qt apps on native Wayland get no app menu in the menu bar | Measured: Qt 6 on Wayland never offers its menu to anyone on GNOME (no KDE protocol in Mutter). Generic menus instead. |
| Firefox's and libadwaita's ☰ menus are not in the menu bar yet | Their only route is the accessibility bus. Guava turns it on (your choice), but the providers that read it stay off until they prove stable; the harness could not read Text Editor's popover. |
| A double-click right next to the window buttons goes full screen | It cannot be told apart from a click on the green button (documented trade-off). |
| With "Workspaces span displays" on, a full-screen window on a second monitor moves the whole workspace | Mutter has one workspace set for all monitors in that mode; GNOME's default (workspaces on the primary only) is handled. |
| A menu straddling two monitors with different scales re-captures its blur every frame | Costs performance only, and only in that layout; the fix is risky. |
| The login overview zoom still starts before Guava loads | GNOME starts it before extensions are enabled; Guava hides it as soon as it runs. |
| The preferences process logs "JS callback during shutdown" when it exits | GJS noise when widgets are destroyed at exit; no effect on use. |
| Uninstalling Guava while Font Smoothing is on leaves `~/.config/environment.d/60-guava-freetype.conf` | GNOME gives extensions no uninstall hook. Turn the option off first, or delete the file. |
| The harness has no real lock dialog, GPU or touchpad | It drives the session mode instead of GDM, renders in software, and cannot generate gestures: §2 covers those. |

## 4. Performance

Measured with `tools/scenarios/run-perf.sh` on software rendering (llvmpipe), against a stock
GNOME login in the same run, with every optional feature on (Liquid Glass included: the worst
case, not the frosted default). Absolute times on your GPU will be lower; what matters is the
comparison with stock GNOME and the 250 ms response rule. The suite runs twice: with a warm
shader cache (`$X2/mesa-seed`, for both logins: what every login after your first one is like)
and cold (`GUAVA_COLD=1`: the first login after installing). Single runs vary by tens of ms.

**Response time (input → first visible frame, slowest 5%; limit 250 ms), final run (wave 5):**

| Action | Guava warm | Guava cold | Stock GNOME |
|---|---|---|---|
| Notch hover | 76 ms | 80 ms | — |
| Dock click | 120 ms | 82 ms | — |
| Window drag start | 100 ms | 66 ms | 63 ms |
| App menu in the menu bar | 132 ms | 83 ms | — |
| Control Center | 146 ms | 170 ms | 64 ms |
| App switcher (Super+Tab) | 179 ms | 131 ms | 192–194 ms |
| Launchpad | 183 ms | 186 ms | — |
| Spotlight (Super tap) | 205 ms | 132 ms | 56–65 ms |
| Notification Center (clock) | **304 ms** | 243 ms | 142–145 ms |
| Mission Control, first open | 179 ms | **267 ms** | — |

Before this wave, the first Mission Control open took 308–349 ms. It is now painted once,
invisibly, while you are idle after login (features/missionControl/warm.js).

**Login (ready, ms after start):** warm 2059 against a limit of 2207 (pass); cold 2885 against
2234 (over). Work that shows nothing at login now starts after it. The chrome appears in its
final place (0 jumps) and no overview flashes.

**Still over the limits on this software renderer:**
- **First login after installing** (cold shader cache): about 0.65 s over the limit. The blur
  behind the menu bar and dock costs ~200 ms of the first frame while its shaders compile.
- **Notification Center from the clock:** 243–304 ms between runs, at the 250 ms line.
- **Overview and menu frame times:** the slowest 5% of frames are 1.5–2.5x stock's (overview
  42–59 ms against 31; menus 35–51 ms against 19–20).
- **Bursts** (six windows opening and closing, overview spam): 3–5 stalls over 50 ms against a
  stock-relative limit of 3. Guava's own window handlers explain only 15–25% of each stall
  (tools/scenarios/burst-handlers.sh); no feature switched off changes it measurably.

On your machine: tell me if your first login, the Notification Center, the overview or a burst
of windows feels slow. These are the places where a real GPU decides whether the gap matters.
