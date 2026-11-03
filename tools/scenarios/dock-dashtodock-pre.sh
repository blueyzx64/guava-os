# GUAVA_PRE for dock-dashtodock.sh (B22): a stand-in Dash to Dock (same uuid) enabled BEFORE Guava, as on a
# real machine where it was installed first. It logs enable/disable to $W/dtd.log.
D=$X/dash-to-dock@micxgx.gmail.com
mkdir -p $D
cat > $D/metadata.json <<'JSON'
{"uuid":"dash-to-dock@micxgx.gmail.com","name":"DtD stand-in","description":"harness","shell-version":["49","50","51"]}
JSON
cat > $D/extension.js <<'JS'
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
const note = s => { const f = '/tmp/w/dtd.log'; let old = ''; try { old = new TextDecoder().decode(GLib.file_get_contents(f)[1]); } catch (_e) { /* first */ } GLib.file_set_contents(f, `${old}${s}\n`); };
export default class Dtd extends Extension {
    enable() { note('enable order=' + Main.extensionManager._extensionOrder.join(',')); }
    disable() { note('disable order=' + Main.extensionManager._extensionOrder.join(',')); }
}
JS
gsettings set org.gnome.shell enabled-extensions "['probe@x2','dash-to-dock@micxgx.gmail.com','$UUID']"
