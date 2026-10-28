# Spotlight

## What it does
A centred glass search bar. Registry id `spotlight` (key `spotlight`, on). Code: `features/spotlight/`.

## Use
- **Open:** tap Super (`spotlight-on-super`, on; it takes the tap from the Activities overview). `spotlight-shortcut` adds an optional extra binding (empty by default).
- **Results:** applications, GNOME Settings panels and Guava switches, files and documents (through GNOME's search providers, so nothing is indexed twice), clipboard history, a calculator (arithmetic and conversions such as `5 km in miles`), a web search row, and Actions (Show Desktop, Lock Screen, timers, Do Not Disturb, Dark Mode, Empty Trash, screenshots, apps' desktop actions).
- **Keys:** arrows move, Enter opens, Tab scopes to the focused app's menu items, Space opens Quick Look (needs Sushi), Esc closes. `/` filters the search by type.
- **Browse views:** Applications, Files, Actions and Clipboard buttons next to the empty field; Super+1 to Super+4 open them.
- **Quick Keys:** a short alias that runs an action or opens an app; words after it are its value.
- **History:** recent searches and opened results show in the empty field; Up recalls past searches.

## Settings (default)
`spotlight` on · `spotlight-on-super` on · `spotlight-files` on · `spotlight-settings` on · `spotlight-calculator` on · `spotlight-clipboard` on · `spotlight-recent-clipboard` off (shows copies in the empty field) · `spotlight-web` on · `spotlight-engine` `duckduckgo` (Google, Bing, Brave, Startpage, Ecosia, custom) · `spotlight-views` on · `spotlight-actions` on · `spotlight-quick-keys` empty · `spotlight-history` on · `spotlight-quick-look` on · `spotlight-menu-items` on.

## Limits
- Nothing is sent to the web until you press Return on the web row.
- Quick Look needs the Sushi previewer installed.
- It does not use the overview search, so it works the same in any state of the Shell. It shares its window component with Quick Paste (one Guava modal at a time).
