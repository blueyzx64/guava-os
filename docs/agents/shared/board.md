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
| B17 | Green exit-full-screen control in revealed full-screen menu bar | L10 | merged | d9661c3 |
| B18 | Dock magnification upscales 48px bitmaps (blurry) (R2 finding) | L13 | merged | c77c831 |
| B19 | GNOME 50 font-rendering=automatic overrides Guava hinting in GTK4 (R2 finding) | L12 | merged | 65cce5c |
| B20 | Heavier text via environment.d (stem darkening), verified in harness (D-010) | L12 | merged | 65cce5c |
| B21 | Lock runs full disable() (~250 ms block) (R1 #4) | L14 | merged | 109e3db |
| B22 | Dash to Dock removal can make GNOME re-enable Guava at login (R1 #5, unverified) | L13 | merged | c77c831 |
| B23 | Tiling snaps without resize animation (R1 #10, Tiling Shell technique) | L10 | merged | d9661c3 |
| B24 | Minimizing a full-screen window shows no Genie (restore animates); cause not traced (L1) | L17 | merged: minimize before isolation keeps Genie; mid-slide gap remains | 2184da9 |
| B25 | Stage Manager ground-up rewrite: minimize, maximize, left-edge reveal, access all buggy (user) | L8 | merged: 71/71 scenario asserts | fc45180 |
| B26 | Titlebar drag p95 135 ms vs stock 40 ms (L5 perf suite) | L15 | merged (drag p95 = harness gaps; Genie/MC previews degraded: L19) | 5518dbd |
| B27 | Notch moves once after first shown at login | L14 | merged | 9497a7f |
| B28 | Features consume motion.env.degraded (glass, magnify, previews, genie->scale) | L15 | merged (drag p95 = harness gaps; Genie/MC previews degraded: L19) | 5518dbd |
| B29 | App menus for every toolkit: Qt PID match, Electron/Flatpak helpers, a11y on, generic menu with real commands | L9 | merged: a11y on, X11/Flatpak helpers, real Edit; Qt Wayland impossible (spike) | 3ffad6f.. |
| B30 | app-menus-window scenario: Return to Previous Size / Always on Visible Workspace / menus closed fail; cause unknown (O hypotheses wrong; 28cf048 message overstates) | L9 | fixed: test bug (click during submenu animation) | 0d8cce0 |
| B31 | Stage Manager: drag a thumbnail onto the stage / a window onto a thumbnail (Shift-click joins today) | L11 | merged: 88/88 SM asserts | 56ac145 |
| B32 | macOS-style customizable lock screen (D-022) | L16 | merged: 37/37; real password/HiDPI/real wallpaper untested; field ~5px off-centre; name under avatar not seen in harness | 0be2163 |
| B33 | Clean-room rewrite of the 4 kem-a-derived files, then Kiwi only as inspiration (D-023) | L17+O | done except po/ translations | 2184da9 |
| B34 | Login: ready 2604 vs limit 2090 ms, stall total 1357 vs 1256 ms; bound by module parsing (~500 ms) | L18 measured -> L19 (notch + desktop-icons first render) | a1aae77 |
| B35 | 250 ms misses: clock/Notification Center 366, notch hover 657, Mission Control first open 495; overview.p95 55 vs stock 21; burst stalls 5 vs 3; Genie + MC previews use env.degraded | L19 | merged; final suite: MC first open 416 ms still over | 9c4425c |
| B36 | Final suite (quiet machine, 9c4425c): 35 PASS 5 FAIL: login.ready 2390/1940, overview.p95 49.5/34.5, overview-load.p95 61/52, degraded never trips under load, Mission Control first open 416 ms > 250 | next wave | todo | |
| B37 | Repo restructure to src/ layout (D-025) | O | done | c561c19 |
| A1 | Hand-over audit: checks that failed open, hidden errors, 6 reviews (5 high, 24 medium), 6 fix lanes, X11/multi-monitor/scale harness | O + RV1-6 + F1-F6 | merged; final verification running | c561c19 |
| W5 | Wave 5 (2026-11-03, base main 11b3750). Limits: 3 sonnet, 6 haiku (user, was 6/12). 4 CPUs: perf numbers only from O's serial final run | O | done, on branch 09b40be | |
| B38 | Login ready: warm 2059/2207 PASS, cold 2885/2234 over (glass first-frame shaders) | Q1 | merged (app-menus late reverted by O) | 7870460 |
| B39 | MC first open: warm 179, cold 267 (was 308-349); warm-up invisible, 0 Clutter warnings | Q2 + O | merged | a4c916f |
| B40 | Burst stalls 3-5 vs 3; handlers only 15-25% of stall; no fix | Q3 | tools merged, open | 429fe47 |
| B41 | Liquid Glass off by default, frosted Gaussian blur | Q4 | merged | 9a87632 |
