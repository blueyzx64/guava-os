// SPDX-License-Identifier: GPL-3.0-or-later
// Gio classes that moved to GioUnix (GLib 2.80). Reading them through `Gio` still works but
// makes GJS 1.90 (GNOME 51) log a deprecation warning. Every Guava target ships GioUnix:
// checked GLib 2.84 / gjs 1.84 on GNOME 48.1 and GLib 2.90 / gjs 1.90 on GNOME 51.1.
// Only gi:// imports, so modules covered by `gjs -m` tests can use it; lib/compat.js
// re-exports it for everyone else.

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';

/** GioUnix.DesktopAppInfo, or Gio.DesktopAppInfo if GioUnix lacks it. */
export const DesktopAppInfo = GioUnix?.DesktopAppInfo ?? Gio.DesktopAppInfo;
