"""Disposable X11 event receiver for the real guest smoke test; no automation mocks."""
import ctypes as C
import json
import os
import time

x = C.CDLL("libX11.so.6")


def bind(name, result, *arguments):
    function = getattr(x, name)
    function.restype, function.argtypes = result, arguments
    return function


class KeyEvent(C.Structure):
    _fields_ = [("type", C.c_int), ("serial", C.c_ulong), ("send_event", C.c_int),
                ("display", C.c_void_p), ("window", C.c_ulong), ("root", C.c_ulong),
                ("subwindow", C.c_ulong), ("time", C.c_ulong), ("x", C.c_int),
                ("y", C.c_int), ("x_root", C.c_int), ("y_root", C.c_int),
                ("state", C.c_uint), ("keycode", C.c_uint), ("same_screen", C.c_int)]


class Event(C.Union):
    _fields_ = [("type", C.c_int), ("key", KeyEvent), ("pad", C.c_long * 24)]


class MappingEvent(C.Structure):
    _fields_ = [("type", C.c_int), ("serial", C.c_ulong), ("send_event", C.c_int),
                ("display", C.c_void_p), ("window", C.c_ulong), ("request", C.c_int),
                ("first_keycode", C.c_int), ("count", C.c_int)]


display = bind("XOpenDisplay", C.c_void_p, C.c_char_p)(None)
assert display, "No X display"
root = bind("XDefaultRootWindow", C.c_ulong, C.c_void_p)(display)
window = bind("XCreateSimpleWindow", C.c_ulong, C.c_void_p, C.c_ulong, C.c_int, C.c_int,
              C.c_uint, C.c_uint, C.c_uint, C.c_ulong, C.c_ulong)(display, root, 100, 100, 600, 400, 0, 0, 0x306090)
bind("XStoreName", C.c_int, C.c_void_p, C.c_ulong, C.c_char_p)(display, window, b"Mukai computer_use smoke")
bind("XSelectInput", C.c_int, C.c_void_p, C.c_ulong, C.c_long)(display, window, 1 | 2 | 4 | 8 | 64)
bind("XMapRaised", C.c_int, C.c_void_p, C.c_ulong)(display, window)
bind("XSync", C.c_int, C.c_void_p, C.c_int)(display, 0)
time.sleep(1)
bind("XSetInputFocus", C.c_int, C.c_void_p, C.c_ulong, C.c_int, C.c_ulong)(display, window, 2, 0)
bind("XSync", C.c_int, C.c_void_p, C.c_int)(display, 0)
rx, ry, child = C.c_int(), C.c_int(), C.c_ulong()
bind("XTranslateCoordinates", C.c_int, C.c_void_p, C.c_ulong, C.c_ulong, C.c_int, C.c_int,
     C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_ulong))(display, window, root, 0, 0, C.byref(rx), C.byref(ry), C.byref(child))
state = dict(x=rx.value, y=ry.value, text="", buttons=[], motion=0, releasedKeys=0)


def save():
    with open("computer_use-events.tmp", "w", encoding="utf8") as file:
        json.dump(state, file)
    os.replace("computer_use-events.tmp", "computer_use-events.json")


save()
print("X11 receiver ready", flush=True)
lookup = bind("XLookupString", C.c_int, C.POINTER(KeyEvent), C.c_char_p, C.c_int, C.POINTER(C.c_ulong), C.c_void_p)
next_event = bind("XNextEvent", C.c_int, C.c_void_p, C.POINTER(Event))
refresh = bind("XRefreshKeyboardMapping", C.c_int, C.POINTER(MappingEvent))
while True:
    event = Event()
    next_event(display, C.byref(event))
    if event.type == 34:
        # Xlib clients must refresh their local cache after MappingNotify.
        refresh(C.cast(C.byref(event), C.POINTER(MappingEvent)))
    elif event.type == 2:
        symbol = C.c_ulong()
        lookup(C.byref(event.key), None, 0, C.byref(symbol), None)
        value = symbol.value
        if event.key.state & 4 and value == ord("a"):
            state["text"] = ""
        elif value < 256:
            state["text"] += chr(value)
        elif value & 0xff000000 == 0x01000000:
            state["text"] += chr(value & 0xffffff)
    elif event.type == 3:
        state["releasedKeys"] += 1
    elif event.type == 4:
        state["buttons"].append(event.key.keycode)
    elif event.type == 6:
        state["motion"] += 1
    save()
