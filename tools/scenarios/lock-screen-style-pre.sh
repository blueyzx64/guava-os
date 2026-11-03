# GUAVA_PRE for tools/scenarios/lock-screen-style.sh (L16). The headless harness Shell has no screen shield:
# Main.screenShield exists only when LoginManager.canLock() is true, which needs systemd's seats directory and
# GDM's org.gnome.DisplayManager.Manager Version >= 3.5.91 on the system bus. This fakes both (the names, nothing
# of GDM): the real ScreenShield and UnlockDialog code then run. No GDM greeter, PAM or fprintd exists, so a
# password cannot be verified; see the LIMITS in lock-screen-style.sh.
# Bundle: K=tools/harness/lib; $K/bundle.sh $S/pre.sh $K/pre-lib.sh tools/scenarios/lock-screen-style-pre.sh
mkdir -p /run/systemd/seats
pre_bus
cat > "$W/fake-gdm.py" <<'PY'
import dbus, dbus.service, dbus.mainloop.glib
from gi.repository import GLib
dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SystemBus()
name = dbus.service.BusName('org.gnome.DisplayManager', bus)
class Manager(dbus.service.Object):
    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='ss', out_signature='v')
    def Get(self, iface, prop):
        return dbus.String('48.0')
    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='s', out_signature='a{sv}')
    def GetAll(self, iface):
        return {'Version': dbus.String('48.0')}
Manager(bus, '/org/gnome/DisplayManager/Manager')
GLib.MainLoop().run()
PY
(python3 "$W/fake-gdm.py" >"$W/fake-gdm.log" 2>&1 &)
_kwait_name system org.gnome.DisplayManager
