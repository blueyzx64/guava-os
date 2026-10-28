imports.gi.versions.Gio='2.0';
const {Gio,GLib}=imports.gi;
const xml=`<node><interface name="org.freedesktop.login1.Manager">
<method name="GetSession"><arg type="s" direction="in"/><arg type="o" direction="out"/></method>
<method name="GetSessionByPID"><arg type="u" direction="in"/><arg type="o" direction="out"/></method>
<method name="ListSessions"><arg type="a(susso)" direction="out"/></method>
<method name="Inhibit"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="h" direction="out"/></method>
<method name="CanSuspend"><arg type="s" direction="out"/></method>
<method name="CanPowerOff"><arg type="s" direction="out"/></method>
<method name="CanReboot"><arg type="s" direction="out"/></method>
<method name="CanHibernate"><arg type="s" direction="out"/></method>
<signal name="PrepareForSleep"><arg type="b"/></signal>
<signal name="PrepareForShutdown"><arg type="b"/></signal>
</interface>
<interface name="org.freedesktop.login1.Session">
<property name="Active" type="b" access="read"/><property name="Type" type="s" access="read"/><property name="Class" type="s" access="read"/><property name="Remote" type="b" access="read"/><property name="Id" type="s" access="read"/><property name="LockedHint" type="b" access="read"/><property name="IdleHint" type="b" access="read"/><property name="State" type="s" access="read"/>
<method name="SetLockedHint"><arg type="b" direction="in"/></method>
<method name="SetIdleHint"><arg type="b" direction="in"/></method>
<signal name="Lock"/><signal name="Unlock"/>
</interface></node>`;
const info=Gio.DBusNodeInfo.new_for_xml(xml);
const P='/org/freedesktop/login1/session/_1';
const props={Active:new GLib.Variant('b',true),Type:new GLib.Variant('s','wayland'),Class:new GLib.Variant('s','user'),Remote:new GLib.Variant('b',false),Id:new GLib.Variant('s','1'),LockedHint:new GLib.Variant('b',false),IdleHint:new GLib.Variant('b',false),State:new GLib.Variant('s','active')};
Gio.bus_own_name(Gio.BusType.SYSTEM,'org.freedesktop.login1',Gio.BusNameOwnerFlags.NONE,(c)=>{
 c.register_object('/org/freedesktop/login1',info.lookup_interface('org.freedesktop.login1.Manager'),(c,s,p,i,m,params,inv)=>{
  switch(m){
   case 'GetSession':case 'GetSessionByPID':inv.return_value(new GLib.Variant('(o)',[P]));break;
   case 'ListSessions':inv.return_value(new GLib.Variant('(a(susso))',[[]]));break;
   case 'Inhibit':{const fl=Gio.UnixFDList.new();fl.append(0);inv.return_value_with_unix_fd_list(new GLib.Variant('(h)',[0]),fl);break;}
   default:inv.return_value(new GLib.Variant('(s)',['na']));
  }},null,null);
 c.register_object(P,info.lookup_interface('org.freedesktop.login1.Session'),(c,s,p,i,m,params,inv)=>inv.return_value(null),(c,s,p,i,n)=>props[n],null);
},null,null);
GLib.MainLoop.new(null,false).run();
