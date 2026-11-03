# Scenario (GUAVA_EXTRA): the glass tint reads GNOME 50's default wallpapers (JPEG XL, and an XML background that lists them).
# Needs gnome-backgrounds in the root (`dnf install gnome-backgrounds` inside the root); without it the
# scenario prints SKIP and passes. Bundle: K=tools/harness/lib; $K/bundle.sh OUT $K/lib.sh tools/scenarios/glass-wallpaper.sh
JXL=/usr/share/backgrounds/gnome/adwaita-l.jxl
if [ ! -f $JXL ]; then
  echo "SKIP glass-wallpaper: gnome-backgrounds is not installed in this root"
  assert_summary
else
  _kjs 'const EXT=Main.extensionManager.lookup("guava-os@blueyzx64").dir.get_path(); const {Glass}=await import("file://"+EXT+"/lib/glass.js"); globalThis.__tint=()=>Glass._env.wallpaper; return 1' >/dev/null
  force_animations on
  gsettings set org.gnome.desktop.interface color-scheme default
  # a flat colour first, so "tint read" cannot be a leftover
  gsettings set org.gnome.desktop.background picture-options none
  gsettings set org.gnome.desktop.background picture-uri ""
  gsettings set org.gnome.desktop.background picture-uri-dark ""
  gsettings set org.gnome.desktop.background primary-color '#102030'
  sleep 2
  gsettings set org.gnome.desktop.background picture-options zoom
  gsettings set org.gnome.desktop.background picture-uri "file://$JXL"
  gsettings set org.gnome.desktop.background picture-uri-dark "file:///usr/share/backgrounds/gnome/adwaita-d.jxl"
  wait_for "Array.isArray(globalThis.__tint()) && globalThis.__tint().length === 3 && Math.abs(globalThis.__tint()[0] - 16) > 3" 20
  _kjs "globalThis.__t1 = globalThis.__tint(); return 1" >/dev/null
  assert jxl-light-tint-is-a-colour "Array.isArray(globalThis.__t1) && globalThis.__t1.length === 3 && globalThis.__t1.every(Number.isFinite)"
  gsettings set org.gnome.desktop.interface color-scheme prefer-dark
  wait_for "Array.isArray(globalThis.__tint()) && globalThis.__tint().some((c,i)=>Math.abs(c-globalThis.__t1[i])>4)" 30
  _kjs "globalThis.__t2 = globalThis.__tint(); return 1" >/dev/null
  assert jxl-dark-tint-differs-from-light "Array.isArray(globalThis.__t2) && globalThis.__t2.some((c,i)=>Math.abs(c-globalThis.__t1[i])>4)"
  # a day/night XML background that lists them
  cat > $W/slides.xml <<XML
<background><starttime><year>2020</year><month>1</month><day>1</day><hour>0</hour><minute>0</minute><second>0</second></starttime>
<static><duration>86400.0</duration><file>/usr/share/backgrounds/gnome/adwaita-d.jxl</file></static>
<static><duration>864000.0</duration><file>/usr/share/backgrounds/gnome/adwaita-l.jxl</file></static></background>
XML
  gsettings set org.gnome.desktop.interface color-scheme default
  gsettings set org.gnome.desktop.background picture-options none
  wait_for "globalThis.__tint()?.[0] === 16" 30
  gsettings set org.gnome.desktop.background picture-options zoom
  gsettings set org.gnome.desktop.background picture-uri "file://$W/slides.xml"
  wait_for "Array.isArray(globalThis.__tint()) && globalThis.__tint()[0] !== 16" 30
  _kjs "globalThis.__t3 = globalThis.__tint(); return 1" >/dev/null
  assert xml-wallpaper-tint-read "Array.isArray(globalThis.__t3) && globalThis.__t3.length === 3"
  _kjs "return 'TINTS light=' + JSON.stringify(globalThis.__t1) + ' dark=' + JSON.stringify(globalThis.__t2) + ' xml=' + JSON.stringify(globalThis.__t3)" | grep -o 'TINTS [^"]*'
  assert_summary
fi
