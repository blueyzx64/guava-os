Guava OS brings the macOS desktop to GNOME Shell 50 (Fedora 44, Wayland). Every feature can be turned off in preferences, and the defaults follow macOS.

## What's new
- Menu bar with the logo menu, app menus and Help search; a transparent bar.
- Guava's own Dock with Genie and Scale minimize, magnification, bounce, badges and Stacks.
- Window controls that move to the top bar when a window is maximized or touching it, window tiling, the green-button menu, a top-centre layout picker, Split View and Hide.
- Stage Manager, Mission Control, App Exposé, Launchpad, the app switcher (Alt+Tab and Super+Tab), gestures and hot corners.
- Spotlight, Control Center, Notification Center and Focus.
- The notch with live activities and a file shelf.
- Desktop widgets and desktop icons.
- Screenshots toolbar, emoji picker, colour filters and faux Liquid Glass.

## Downloads
- `guava-os@blueyzx64.shell-extension-<version>.zip`: the extension.
  Install with `gnome-extensions install --force <zip>`, log out and back in, then run `gnome-extensions enable guava-os@blueyzx64`.
- `guava-shelf-helper-<version>.noarch.rpm`: optional. It lets you drag files out of the notch shelf into other apps.
  Install with `sudo dnf install ./guava-shelf-helper-*.noarch.rpm`. Without it, the shelf keeps its Open and Copy actions.
