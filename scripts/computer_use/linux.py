#!/usr/bin/env python3
"""App-owned JSON desktop helper. X11 needs only Python and the system X libraries."""
import base64
import ctypes as C
import ctypes.util
import json
import os
import struct
import sys
import time
import zlib


KEYSYMS = {
    "CTRL": 0xffe3, "SHIFT": 0xffe1, "ALT": 0xffe9, "SUPER": 0xffeb,
    "ENTER": 0xff0d, "ESCAPE": 0xff1b, "TAB": 0xff09, "BACKSPACE": 0xff08,
    "DELETE": 0xffff, "SPACE": 0x20, "UP": 0xff52, "DOWN": 0xff54,
    "LEFT": 0xff51, "RIGHT": 0xff53, "HOME": 0xff50, "END": 0xff57,
    "PAGEUP": 0xff55, "PAGEDOWN": 0xff56, "INSERT": 0xff63, "CAPSLOCK": 0xffe5,
}


def keysym(key):
    if key in KEYSYMS:
        return KEYSYMS[key]
    if len(key) == 1 and key.isascii() and key.isalnum():
        return ord(key.lower())
    if key.startswith("F") and key[1:].isdigit() and 1 <= int(key[1:]) <= 24:
        return 0xffbe + int(key[1:]) - 1
    raise RuntimeError("Unsupported key: " + key)


def text_keysym(character):
    if character == "\n" or character == "\r":
        return KEYSYMS["ENTER"]
    if character == "\t":
        return KEYSYMS["TAB"]
    code = ord(character)
    return code if code < 256 else 0x01000000 | code


def png(width, height, rows):
    def chunk(name, data):
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data) & 0xffffffff)
    compressed = zlib.compressobj(3)
    pieces = [compressed.compress(b"\0" + row) for row in rows]
    pieces.append(compressed.flush())
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", b"".join(pieces)) + chunk(b"IEND", b"")


class Monitor(C.Structure):
    _fields_ = [("name", C.c_ulong), ("primary", C.c_int), ("automatic", C.c_int),
                ("noutput", C.c_int), ("x", C.c_int), ("y", C.c_int),
                ("width", C.c_int), ("height", C.c_int), ("mwidth", C.c_int),
                ("mheight", C.c_int), ("outputs", C.POINTER(C.c_ulong))]


class XImage(C.Structure):
    _fields_ = [("width", C.c_int), ("height", C.c_int), ("xoffset", C.c_int),
                ("format", C.c_int), ("data", C.c_void_p), ("byte_order", C.c_int),
                ("bitmap_unit", C.c_int), ("bitmap_bit_order", C.c_int),
                ("bitmap_pad", C.c_int), ("depth", C.c_int), ("bytes_per_line", C.c_int),
                ("bits_per_pixel", C.c_int), ("red_mask", C.c_ulong),
                ("green_mask", C.c_ulong), ("blue_mask", C.c_ulong)]


class X11Desktop:
    def __init__(self):
        self.x = C.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
        self.test = C.CDLL(ctypes.util.find_library("Xtst") or "libXtst.so.6")
        self.bind(self.x, "XOpenDisplay", C.c_void_p, C.c_char_p)
        self.bind(self.x, "XDefaultRootWindow", C.c_ulong, C.c_void_p)
        self.bind(self.x, "XDefaultScreen", C.c_int, C.c_void_p)
        self.bind(self.x, "XDisplayWidth", C.c_int, C.c_void_p, C.c_int)
        self.bind(self.x, "XDisplayHeight", C.c_int, C.c_void_p, C.c_int)
        self.bind(self.x, "XFlush", C.c_int, C.c_void_p)
        self.bind(self.x, "XSync", C.c_int, C.c_void_p, C.c_int)
        self.bind(self.x, "XCloseDisplay", C.c_int, C.c_void_p)
        self.bind(self.x, "XFree", C.c_int, C.c_void_p)
        self.bind(self.x, "XGetAtomName", C.c_void_p, C.c_void_p, C.c_ulong)
        self.bind(self.x, "XKeysymToKeycode", C.c_uint, C.c_void_p, C.c_ulong)
        self.bind(self.x, "XDisplayKeycodes", C.c_int, C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_int))
        self.bind(self.x, "XGetKeyboardMapping", C.POINTER(C.c_ulong), C.c_void_p, C.c_uint, C.c_int, C.POINTER(C.c_int))
        self.bind(self.x, "XChangeKeyboardMapping", C.c_int, C.c_void_p, C.c_int, C.c_int, C.POINTER(C.c_ulong), C.c_int)
        self.bind(self.x, "XQueryPointer", C.c_int, C.c_void_p, C.c_ulong,
                  C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.c_int), C.POINTER(C.c_int),
                  C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_uint))
        self.bind(self.x, "XGetImage", C.POINTER(XImage), C.c_void_p, C.c_ulong,
                  C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_ulong, C.c_int)
        self.bind(self.x, "XDestroyImage", C.c_int, C.POINTER(XImage))
        self.bind(self.test, "XTestFakeKeyEvent", C.c_int, C.c_void_p, C.c_uint, C.c_int, C.c_ulong)
        self.bind(self.test, "XTestFakeButtonEvent", C.c_int, C.c_void_p, C.c_uint, C.c_int, C.c_ulong)
        self.bind(self.test, "XTestFakeMotionEvent", C.c_int, C.c_void_p, C.c_int, C.c_int, C.c_int, C.c_ulong)
        self.display = self.x.XOpenDisplay(None)
        if not self.display:
            raise RuntimeError("X11 desktop is unavailable. Run Mukai in the graphical session with DISPLAY and XAUTHORITY set.")
        self.root = self.x.XDefaultRootWindow(self.display)
        self.screen = self.x.XDefaultScreen(self.display)
        self.held = set()
        self.buttons = set()
        try:
            self.randr = C.CDLL(ctypes.util.find_library("Xrandr") or "libXrandr.so.2")
            self.bind(self.randr, "XRRGetMonitors", C.POINTER(Monitor), C.c_void_p, C.c_ulong, C.c_int, C.POINTER(C.c_int))
            self.bind(self.randr, "XRRFreeMonitors", None, C.POINTER(Monitor))
        except (OSError, AttributeError):
            self.randr = None

    @staticmethod
    def bind(library, name, result, *arguments):
        function = getattr(library, name)
        function.restype = result
        function.argtypes = arguments

    def monitors(self):
        output = []
        if self.randr:
            count = C.c_int()
            values = self.randr.XRRGetMonitors(self.display, self.root, 1, C.byref(count))
            try:
                for index in range(count.value):
                    monitor = values[index]
                    if monitor.width <= 0 or monitor.height <= 0:
                        continue
                    atom = self.x.XGetAtomName(self.display, monitor.name)
                    name = C.string_at(atom).decode("utf8", "replace") if atom else str(index)
                    if atom:
                        self.x.XFree(atom)
                    output.append(dict(id=name, name=name, x=monitor.x, y=monitor.y,
                                       width=monitor.width, height=monitor.height,
                                       pixelWidth=monitor.width, pixelHeight=monitor.height, primary=bool(monitor.primary)))
            finally:
                if values:
                    self.randr.XRRFreeMonitors(values)
        if not output:
            width = self.x.XDisplayWidth(self.display, self.screen)
            height = self.x.XDisplayHeight(self.display, self.screen)
            output.append(dict(id="desktop", name="X11 desktop", x=0, y=0, width=width, height=height,
                               pixelWidth=width, pixelHeight=height, primary=True))
        return output

    def capture(self, identity):
        monitor = next((item for item in self.monitors() if item["id"] == identity), None)
        if not monitor:
            raise RuntimeError("Display not found.")
        width, height = monitor["width"], monitor["height"]
        if width * height > 40000000:
            raise RuntimeError("Display exceeds 40 million pixels.")
        image = self.x.XGetImage(self.display, self.root, monitor["x"], monitor["y"], width, height, C.c_ulong(-1).value, 2)
        if not image:
            raise RuntimeError("Desktop screenshot failed.")
        try:
            info = image.contents
            if info.bits_per_pixel not in (24, 32) or (info.red_mask, info.green_mask, info.blue_mask) != (0xff0000, 0xff00, 0xff):
                raise RuntimeError("X11 capture requires a 24/32-bit RGB desktop.")
            raw = C.string_at(info.data, info.bytes_per_line * height)
            step = info.bits_per_pixel // 8
            def rows():
                for row in range(height):
                    source = raw[row * info.bytes_per_line:row * info.bytes_per_line + width * step]
                    rgb = bytearray(width * 3)
                    if info.byte_order == 0:
                        rgb[0::3], rgb[1::3], rgb[2::3] = source[2::step], source[1::step], source[0::step]
                    else:
                        offset = step - 3
                        rgb[0::3], rgb[1::3], rgb[2::3] = source[offset::step], source[offset + 1::step], source[offset + 2::step]
                    yield bytes(rgb)
            return base64.b64encode(png(width, height, rows())).decode("ascii")
        finally:
            self.x.XDestroyImage(image)

    def key(self, name, down):
        code = self.x.XKeysymToKeycode(self.display, keysym(name))
        if not code:
            raise RuntimeError("Key is absent from the current X11 layout: " + name)
        if down:
            self.held.add(name)
        if not self.test.XTestFakeKeyEvent(self.display, code, int(down), 0):
            raise RuntimeError("X11 keyboard injection failed.")
        self.x.XSync(self.display, 0)
        if not down:
            self.held.discard(name)

    def map_text_keys(self, assigned, per):
        # Each mapping request makes window managers rebuild their key bindings.
        # Batch adjacent unused codes without touching mapped codes in the gaps.
        codes = sorted(assigned)
        offset = 0
        while offset < len(codes):
            end = offset + 1
            while end < len(codes) and codes[end] == codes[end - 1] + 1:
                end += 1
            symbols = (C.c_ulong * ((end - offset) * per))(
                *(assigned[code] for code in codes[offset:end] for _ in range(per)))
            self.x.XChangeKeyboardMapping(self.display, codes[offset], per, symbols, end - offset)
            offset = end

    def type(self, text):
        minimum, maximum, per = C.c_int(), C.c_int(), C.c_int()
        self.x.XDisplayKeycodes(self.display, C.byref(minimum), C.byref(maximum))
        count = maximum.value - minimum.value + 1
        mapping = self.x.XGetKeyboardMapping(self.display, minimum.value, count, C.byref(per))
        if not mapping:
            raise RuntimeError("Keyboard mapping unavailable.")
        try:
            spare = [minimum.value + index for index in reversed(range(count))
                     if all(mapping[index * per.value + offset] == 0 for offset in range(per.value))]
            if not spare:
                raise RuntimeError("No unused X11 keycode is available for Unicode text input.")
        finally:
            self.x.XFree(mapping)
        offset = 0
        while offset < len(text):
            assigned = {}
            end = offset
            while end < len(text):
                symbol = text_keysym(text[end])
                if symbol not in assigned:
                    if len(assigned) == len(spare):
                        break
                    assigned[symbol] = spare[len(assigned)]
                end += 1
            try:
                # Keep every glyph's mapping stable throughout the batch. Rebinding
                # one code per character races the application's keyboard-map cache.
                self.map_text_keys({code: symbol for symbol, code in assigned.items()}, per.value)
                self.x.XSync(self.display, 0)
                time.sleep(0.01)
                for character in text[offset:end]:
                    code = assigned[text_keysym(character)]
                    self.test.XTestFakeKeyEvent(self.display, code, 1, 0)
                    self.test.XTestFakeKeyEvent(self.display, code, 0, 0)
                    self.x.XFlush(self.display)
                    time.sleep(0.001)
                self.x.XSync(self.display, 0)
                time.sleep(0.1)
            finally:
                for code in assigned.values():
                    self.test.XTestFakeKeyEvent(self.display, code, 0, 0)
                self.map_text_keys({code: 0 for code in assigned.values()}, per.value)
                self.x.XSync(self.display, 0)
            offset = end

    def button(self, name, down):
        if down:
            self.buttons.add(name)
        if not self.test.XTestFakeButtonEvent(self.display, {"left": 1, "middle": 2, "right": 3}[name], int(down), 0):
            raise RuntimeError("X11 mouse injection failed.")
        self.x.XSync(self.display, 0)
        if not down:
            self.buttons.discard(name)

    def execute(self, value):
        action = value["action"]
        if action == "status":
            return dict(platform="linux", backend="x11", available=True)
        if action == "displays":
            return {"displays": self.monitors()}
        if action == "screenshot":
            return {"image": self.capture(value["displayId"])}
        if action == "cursor":
            root, child, rx, ry, wx, wy, mask = C.c_ulong(), C.c_ulong(), C.c_int(), C.c_int(), C.c_int(), C.c_int(), C.c_uint()
            if not self.x.XQueryPointer(self.display, self.root, C.byref(root), C.byref(child), C.byref(rx), C.byref(ry), C.byref(wx), C.byref(wy), C.byref(mask)):
                raise RuntimeError("Pointer is outside this X11 screen.")
            return dict(x=rx.value, y=ry.value)
        if action == "move":
            if not self.test.XTestFakeMotionEvent(self.display, self.screen, round(value["x"]), round(value["y"]), 0):
                raise RuntimeError("X11 pointer injection failed.")
        elif action == "key":
            self.key(value["key"], value["down"])
        elif action == "button":
            self.button(value["button"], value["down"])
        elif action == "type":
            self.type(value["text"])
        elif action == "scroll":
            for axis, positive, negative in [("dy", 5, 4), ("dx", 7, 6)]:
                amount = value[axis]
                for _ in range(max(1, round(abs(amount) / 100)) if amount else 0):
                    code = positive if amount > 0 else negative
                    self.test.XTestFakeButtonEvent(self.display, code, 1, 0)
                    self.test.XTestFakeButtonEvent(self.display, code, 0, 0)
        elif action == "release":
            self.release()
        else:
            raise RuntimeError("Unknown desktop action.")
        self.x.XSync(self.display, 0)
        return {"done": True}

    def release(self):
        for name in list(self.held):
            self.key(name, False)
        for name in list(self.buttons):
            self.button(name, False)

    def close(self):
        try:
            self.release()
        finally:
            self.x.XCloseDisplay(self.display)


def main():
    desktop = None
    try:
        for line in sys.stdin:
            identity = 0
            value = {}
            try:
                if len(line.encode("utf8")) > 100000:
                    raise RuntimeError("Desktop input too large.")
                value = json.loads(line)
                identity = value["id"]
                if desktop is None:
                    if os.environ.get("XDG_SESSION_TYPE") == "wayland" or os.environ.get("WAYLAND_DISPLAY"):
                        from linux_wayland import WaylandDesktop
                        desktop = WaylandDesktop(keysym, text_keysym)
                    else:
                        desktop = X11Desktop()
                result = desktop.execute(value)
                print(json.dumps(dict(id=identity, result=result), ensure_ascii=True), flush=True)
            except Exception as error:
                if value.get("action") == "status":
                    print(json.dumps(dict(id=identity, result=dict(platform="linux", available=False, error=str(error)))), flush=True)
                else:
                    print(json.dumps(dict(id=identity, error=str(error))), flush=True)
    finally:
        if desktop:
            desktop.close()


if __name__ == "__main__":
    main()
