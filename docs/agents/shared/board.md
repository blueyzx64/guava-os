# Board
| Id | Bug / task | Lane | Status | Commit |
|---|---|---|---|---|
| B1 | Genie (magic lamp) minimize does not always run | L1 | merged (harness pending) | 2f23bcb+c1a49b8 |
| B2 | Desktop very buggy right after login | L5 | merged; login overview zoom needs Shell support | 160ccac |
| B3 | Liquid Glass looks awful | L4 | merged | 62fbd67 |
| B4 | Top bar and notch are buggy | L3 | top 3 merged, 4 low open in L3.md | f5735b9 |
| B5 | App menus not feature-rich enough | L6 | partly: Window menu done, rest in L6.md | 616ff55 |
| B6 | Move window to New Workspace does not work | L6 | merged | 616ff55 |
| B7 | Always on Top (pin on top) does not work | L6 | merged | 616ff55 |
| B8 | Notch shows downloads weeks after they were cancelled | L3 | merged | 238c62b |
| B10 | Testable environment (Fedora 44 / GNOME 50) | O | done: harness fixed, runs in container | |
| B11 | Perf suite: curves, smoothness, login lag, idle, burst, CPU overload | L5 | suite merged: 23 PASS 6 FAIL vs stock | c6d00f3 |
| B12 | Maximize button = full screen; clicking it in full screen leaves full screen | L2 | merged | 36ce34e |
| B13 | Shake-to-locate fires while dragging windows: port Kiwi features/pointer with drag gate (D-008) | L7 | merged (big-pointer crispness unverified) | 88c73f4 |
| B14 | Windows minimized to the Dock must stay out of Mission Control | L1 | merged | 6bd5e88 |
| B15 | Top bar blur jumps when leaving Mission Control | L4 | merged | 6bbf98f |
| S1 | Agent infra: memory, ownership log, workflow, principles | O | done | |
| S2 | Skills for GNOME/GJS/Clutter/extensions (+ Kiwi apple-design, gjs) | R1, W1 | done | 20bf317, c65717a |
| B16 | Stage Manager: minimize emits nothing with SM on; windows stay minimized+unmapped after SM off (L1 finding) | L8 | merged | fc45180 |
| B17 | Green exit-full-screen control in revealed full-screen menu bar | wave 2 | todo | |
| B18 | Dock magnification upscales 48px bitmaps (blurry) (R2 finding) | wave 2 | todo | |
| B19 | GNOME 50 font-rendering=automatic overrides Guava hinting in GTK4 (R2 finding) | wave 2 | todo | |
| B20 | Heavier text via environment.d (stem darkening), verified in harness (D-010) | wave 2 | todo | |
| B21 | Lock runs full disable() (~250 ms block) (R1 #4) | wave 2 | todo | |
| B22 | Dash to Dock removal can make GNOME re-enable Guava at login (R1 #5, unverified) | wave 2 | todo | |
| B23 | Tiling snaps without resize animation (R1 #10, Tiling Shell technique) | wave 2 | todo | |
| B24 | Minimizing a full-screen window shows no Genie (restore animates); cause not traced (L1) | wave 2 | todo | |
| B25 | Stage Manager ground-up rewrite: minimize, maximize, left-edge reveal, access all buggy (user) | L8 | merged: 71/71 scenario asserts | fc45180 |
| B26 | Titlebar drag p95 135 ms vs stock 40 ms (L5 perf suite) | wave 2 | todo | |
| B27 | Notch moves once after first shown at login | L5/wave 2 | todo | |
| B28 | Features consume motion.env.degraded (glass, magnify, previews, genie->scale) | wave 2 | todo | |
| B29 | App menus for every toolkit: Qt PID match, Electron/Flatpak helpers, a11y on, generic menu with real commands | L9 | merged: a11y on, X11/Flatpak helpers, real Edit; Qt Wayland impossible (spike) | 3ffad6f.. |
| B30 | app-menus-window scenario: Return to Previous Size / Always on Visible Workspace / menus closed fail; cause unknown (O hypotheses wrong; 28cf048 message overstates) | L9 | fixed: test bug (click during submenu animation) | 0d8cce0 |
| B31 | Stage Manager: drag a thumbnail onto the stage / a window onto a thumbnail (Shift-click joins today) | wave 2 | todo | |
