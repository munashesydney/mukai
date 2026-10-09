"""Wayland control through the user-consented RemoteDesktop/ScreenCast portals."""
import base64
import os
import uuid


class WaylandDesktop:
    BUS = "org.freedesktop.portal.Desktop"
    PATH = "/org/freedesktop/portal/desktop"
    REMOTE = "org.freedesktop.portal.RemoteDesktop"
    CAST = "org.freedesktop.portal.ScreenCast"

    def __init__(self, keysym, text_keysym):
        try:
            import gi
            gi.require_version("Gst", "1.0")
            from gi.repository import Gio, GLib, Gst
        except (ImportError, ValueError) as error:
            raise RuntimeError("Wayland requires Python GObject/GStreamer bindings and PipeWire. On Ubuntu/Debian install python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good and your desktop’s xdg-desktop-portal backend.") from error
        self.Gio, self.GLib, self.Gst = Gio, GLib, Gst
        Gst.init(None)
        if not all(Gst.ElementFactory.find(name) for name in ["pipewiresrc", "videoconvert", "pngenc", "appsink"]):
            raise RuntimeError("Wayland capture requires GStreamer pipewiresrc, videoconvert, pngenc and appsink plugins.")
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        devices = self.call("org.freedesktop.DBus.Properties", "Get", "(ss)", (self.REMOTE, "AvailableDeviceTypes")).unpack()[0]
        if int(devices) & 3 != 3:
            raise RuntimeError("This Wayland compositor does not provide keyboard and pointer RemoteDesktop portal support.")
        self.session = None
        self.streams = []
        self.pipelines = {}
        self.frames = {}
        self.fds = {}
        self.position = None
        self.keysym, self.text_keysym = keysym, text_keysym
        self.held, self.buttons = set(), set()
        self.typing_symbols = set()

    def call(self, interface, method, signature, values, path=None):
        return self.bus.call_sync(self.BUS, path or self.PATH, interface, method,
                                  self.GLib.Variant(signature, values), None, self.Gio.DBusCallFlags.NONE, 5000, None)

    def request(self, interface, method, signature, values):
        token = "mukai_" + uuid.uuid4().hex
        values[-1]["handle_token"] = self.GLib.Variant("s", token)
        sender = self.bus.get_unique_name()[1:].replace(".", "_")
        request_path = self.PATH + "/request/" + sender + "/" + token
        result = []
        loop = self.GLib.MainLoop()
        def response(_bus, _sender, _path, _interface, _signal, parameters):
            result.append(parameters.unpack())
            loop.quit()
        subscription = self.bus.signal_subscribe(self.BUS, "org.freedesktop.portal.Request", "Response",
                                                request_path, None, self.Gio.DBusSignalFlags.NONE, response)
        def expire():
            loop.quit()
            return False
        timer = self.GLib.timeout_add(25000, expire)
        try:
            self.call(interface, method, signature, tuple(values))
            if not result:
                loop.run()
            if not result:
                try:
                    self.call("org.freedesktop.portal.Request", "Close", "()", (), request_path)
                except Exception:
                    pass
                raise RuntimeError("Desktop consent timed out. Retry and approve the system screen-sharing dialog.")
            if result[0][0] != 0:
                raise RuntimeError("Desktop sharing was cancelled or denied. Approve the system desktop-control dialog to continue.")
            return result[0][1]
        finally:
            self.bus.signal_unsubscribe(subscription)
            if self.GLib.MainContext.default().find_source_by_id(timer):
                self.GLib.source_remove(timer)

    def start(self):
        if self.session:
            return
        result = self.request(self.REMOTE, "CreateSession", "(a{sv})", [
            {"session_handle_token": self.GLib.Variant("s", "mukai_" + uuid.uuid4().hex)}])
        self.session = result["session_handle"]
        try:
            self.request(self.REMOTE, "SelectDevices", "(oa{sv})", [self.session, {"types": self.GLib.Variant("u", 3)}])
            self.request(self.CAST, "SelectSources", "(oa{sv})", [self.session, {
                "types": self.GLib.Variant("u", 1), "multiple": self.GLib.Variant("b", True),
                "cursor_mode": self.GLib.Variant("u", 1)}])
            result = self.request(self.REMOTE, "Start", "(osa{sv})", [self.session, "", {}])
            if int(result.get("devices", 0)) & 3 != 3 or not result.get("streams"):
                raise RuntimeError("Approve both keyboard/pointer control and at least one display.")
            self.streams = result["streams"]
            self.bus.signal_subscribe(self.BUS, "org.freedesktop.portal.Session", "Closed", self.session,
                                     None, self.Gio.DBusSignalFlags.NONE, self.revoked)
        except Exception:
            self.close()
            raise

    def revoked(self, *_args):
        self.session = None
        self.clear_streams()

    def clear_streams(self):
        for pipeline, _sink in self.pipelines.values():
            pipeline.set_state(self.Gst.State.NULL)
        self.pipelines.clear()
        self.frames.clear()
        self.streams = []
        self.position = None
        for fd in self.fds.values():
            os.close(fd)
        self.fds.clear()
        self.held.clear()
        self.buttons.clear()
        self.typing_symbols.clear()

    def monitors(self):
        output = []
        for index, (node, properties) in enumerate(self.streams):
            width, height = properties.get("logical_size", properties.get("size", (0, 0)))
            x, y = properties.get("position", (0, 0))
            if width <= 0 or height <= 0:
                raise RuntimeError("The compositor did not provide display dimensions.")
            physical = properties.get("size", (width, height))
            output.append(dict(id=str(node), name="Shared display " + str(index + 1), x=x, y=y,
                               width=width, height=height, pixelWidth=physical[0], pixelHeight=physical[1], primary=index == 0))
        return output

    def notify(self, method, signature, *values):
        self.call(self.REMOTE, method, signature, (self.session, {}, *values))

    def key(self, name, down):
        if down:
            self.held.add(name)
        self.notify("NotifyKeyboardKeysym", "(oa{sv}iu)", self.keysym(name), int(down))
        if not down:
            self.held.discard(name)

    def button(self, name, down):
        if down:
            self.buttons.add(name)
        self.notify("NotifyPointerButton", "(oa{sv}iu)", {"left": 0x110, "right": 0x111, "middle": 0x112}[name], int(down))
        if not down:
            self.buttons.discard(name)

    def capture(self, identity):
        node, properties = next(((node, properties) for node, properties in self.streams if str(node) == identity), (None, None))
        if node is None:
            raise RuntimeError("Shared display not found. Call displays again.")
        if identity not in self.pipelines:
            returned, fds = self.bus.call_with_unix_fd_list_sync(self.BUS, self.PATH, self.CAST, "OpenPipeWireRemote",
                self.GLib.Variant("(oa{sv})", (self.session, {})), None, self.Gio.DBusCallFlags.NONE, 5000, None, None)
            fd = fds.get(returned.unpack()[0])
            # Use serial targeting when supplied by modern portals; retain node targeting for older desktops.
            serial = properties.get("pipewire-serial")
            target = str(serial if serial is not None else node)
            if not target.isdigit():
                raise RuntimeError("Invalid PipeWire target.")
            target_property = "target-object=" if serial is not None else "path="
            try:
                pipeline = self.Gst.parse_launch("pipewiresrc fd=" + str(fd) + " " + target_property + target +
                    " do-timestamp=true ! videoconvert ! video/x-raw,format=RGB ! pngenc ! appsink name=capture max-buffers=1 drop=true sync=false")
            except Exception:
                os.close(fd)
                raise
            self.fds[identity] = fd
            sink = pipeline.get_by_name("capture")
            pipeline.set_state(self.Gst.State.PLAYING)
            self.pipelines[identity] = (pipeline, sink)
        _pipeline, sink = self.pipelines[identity]
        _pipeline.set_state(self.Gst.State.PLAYING)
        # Static desktops may emit only on damage. Keep the newest frame while
        # allowing a just-injected action to produce a fresh frame.
        previous = sink.emit("try-pull-sample", 0) or self.frames.get(identity)
        sample = sink.emit("try-pull-sample", (self.Gst.SECOND // 5) if previous else 5 * self.Gst.SECOND) or previous
        _pipeline.set_state(self.Gst.State.PAUSED)
        if sample is None:
            raise RuntimeError("No PipeWire frame arrived. Check desktop sharing and GStreamer plugins.")
        self.frames[identity] = sample
        buffer = sample.get_buffer()
        if buffer.get_size() > 16 * 1024 * 1024:
            raise RuntimeError("Screenshot exceeds 16 MiB.")
        return base64.b64encode(buffer.extract_dup(0, buffer.get_size())).decode("ascii")

    def execute(self, value):
        while self.GLib.MainContext.default().pending():
            self.GLib.MainContext.default().iteration(False)
        action = value["action"]
        if action == "status":
            return dict(platform="linux", backend="wayland-portal", available=True, consentRequired=self.session is None,
                        cursorReadable=False, message="displays/screenshot opens the system desktop-sharing consent dialog if needed.")
        if self.session is None and action == 'key' and not value['down']:
            self.held.discard(value['key'])
            return {'done': True}
        if self.session is None and action == 'button' and not value['down']:
            self.buttons.discard(value['button'])
            return {'done': True}
        if action == 'release':
            self.release()
            return {'done': True}
        self.start()
        if action == "displays":
            return {"displays": self.monitors()}
        if action == "screenshot":
            return {"image": self.capture(value["displayId"])}
        if action == "cursor":
            return dict(known=False, lastRequestedPosition=self.position,
                        message="Wayland does not expose the global cursor. lastRequestedPosition may differ after human input.")
        if action == "move":
            monitor = next(item for item in self.monitors() if item["id"] == value["displayId"])
            self.notify("NotifyPointerMotionAbsolute", "(oa{sv}udd)", int(monitor["id"]),
                        value["x"] - monitor["x"], value["y"] - monitor["y"])
            self.position = dict(x=value["x"], y=value["y"])
        elif action == "key":
            self.key(value["key"], value["down"])
        elif action == "button":
            self.button(value["button"], value["down"])
        elif action == "type":
            for character in value["text"]:
                symbol = self.text_keysym(character)
                self.typing_symbols.add(symbol)
                self.notify("NotifyKeyboardKeysym", "(oa{sv}iu)", symbol, 1)
                self.notify("NotifyKeyboardKeysym", "(oa{sv}iu)", symbol, 0)
                self.typing_symbols.discard(symbol)
        elif action == "scroll":
            self.notify("NotifyPointerAxis", "(oa{sv}dd)", float(value["dx"]), float(value["dy"]))
            self.call(self.REMOTE, "NotifyPointerAxis", "(oa{sv}dd)", (self.session, {"finish": self.GLib.Variant("b", True)}, 0.0, 0.0))
        elif action == "release":
            self.release()
        else:
            raise RuntimeError("Unknown desktop action.")
        return {"done": True}

    def release(self):
        if self.session:
            for symbol in list(self.typing_symbols):
                self.notify("NotifyKeyboardKeysym", "(oa{sv}iu)", symbol, 0)
                self.typing_symbols.discard(symbol)
            for name in list(self.held):
                self.key(name, False)
            for name in list(self.buttons):
                self.button(name, False)

    def close(self):
        try:
            if self.session:
                self.release()
                self.call("org.freedesktop.portal.Session", "Close", "()", (), self.session)
        finally:
            self.session = None
            self.clear_streams()
