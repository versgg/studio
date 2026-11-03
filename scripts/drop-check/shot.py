# Saves one frame of the hidden shell's screen (for a failed drop), through Mutter's ScreenCast API.
import sys, subprocess, dbus
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib
DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
sc = dbus.Interface(bus.get_object('org.gnome.Mutter.ScreenCast', '/org/gnome/Mutter/ScreenCast'), 'org.gnome.Mutter.ScreenCast')
sp = sc.CreateSession(dbus.Dictionary({}, signature='sv'))
sess = dbus.Interface(bus.get_object('org.gnome.Mutter.ScreenCast', sp), 'org.gnome.Mutter.ScreenCast.Session')
stp = sess.RecordMonitor('Meta-0', dbus.Dictionary({'cursor-mode': dbus.UInt32(1)}, signature='sv'))
loop = GLib.MainLoop()
node = []
def added(n): node.append(int(n)); loop.quit()
bus.add_signal_receiver(added, 'PipeWireStreamAdded', 'org.gnome.Mutter.ScreenCast.Stream', path=stp)
sess.Start()
GLib.timeout_add(5000, loop.quit)
loop.run()
if node:
    subprocess.run(['gst-launch-1.0', '-q', 'pipewiresrc', f'path={node[0]}', 'num-buffers=3', '!', 'videoconvert', '!', 'pngenc', 'snapshot=true', '!', 'filesink', f'location={sys.argv[1]}'], timeout=15)
sess.Stop()
print('SHOT', sys.argv[1], 'node', node)
