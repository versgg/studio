# A GTK4 window that drags files the way GNOME Files does (a GdkFileList). Each drag offers the
# next file on the command line, so every drop brings in a file Studio hasn't seen yet.
import sys, gi
gi.require_version('Gtk', '4.0'); gi.require_version('Gdk', '4.0')
from gi.repository import Gtk, Gdk, Gio, GObject

files = sys.argv[1:]
turn = [0]

def prepare(src, x, y):
    path = files[turn[0] % len(files)]
    turn[0] += 1
    print('drag', path, flush=True)
    return Gdk.ContentProvider.new_for_value(GObject.Value(Gdk.FileList, Gdk.FileList.new_from_list([Gio.File.new_for_path(path)])))

def activate(app):
    win = Gtk.ApplicationWindow(application=app, title='drop-check source')
    label = Gtk.Label(label='Drag from here'); label.set_hexpand(True); label.set_vexpand(True)
    src = Gtk.DragSource(); src.set_actions(Gdk.DragAction.COPY); src.connect('prepare', prepare)
    src.connect('drag-cancel', lambda s, d, reason: print('cancelled', reason.value_nick, flush=True) or False)
    src.connect('drag-end', lambda s, d, delete: print('ended', flush=True))
    label.add_controller(src)
    # check.mjs tiles this window on the left half and checks where it went by where the pointer
    # is seen.
    seen = Gtk.EventControllerMotion()
    seen.connect('motion', lambda c, x, y: print('pointer', round(x), round(y), flush=True))
    label.add_controller(seen)
    win.set_child(label); win.present()
    print('up', flush=True)

app = Gtk.Application(application_id='studio.dropcheck.source', flags=Gio.ApplicationFlags.NON_UNIQUE)
app.connect('activate', activate)
app.run([sys.argv[0]])
