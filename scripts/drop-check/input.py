# The hidden shell's pointer and keyboard, through Mutter's RemoteDesktop API.
#   input.py escape | tile-left | tile-right
#   input.py move X Y
#   input.py drag X0 Y0 X1 Y1
import sys, time, dbus

bus = dbus.SessionBus()
rd = bus.get_object('org.gnome.Mutter.RemoteDesktop', '/org/gnome/Mutter/RemoteDesktop')
s = dbus.Interface(bus.get_object('org.gnome.Mutter.RemoteDesktop', dbus.Interface(rd, 'org.gnome.Mutter.RemoteDesktop').CreateSession()), 'org.gnome.Mutter.RemoteDesktop.Session')
s.Start()
time.sleep(0.3)
BTN_LEFT, SUPER, LEFT, RIGHT = 0x110, 0xffeb, 0xff51, 0xff53
pos = [0.0, 0.0]

def home():
    # Relative moves only (absolute ones need a screencast stream): park in the top-left corner first.
    s.NotifyPointerMotionRelative(-100000.0, -100000.0)
    pos[0] = pos[1] = 0.0
    time.sleep(0.05)

def move(x, y, steps=1, dt=0.0):
    for i in range(steps):
        dx, dy = (x - pos[0]) / (steps - i), (y - pos[1]) / (steps - i)
        s.NotifyPointerMotionRelative(float(dx), float(dy))
        pos[0] += dx; pos[1] += dy
        time.sleep(dt)

def keys(*syms):
    for k in syms: s.NotifyKeyboardKeysym(dbus.UInt32(k), True); time.sleep(0.05)
    for k in reversed(syms): s.NotifyKeyboardKeysym(dbus.UInt32(k), False); time.sleep(0.05)
    time.sleep(0.3)

cmd, args = sys.argv[1], [float(a) for a in sys.argv[2:]]
if cmd == 'escape': keys(0xff1b)
elif cmd == 'tile-left': keys(SUPER, LEFT)
elif cmd == 'tile-right': keys(SUPER, RIGHT)
elif cmd == 'move': home(); move(args[0], args[1], 10, 0.02); time.sleep(0.2)
elif cmd == 'drag':
    x0, y0, x1, y1 = args
    home(); move(x0, y0, 10, 0.02); time.sleep(0.3)
    s.NotifyPointerButton(BTN_LEFT, True); time.sleep(0.2)
    move(x0 + 30, y0, 6, 0.03)
    move(x1, y1, 60, 0.02); time.sleep(0.5)
    move(x1 + 4, y1 + 4, 3, 0.05); time.sleep(0.4)
    s.NotifyPointerButton(BTN_LEFT, False); time.sleep(0.8)
s.Stop()
