import AppKit
import ApplicationServices
import ScreenCaptureKit

enum DesktopError: Error, CustomStringConvertible {
    case message(String)
    var description: String { switch self { case .message(let text): return text } }
}

@available(macOS 14.0, *)
@main struct MukaiDesktop {
    static var held = Set<String>()
    static var buttons = Set<String>()
    static var lastClick: (String, CGPoint, Double, Int)?
    static let codes: [String: CGKeyCode] = [
        "A":0,"S":1,"D":2,"F":3,"H":4,"G":5,"Z":6,"X":7,"C":8,"V":9,"B":11,
        "Q":12,"W":13,"E":14,"R":15,"Y":16,"T":17,"1":18,"2":19,"3":20,"4":21,
        "6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"O":31,"U":32,"I":34,"P":35,
        "L":37,"J":38,"K":40,"N":45,"M":46,"ENTER":36,"TAB":48,"SPACE":49,
        "BACKSPACE":51,"ESCAPE":53,"SUPER":55,"SHIFT":56,"CAPSLOCK":57,"ALT":58,"CTRL":59,
        "F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,
        "F9":101,"F10":109,"F11":103,"F12":111,"F13":105,"F14":107,"F15":113,
        "F16":106,"F17":64,"F18":79,"F19":80,"F20":90,"HOME":115,"PAGEUP":116,
        "DELETE":117,"END":119,"PAGEDOWN":121,"LEFT":123,"RIGHT":124,"DOWN":125,"UP":126,
        "INSERT":114
    ]
    static func flags() -> CGEventFlags {
        var value: CGEventFlags = []
        if held.contains("CTRL") { value.insert(.maskControl) }
        if held.contains("ALT") { value.insert(.maskAlternate) }
        if held.contains("SHIFT") { value.insert(.maskShift) }
        if held.contains("SUPER") { value.insert(.maskCommand) }
        return value
    }
    static func key(_ name: String, _ down: Bool) throws {
        guard let code = codes[name] else { throw DesktopError.message("Key is unavailable on macOS: \(name)") }
        if down { held.insert(name) } else { held.remove(name) }
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else {
            throw DesktopError.message("Could not create keyboard event.")
        }
        event.flags = flags()
        event.post(tap: .cghidEventTap)
    }
    static func button(_ name: String, _ down: Bool) throws {
        let position = CGEvent(source: nil)?.location ?? .zero
        let which: CGMouseButton = name == "left" ? .left : name == "right" ? .right : .center
        let type: CGEventType = name == "left" ? (down ? .leftMouseDown : .leftMouseUp) :
            name == "right" ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .otherMouseDown : .otherMouseUp)
        if down { buttons.insert(name) } else { buttons.remove(name) }
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: position, mouseButton: which) else {
            throw DesktopError.message("Could not create mouse event.")
        }
        let now = ProcessInfo.processInfo.systemUptime
        if down {
            let count: Int
            if let previous = lastClick, previous.0 == name, now - previous.2 < 0.5,
               hypot(position.x - previous.1.x, position.y - previous.1.y) < 4 { count = previous.3 + 1 }
            else { count = 1 }
            lastClick = (name, position, now, count)
        }
        event.setIntegerValueField(.mouseEventClickState, value: Int64(lastClick?.3 ?? 1))
        event.flags = flags()
        event.post(tap: .cghidEventTap)
    }
    static func displays() throws -> [[String: Any]] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success else { throw DesktopError.message("Displays unavailable.") }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { throw DesktopError.message("Displays unavailable.") }
        return ids.prefix(Int(count)).map { id in
            let bounds = CGDisplayBounds(id)
            return ["id": String(id), "name": "Display \(id)", "x": bounds.origin.x, "y": bounds.origin.y,
                    "width": bounds.width, "height": bounds.height, "pixelWidth": CGDisplayPixelsWide(id),
                    "pixelHeight": CGDisplayPixelsHigh(id), "primary": id == CGMainDisplayID()]
        }
    }
    static func capture(_ id: String) async throws -> String {
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
            throw DesktopError.message("Allow Screen Recording for Mukai’s desktop helper in System Settings → Privacy & Security, then restart Mukai.")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { String($0.displayID) == id }) else { throw DesktopError.message("Display not found.") }
        let config = SCStreamConfiguration()
        config.width = display.width
        config.height = display.height
        guard config.width * config.height <= 40000000 else { throw DesktopError.message("Display exceeds 40 million pixels.") }
        config.showsCursor = false
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let bytes = bitmap.representation(using: .png, properties: [:]) else { throw DesktopError.message("PNG encoding failed.") }
        return bytes.base64EncodedString()
    }
    static func release() {
        for name in Array(held) { try? key(name, false) }
        for name in Array(buttons) { try? button(name, false) }
    }
    static func execute(_ input: [String: Any]) async throws -> [String: Any] {
        let action = input["action"] as? String ?? ""
        if action == "status" {
            return ["platform": "macos", "backend": "coregraphics/screencapturekit",
                    "available": AXIsProcessTrusted() && CGPreflightScreenCaptureAccess(),
                    "permissions": ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]]
        }
        if action == "displays" { return ["displays": try displays()] }
        if action == "screenshot" { return ["image": try await capture(input["displayId"] as? String ?? "")] }
        if action == "release" { release(); return ["done": true] }
        if !AXIsProcessTrusted() {
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            throw DesktopError.message("Allow Accessibility for Mukai’s desktop helper in System Settings → Privacy & Security.")
        }
        switch action {
        case "cursor":
            let point = CGEvent(source: nil)?.location ?? .zero
            return ["x": point.x, "y": point.y]
        case "move":
            let point = CGPoint(x: (input["x"] as? NSNumber)?.doubleValue ?? 0, y: (input["y"] as? NSNumber)?.doubleValue ?? 0)
            let which: CGMouseButton = buttons.contains("left") ? .left : buttons.contains("right") ? .right : .center
            let type: CGEventType = buttons.contains("left") ? .leftMouseDragged : buttons.contains("right") ? .rightMouseDragged : buttons.contains("middle") ? .otherMouseDragged : .mouseMoved
            guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: which) else { throw DesktopError.message("Pointer event failed.") }
            event.flags = flags()
            event.post(tap: .cghidEventTap)
        case "key": try key(input["key"] as? String ?? "", input["down"] as? Bool ?? false)
        case "button": try button(input["button"] as? String ?? "left", input["down"] as? Bool ?? false)
        case "type":
            for character in input["text"] as? String ?? "" {
                let units = Array(String(character).utf16)
                for down in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { throw DesktopError.message("Text event failed.") }
                    units.withUnsafeBufferPointer { buffer in
                        event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
                    }
                    event.flags = []
                    event.post(tap: .cghidEventTap)
                }
            }
        case "scroll":
            let dx = (input["dx"] as? NSNumber)?.int32Value ?? 0
            let dy = (input["dy"] as? NSNumber)?.int32Value ?? 0
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0) else { throw DesktopError.message("Scroll event failed.") }
            event.flags = flags()
            event.post(tap: .cghidEventTap)
        default: throw DesktopError.message("Unknown desktop action.")
        }
        return ["done": true]
    }
    static func main() async {
        defer { release() }
        while let line = readLine() {
            var id: Any = 0
            var response: [String: Any]
            do {
                guard line.utf8.count <= 100000, let data = line.data(using: .utf8),
                      let input = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw DesktopError.message("Invalid desktop input.") }
                id = input["id"] ?? 0
                response = ["id": id, "result": try await execute(input)]
            } catch { response = ["id": id, "error": String(describing: error)] }
            if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]), let output = String(data: data, encoding: .utf8) { print(output); fflush(stdout) }
        }
    }
}
