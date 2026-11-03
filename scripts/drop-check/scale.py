# Sets the hidden shell's screen to a scale, e.g. 1.3333 (a laptop's 133 %).
import sys, dbus
bus = dbus.SessionBus()
dc = dbus.Interface(bus.get_object('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig'), 'org.gnome.Mutter.DisplayConfig')
serial, monitors, logical, props = dc.GetCurrentState()
want = float(sys.argv[1])
(conn, *_), modes, mprops = monitors[0][0], monitors[0][1], monitors[0][2]
mode = next(m for m in modes if m[6].get('is-current'))
scales = list(mode[5])
scale = min(scales, key=lambda s: abs(s - want))
print('SCALE connector', conn, 'mode', mode[0], 'scale', scale, 'of', [round(s, 3) for s in scales])
dc.ApplyMonitorsConfig(serial, dbus.UInt32(1), [(0, 0, dbus.Double(scale), dbus.UInt32(0), True, [(conn, mode[0], dbus.Dictionary({}, signature='sv'))])], dbus.Dictionary({}, signature='sv'))
