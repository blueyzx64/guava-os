# Scenario (GUAVA_EXTRA, bundled after tools/harness/lib/lib.sh): generic Edit menu.
# Text Editor exports no Edit actions to the menu bar, so Guava's Edit items type the standard
# shortcut into the window. Each command is checked by what it does to the document/clipboard:
#   Select All + Copy -> clipboard has the text; Paste -> the clipboard text lands in the document;
#   Cut -> clipboard has the text and the document is empty; Undo -> the cut text is back.
force_animations on
sleep 1
H='const ed=()=>kwin("org.gnome.TextEditor");
const bar=()=>inst("menu-bar").part("apps");
const clip=St.Clipboard.get_default();
const getClip=()=>new Promise(r=>clip.get_text(St.ClipboardType.CLIPBOARD,(c,t)=>r(t??"")));
const setClip=t=>clip.set_text(St.ClipboardType.CLIPBOARD,t);
const focusEd=async()=>{ed().activate(global.get_current_time()); await sl(700);};
const cmd=async slot=>{await focusEd(); const a=bar(); const m=a.menus.find(x=>x.id==="edit"); const it=m?.items.find(i=>i.id===slot); if(!it) return false; const ok=await a._service.activate(a.target,it.command); await sl(900); return ok;};
const type=async s=>{for(const ch of s){await kkey([ch]);}};
const docText=async()=>{await cmd("select-all"); setClip("<<none>>"); await cmd("copy"); return await getClip();};'
J() { _kjs "$H $1"; }

J 'await focusEd(); await kkey(["Control_L","a"]); await kkey(["BackSpace"]); await type("abc"); await sl(300); return 1' >/dev/null
echo "EDIT menu items: $(J 'const m=bar().menus.find(x=>x.id==="edit"); return JSON.stringify(m?.items.map(i=>i.id+":"+(i.command?.provider||"-")+":"+i.enabled))')"
assert "Edit menu present with generic key commands" "(()=>{const m=inst('menu-bar').part('apps').menus.find(x=>x.id==='edit');return !!m && m.items.some(i=>i.command?.name==='key');})()"
chk() { # chk NAME OUTPUT EXPECTED-SUBSTRING
  case "$2" in *"$3"*) echo "EDIT PASS $1: $2";; *) echo "EDIT FAIL $1 (want $3): $2";; esac
}
chk "Select All + Copy" "$(J 'return JSON.stringify(await docText())')" 'abc'
chk "Paste (replaces the selection)" "$(J 'setClip("XYZ"); await cmd("paste"); return JSON.stringify(await docText())')" 'XYZ'
chk "Undo" "$(J 'await cmd("undo"); return JSON.stringify(await docText())')" 'abc'
chk "Cut" "$(J 'await cmd("select-all"); setClip("<<none>>"); await cmd("cut"); const c=await getClip(); await cmd("select-all"); setClip("<<none>>"); await cmd("copy"); return JSON.stringify({cut:c,left:await getClip()})')" 'cut\\":\\"abc\\",\\"left\\":\\"<<none>>'
chk "Undo after Cut" "$(J 'await cmd("undo"); return JSON.stringify(await docText())')" 'abc'
shot edit
assert_summary
