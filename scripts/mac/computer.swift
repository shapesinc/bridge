// One bounded request, invoked only by the authenticated Bridge service.
// OS consent is checked here, in the process that captures/posts the events.
//
// Input is background-only. Events are posted to the observed app's process
// (never to the global HID event stream), so the person's pointer, keyboard
// focus and front app stay theirs while a shape works. Input therefore needs an
// observation of one app or window; a whole-display observation is look-only.
// When an operation can't be delivered this way the helper returns a typed
// blocker. It never falls back to global input.
import AppKit
import ApplicationServices
import Carbon
import ScreenCaptureKit
import CoreImage

struct ControlError: Error { let code: String; let message: String }
func fail(_ code: String, _ message: String) -> ControlError { ControlError(code: code, message: message) }
func rectangle(_ rect: CGRect) -> [String: Double] { ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height] }
func rect(_ value: Any?) -> CGRect? {
    guard let r = value as? [String: Any], let x = r["x"] as? Double, let y = r["y"] as? Double,
          let w = r["width"] as? Double, let h = r["height"] as? Double, [x, y, w, h].allSatisfy(\.isFinite) else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}
func close(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) < 1 && abs(a.minY - b.minY) < 1 && abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1
}
extension CGRect { var area: CGFloat { isNull ? 0 : width * height } }
let maxEdge = 1600.0

@available(macOS 12.3, *)
final class FrameReceiver: NSObject, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<CGImage, Error>?
    private var waiter: CheckedContinuation<CGImage, Error>?
    func finish(_ result: Result<CGImage, Error>) {
        lock.lock()
        guard self.result == nil else { lock.unlock(); return }
        self.result = result
        let waiter = self.waiter; self.waiter = nil
        lock.unlock()
        waiter?.resume(with: result)
    }
    func frame() async throws -> CGImage {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let result { lock.unlock(); continuation.resume(with: result) }
            else { waiter = continuation; lock.unlock() }
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) { [weak self] in
                self?.finish(.failure(fail("capture_timeout", "Screen capture timed out. Observe again.")))
            }
        }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, buffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue,
              let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
        let ci = CIImage(cvPixelBuffer: pixels)
        guard let image = CIContext().createCGImage(ci, from: ci.extent) else { return }
        finish(.success(image))
    }
}

@MainActor
func activeApp() throws -> NSRunningApplication {
    guard let app = NSWorkspace.shared.frontmostApplication, !app.isTerminated,
          let session = CGSessionCopyCurrentDictionary() as? [String: Any],
          session[kCGSessionOnConsoleKey as String] as? Bool == true,
          (session[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value == getuid() else {
        throw fail("session_unavailable", "Unlock the Mac and use its active desktop before computer control.")
    }
    return app
}
func describe(_ app: NSRunningApplication) -> [String: Any] {
    ["pid": app.processIdentifier, "bundle_id": app.bundleIdentifier ?? "", "name": app.localizedName ?? ""]
}

// This helper and the shape-pointer process share one executable. Neither is
// ever a target, and the pointer is kept out of the shape's own screenshots.
@MainActor
func ownProcesses() -> Set<pid_t> {
    let me = Bundle.main.executableURL?.resolvingSymlinksInPath()
    var pids: Set<pid_t> = [getpid()]
    for app in NSWorkspace.shared.runningApplications where app.executableURL?.resolvingSymlinksInPath() == me { pids.insert(app.processIdentifier) }
    return pids
}

// Window layers a person treats as an app's own UI: normal windows through
// utility panels, plus pop-up menus. Menu-bar extras, the Dock and overlays are
// not part of an app target.
func appLayer(_ layer: Int) -> Bool { (0..<24).contains(layer) || layer == 101 }

struct LiveWindow { let id: CGWindowID; let pid: pid_t; let layer: Int; let frame: CGRect }
// Front-to-back on-screen windows. Window numbers, owners, layers and bounds do
// not need Screen Recording; titles are read through ScreenCaptureKit instead.
func liveWindows() -> [LiveWindow] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    return list.compactMap { info in
        guard let id = info[kCGWindowNumber as String] as? NSNumber, let pid = info[kCGWindowOwnerPID as String] as? NSNumber,
              let layer = info[kCGWindowLayer as String] as? NSNumber,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds),
              ((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0,
              frame.width >= 2, frame.height >= 2 else { return nil }
        return LiveWindow(id: id.uint32Value, pid: pid.int32Value, layer: layer.intValue, frame: frame)
    }
}

@MainActor
func resolveApp(_ query: String) throws -> NSRunningApplication {
    let wanted = query.lowercased(), own = ownProcesses()
    let matches = NSWorkspace.shared.runningApplications.filter { app in
        !app.isTerminated && app.activationPolicy != .prohibited && !own.contains(app.processIdentifier)
            && (app.bundleIdentifier?.lowercased() == wanted || app.localizedName?.lowercased() == wanted)
    }
    guard !matches.isEmpty else {
        throw fail("target_not_found", "That app isn't open. Ask the person before opening it; shapes never open or bring apps forward on their own.")
    }
    guard matches.count == 1 else { throw fail("target_ambiguous", "More than one open app matches. List windows and observe one window_id.") }
    return matches[0]
}

@available(macOS 12.3, *)
func capture(_ filter: SCContentFilter, size: CGSize, source: CGRect? = nil, cursor: Bool) async throws -> CGImage {
    let config = SCStreamConfiguration()
    config.width = Int(size.width); config.height = Int(size.height)
    if let source { config.sourceRect = source }
    config.showsCursor = cursor; config.queueDepth = 1
    config.pixelFormat = kCVPixelFormatType_32BGRA
    let receiver = FrameReceiver()
    let stream = SCStream(filter: filter, configuration: config, delegate: nil)
    try stream.addStreamOutput(receiver, type: .screen, sampleHandlerQueue: DispatchQueue(label: "shapes.computer.frame"))
    try await stream.startCapture()
    let image: CGImage
    do { image = try await receiver.frame() }
    catch { try? await stream.stopCapture(); throw error }
    try await stream.stopCapture()
    return image
}

// Image size for a captured rect: at most the display's pixel density, and
// never more than the model's 1600 px edge. Coordinates map back linearly.
@MainActor
func pixelSize(_ bounds: CGRect, display: CGDirectDisplayID) -> CGSize {
    let key = NSDeviceDescriptionKey("NSScreenNumber")
    let backing = NSScreen.screens.first { ($0.deviceDescription[key] as? NSNumber)?.uint32Value == display }?.backingScaleFactor ?? 1
    let scale = min(backing, maxEdge / max(bounds.width, bounds.height))
    return CGSize(width: max(1, (bounds.width * scale).rounded()), height: max(1, (bounds.height * scale).rounded()))
}

func jpeg(_ image: CGImage) throws -> String {
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.8]), data.count <= 3_000_000 else {
        throw fail("capture_failed", "Could not produce a bounded screenshot.")
    }
    return data.base64EncodedString()
}

@available(macOS 12.3, *) @MainActor
func observe(_ request: [String: Any]) async throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else { throw fail("screen_recording_denied", "Allow Screen Recording in the Mac app's computer setup.") }
    let front = try activeApp()
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let own = ownProcesses()
    let displays = content.displays.map { ["id": $0.displayID, "bounds": rectangle(CGDisplayBounds($0.displayID))] as [String: Any] }
    if request["app"] != nil || request["window_id"] != nil {
        return try await observeTarget(request, content: content, own: own, front: front, displays: displays)
    }
    let displayID = (request["display_id"] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
    guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
        throw fail("display_unavailable", "That display is unavailable. Observe an available display.")
    }
    let bounds = CGDisplayBounds(displayID)
    let scale = min(1, maxEdge / max(bounds.width, bounds.height))
    let size = CGSize(width: max(1, (bounds.width * scale).rounded()), height: max(1, (bounds.height * scale).rounded()))
    let pointer = content.windows.filter { $0.owningApplication.map { own.contains($0.processID) } ?? false }
    let image = try await capture(SCContentFilter(display: display, excludingWindows: pointer), size: size, cursor: true)
    guard (try activeApp()).processIdentifier == front.processIdentifier, CGDisplayBounds(displayID) == bounds else {
        throw fail("desktop_changed", "The active app or display changed during capture. Observe again.")
    }
    return ["width": image.width, "height": image.height, "display_id": displayID, "bounds": rectangle(bounds),
            "displays": displays, "frontmost": describe(front), "input": "look_only",
            "image_base64": try jpeg(image), "image_content_type": "image/jpeg"]
}

@available(macOS 12.3, *) @MainActor
func observeTarget(_ request: [String: Any], content: SCShareableContent, own: Set<pid_t>, front: NSRunningApplication,
                   displays: [[String: Any]]) async throws -> [String: Any] {
    let hidden = "isn't on screen. Ask the person before opening, unhiding or bringing anything forward; shapes never do that on their own."
    // Front-to-back, alpha > 0: the same list input re-checks before posting.
    let order = Dictionary(liveWindows().enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { a, _ in a })
    let windows: [SCWindow], filter: SCContentFilter, bounds: CGRect, display: SCDisplay, app: NSRunningApplication, kind: String
    var source: CGRect?
    if let number = request["window_id"] as? NSNumber {
        guard let window = content.windows.first(where: { $0.windowID == number.uint32Value }), window.isOnScreen,
              order[window.windowID] != nil, appLayer(window.windowLayer),
              let owner = window.owningApplication, !own.contains(owner.processID),
              let running = NSRunningApplication(processIdentifier: owner.processID), !running.isTerminated,
              let screen = content.displays.max(by: { $0.frame.intersection(window.frame).area < $1.frame.intersection(window.frame).area }),
              screen.frame.intersects(window.frame) else {
            throw fail("target_not_visible", "That window \(hidden)")
        }
        windows = [window]; filter = SCContentFilter(desktopIndependentWindow: window)
        bounds = window.frame; display = screen; app = running; kind = "window"
    } else {
        guard let query = request["app"] as? String else { throw fail("invalid_arguments", "Name one app or window to observe.") }
        app = try resolveApp(query)
        let visible = content.windows.filter {
            $0.owningApplication?.processID == app.processIdentifier && $0.isOnScreen && appLayer($0.windowLayer) && order[$0.windowID] != nil
        }.sorted { order[$0.windowID]! < order[$1.windowID]! }
        guard let lead = visible.first(where: { $0.windowLayer == 0 }) ?? visible.first,
              let screen = content.displays.max(by: { $0.frame.intersection(lead.frame).area < $1.frame.intersection(lead.frame).area }),
              screen.frame.intersects(lead.frame) else {
            throw fail("target_not_visible", "\(app.localizedName ?? "That app") has no window that \(hidden)")
        }
        windows = visible.filter { $0.frame.intersects(screen.frame) }
        // Only this app's windows are composited, so other apps never cover it
        // in the image; its own menus, sheets and popovers are included.
        bounds = windows.reduce(CGRect.null) { $0.union($1.frame) }.intersection(screen.frame)
        filter = SCContentFilter(display: screen, including: windows)
        source = bounds.offsetBy(dx: -screen.frame.minX, dy: -screen.frame.minY)
        display = screen; kind = "app"
    }
    let image = try await capture(filter, size: pixelSize(bounds, display: display.displayID), source: source, cursor: false)
    guard !app.isTerminated else { throw fail("target_changed", "The app closed during capture. List windows again.") }
    let titles = Dictionary(windows.map { ($0.windowID, String(($0.title ?? "").prefix(120))) }, uniquingKeysWith: { a, _ in a })
    var target = describe(app)
    target["kind"] = kind
    if kind == "window", let window = windows.first { target["window_id"] = window.windowID; target["title"] = titles[window.windowID] ?? "" }
    return ["width": image.width, "height": image.height, "display_id": display.displayID, "bounds": rectangle(bounds),
            "displays": displays, "frontmost": describe(front), "input": "background", "target": target,
            "windows": windows.prefix(24).map { ["window_id": $0.windowID, "title": titles[$0.windowID] ?? "", "bounds": rectangle($0.frame)] as [String: Any] },
            "image_base64": try jpeg(image), "image_content_type": "image/jpeg"]
}

// Discovery without pixels: which apps have windows a shape could observe.
@available(macOS 12.3, *) @MainActor
func listWindows() async throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else { throw fail("screen_recording_denied", "Allow Screen Recording in the Mac app's computer setup.") }
    let front = try activeApp()
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let own = ownProcesses()
    let order = Dictionary(liveWindows().enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { a, _ in a })
    var apps: [[String: Any]] = []
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular && !app.isTerminated && !own.contains(app.processIdentifier) {
        let windows = content.windows.filter {
            $0.owningApplication?.processID == app.processIdentifier && $0.windowLayer == 0 && order[$0.windowID] != nil
                && $0.frame.width >= 40 && $0.frame.height >= 40
        }.sorted { order[$0.windowID]! < order[$1.windowID]! }
        var entry = describe(app)
        entry["frontmost"] = app.processIdentifier == front.processIdentifier
        entry["windows"] = windows.prefix(8).map { window -> [String: Any] in
            ["window_id": window.windowID, "title": String((window.title ?? "").prefix(120)), "bounds": rectangle(window.frame)]
        }
        apps.append(entry)
        if apps.count >= 40 { break }
    }
    return ["apps": apps]
}

@MainActor
func input(_ request: [String: Any]) throws -> [String: Any] {
    guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw fail("accessibility_denied", "Allow Keyboard and mouse in the Mac app's computer setup.") }
    guard CGPreflightScreenCaptureAccess() else { throw fail("screen_recording_denied", "Screen Recording is required to observe the target before input.") }
    guard !IsSecureEventInputEnabled() else { throw fail("secure_input", "Secure input is active. The person must complete that interaction.") }
    let front = try activeApp()
    guard let expected = request["expected"] as? [String: Any], let kind = expected["kind"] as? String, ["app", "window"].contains(kind) else {
        throw fail("background_target_required", "Observe the app or window to act in first. A whole-screen view is look-only, so the person's own pointer and keyboard stay theirs.")
    }
    guard let pid = (expected["pid"] as? NSNumber)?.int32Value, let bundle = expected["bundle_id"] as? String,
          let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated, (app.bundleIdentifier ?? "") == bundle,
          let bounds = rect(expected["bounds"]), let width = expected["width"] as? Double, let height = expected["height"] as? Double,
          width > 0, height > 0, let observed = expected["windows"] as? [[String: Any]], !observed.isEmpty else {
        throw fail("target_changed", "The observed app closed or changed. Observe it again before input.")
    }
    let live = liveWindows().filter { $0.pid == pid && appLayer($0.layer) }
    var shift = CGPoint.zero, routed: CGWindowID?
    if kind == "window" {
        // The window may have moved since the image; it must keep its size.
        guard let id = (observed.first?["window_id"] as? NSNumber)?.uint32Value, let was = rect(observed.first?["bounds"]),
              let now = live.first(where: { $0.id == id }),
              abs(now.frame.width - was.width) < 1, abs(now.frame.height - was.height) < 1 else {
            throw fail("target_changed", "The observed window closed or was resized. Observe it again before input.")
        }
        shift = CGPoint(x: now.frame.minX - was.minX, y: now.frame.minY - was.minY); routed = id
    } else {
        // An app image composites every window of the app; any opened, closed
        // or moved window makes its coordinates stale.
        var frames: [CGWindowID: CGRect] = [:]
        for w in observed { if let id = (w["window_id"] as? NSNumber)?.uint32Value, let frame = rect(w["bounds"]) { frames[id] = frame } }
        let current = live.filter { $0.frame.intersects(bounds) }
        guard frames.count == observed.count, Set(current.map(\.id)) == Set(frames.keys),
              current.allSatisfy({ w in frames[w.id].map { close($0, w.frame) } ?? false }) else {
            throw fail("target_changed", "The app's windows changed since that image. Observe it again before input.")
        }
    }
    func point(_ name: String) throws -> CGPoint {
        guard let p = request[name] as? [Double], p.count == 2, p.allSatisfy({ $0.isFinite }),
              p[0] >= 0, p[0] < width, p[1] >= 0, p[1] < height else {
            throw fail("invalid_arguments", "Use coordinates inside the observed image.")
        }
        return CGPoint(x: bounds.minX + shift.x + p[0] * bounds.width / width, y: bounds.minY + shift.y + p[1] * bounds.height / height)
    }
    // Mouse events name the window they belong to, as WindowServer would for a
    // real click; app images route to the app's topmost window at that point.
    func window(at p: CGPoint) throws -> LiveWindow {
        if let routed, let window = live.first(where: { $0.id == routed }) { return window }
        guard let hit = live.first(where: { $0.frame.contains(p) }) else {
            throw fail("outside_target", "That point isn't on the observed app's window. Use a point inside its UI.")
        }
        return hit
    }
    let source = CGEventSource(stateID: .privateState)
    func post(_ event: CGEvent) { event.postToPid(pid) }
    func postKey(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags = []) {
        let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)!
        event.flags = flags; post(event)
        Thread.sleep(forTimeInterval: 0.02)
    }
    // WindowServer does not route events posted to a process, so each carries
    // its target process and window, and from macOS 27 its window-local point.
    func route(_ event: CGEvent, _ p: CGPoint, _ window: LiveWindow) {
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.id))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.id))
        windowLocationStamp?(event, CGPoint(x: p.x - window.frame.minX, y: p.y - window.frame.minY))
    }
    func mouse(_ type: CGEventType, _ p: CGPoint, window: LiveWindow, _ button: CGMouseButton = .left, count: Int64 = 1) {
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button)!
        event.setIntegerValueField(.mouseEventClickState, value: count)
        route(event, p, window); post(event)
    }
    // A leading move lets background controls track the point before a press.
    func primer(_ p: CGPoint, _ window: LiveWindow) { mouse(.mouseMoved, p, window: window); Thread.sleep(forTimeInterval: 0.03) }
    let ax = BackgroundAccessibility(pid: pid)
    var pointer: [String: Any] = [:], via = "events"
    // Keys reach the app's key window. With a window target that must be the
    // observed window, or the text would land somewhere the shape can't see.
    // Making it the app's main window changes nothing outside that app: the
    // app stays inactive and the person's front app keeps focus.
    if ["type", "press_key"].contains(request["operation"] as? String ?? ""), kind == "window",
       let target = live.first(where: { $0.id == routed }), !ax.focused(in: target.frame),
       !(ax.makeMain(target.frame) && ax.focused(in: target.frame)) {
        throw fail("target_not_focused", "Keys would go to another window of this app. Click a field in the observed window first.")
    }
    switch request["operation"] as? String {
    case "click":
        let p = try point("point"), w = try window(at: p), right = request["button"] as? String == "right"
        let count = request["click_count"] as? Int ?? 1
        guard (1...2).contains(count) else { throw fail("invalid_arguments", "Use one or two clicks.") }
        pointer = ["x": p.x, "y": p.y]
        // A click into another of the app's windows makes it that app's main
        // window, as a real click would, without activating the app.
        if !ax.focused(in: w.frame) { _ = ax.makeMain(w.frame) }
        // Accessibility first: text views ignore clicks into an inactive app,
        // and a press or caret needs no pointer at all. Once a press was sent
        // its outcome is the receipt's; never repeat it as mouse events.
        if !right, let element = ax.element(at: p, in: w.frame) {
            if ax.editable(element), let index = ax.index(element, at: p),
               let range = count == 2 ? ax.word(element, at: index) : NSRange(location: index, length: 0),
               ax.select(element, range) { via = "accessibility" }
            else if count == 1, let control = ax.pressable(element), ax.press(control) { via = "accessibility" }
        }
        if via == "events" {
            primer(p, w)
            for i in 1...count {
                mouse(right ? .rightMouseDown : .leftMouseDown, p, window: w, right ? .right : .left, count: Int64(i))
                Thread.sleep(forTimeInterval: 0.04)
                mouse(right ? .rightMouseUp : .leftMouseUp, p, window: w, right ? .right : .left, count: Int64(i))
                Thread.sleep(forTimeInterval: 0.04)
            }
        }
    case "move":
        let p = try point("point")
        mouse(.mouseMoved, p, window: try window(at: p))
        pointer = ["x": p.x, "y": p.y]
    case "drag":
        // Drags stay inside the app. Selecting text uses Accessibility; other
        // drags are posted to the app's own event queue. Moving windows or
        // dropping onto another app needs the real pointer and isn't attempted.
        let start = try point("point"), end = try point("to"), w = try window(at: start)
        pointer = ["x": start.x, "y": start.y, "to_x": end.x, "to_y": end.y]
        if let a = ax.element(at: start, in: w.frame), ax.editable(a), let b = ax.element(at: end, in: w.frame), CFEqual(a, b),
           let i = ax.index(a, at: start), let j = ax.index(b, at: end),
           ax.select(a, NSRange(location: min(i, j), length: abs(j - i))) { via = "accessibility" }
        else {
            primer(start, w)
            mouse(.leftMouseDown, start, window: w)
            defer { mouse(.leftMouseUp, end, window: w) }
            for i in 1...20 {
                let t = Double(i) / 20
                mouse(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t), window: w)
                Thread.sleep(forTimeInterval: 0.015)
            }
        }
    case "scroll":
        let p = try point("point"), w = try window(at: p)
        guard let dx = request["dx"] as? Int32, let dy = request["dy"] as? Int32, abs(Int(dx)) <= 2000, abs(Int(dy)) <= 2000 else {
            throw fail("invalid_arguments", "Scroll deltas must be between -2000 and 2000 pixels.")
        }
        primer(p, w)
        let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)!
        event.location = p
        route(event, p, w); post(event)
        pointer = ["x": p.x, "y": p.y]
    case "type":
        guard let text = request["text"] as? String, !text.isEmpty, text.utf16.count <= 4096 else { throw fail("invalid_arguments", "Supply at most 4096 UTF-16 units of text.") }
        // Unicode events do not overwrite the person's clipboard. Split on
        // Characters so surrogate pairs/graphemes are never split between events.
        var chunk: [UniChar] = []
        func send() {
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)!
                chunk.withUnsafeBufferPointer { e.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress!) }
                post(e)
            }
            chunk.removeAll(); Thread.sleep(forTimeInterval: 0.01)
        }
        for character in text {
            let units = Array(String(character).utf16)
            guard units.count <= 20 else { throw fail("invalid_arguments", "A text character exceeds the event size limit.") }
        }
        // Apps drop a Unicode event that carries a line break or tab, so
        // those are sent as real Return/Tab presses between text chunks.
        for character in text {
            if character == "\n" || character == "\r\n" || character == "\r" || character == "\t" {
                if !chunk.isEmpty { send() }
                postKey(character == "\t" ? 48 : 36, true); postKey(character == "\t" ? 48 : 36, false)
                continue
            }
            let units = Array(String(character).utf16)
            if chunk.count + units.count > 20 { send() }
            chunk += units
        }
        if !chunk.isEmpty { send() }
    case "press_key":
        let keys: [String: CGKeyCode] = ["A":0,"S":1,"D":2,"F":3,"H":4,"G":5,"Z":6,"X":7,"C":8,"V":9,"B":11,"Q":12,"W":13,"E":14,"R":15,"Y":16,"T":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"O":31,"U":32,"I":34,"P":35,"RETURN":36,"L":37,"J":38,"K":40,"N":45,"M":46,"TAB":48,"SPACE":49,"BACKSPACE":51,"ESCAPE":53,"HOME":115,"PAGEUP":116,"DELETE":117,"END":119,"PAGEDOWN":121,"LEFT":123,"RIGHT":124,"DOWN":125,"UP":126,"F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111]
        let modifiers: [String: (CGKeyCode, CGEventFlags)] = ["CMD":(55,.maskCommand),"SHIFT":(56,.maskShift),"ALT":(58,.maskAlternate),"CTRL":(59,.maskControl)]
        guard let chord = request["keys"] as? [String], let last = chord.last, let code = keys[last], chord.count <= 5,
              Set(chord).count == chord.count, chord.dropLast().allSatisfy({ modifiers[$0] != nil }) else { throw fail("invalid_arguments", "Use modifiers CMD/CTRL/ALT/SHIFT followed by one supported key.") }
        var flags: CGEventFlags = []
        for name in chord.dropLast() { let (key, flag) = modifiers[name]!; flags.insert(flag); postKey(key, true, flags) }
        postKey(code, true, flags); postKey(code, false, flags)
        for name in chord.dropLast().reversed() { let (key, flag) = modifiers[name]!; flags.remove(flag); postKey(key, false, flags) }
    default: throw fail("invalid_arguments", "Unsupported computer operation.")
    }
    // Posting is asynchronous. A short-lived helper must not exit while the
    // target is still accepting its final events. This grace period is not
    // delivery verification; callers must still observe the intended effect
    // and must never replay input.
    Thread.sleep(forTimeInterval: 0.1)
    var reply: [String: Any] = ["dispatched": true, "delivery_verified": false, "delivery": "background", "via": via, "source_pid": getpid(),
                                "message": "Sent to the app in the background. Observe again to verify the result; this receipt alone does not prove the intended effect."]
    if !pointer.isEmpty { reply["pointer"] = pointer }
    // Background delivery never changes the person's front app. Report it if
    // the app brought itself forward in response anyway.
    if front.processIdentifier != pid, let now = NSWorkspace.shared.frontmostApplication, now.processIdentifier == pid { reply["frontmost_changed"] = describe(now) }
    return reply
}

typealias WindowLocationStamp = @convention(c) (CGEvent, CGPoint) -> Void
// From macOS 27, WindowServer reads a process-posted mouse event's window
// location as window-local; earlier releases derive it from the screen point.
// The setter is not in the public SDK, so it is optional.
let windowLocationStamp: WindowLocationStamp? = {
    guard ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 27,
          let symbol = dlsym(dlopen(nil, RTLD_NOW), "CGEventSetWindowLocation") else { return nil }
    return unsafeBitCast(symbol, to: WindowLocationStamp.self)
}()

// Accessibility acts on the observed app's own element at a point. It
// hit-tests inside that app, so other apps covering it don't matter, and it
// never touches the person's pointer, keyboard focus or front app.
struct BackgroundAccessibility {
    let pid: pid_t, app: AXUIElement
    init(pid: pid_t) {
        self.pid = pid; app = AXUIElementCreateApplication(pid)
        // A busy app must not stall the bounded helper.
        AXUIElementSetMessagingTimeout(app, 2)
    }
    func value(_ e: AXUIElement, _ name: String) -> AnyObject? {
        var v: AnyObject?
        return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
    }
    func element(_ v: AnyObject?) -> AXUIElement? {
        guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }
    func frame(_ e: AXUIElement) -> CGRect? {
        guard let p = value(e, kAXPositionAttribute), let s = value(e, kAXSizeAttribute),
              CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &origin), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: origin, size: size)
    }
    func settable(_ e: AXUIElement, _ name: String) -> Bool {
        var result: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(e, name as CFString, &result) == .success && result.boolValue
    }
    // The app's element at a point, only if it is in the observed window.
    func element(at p: CGPoint, in window: CGRect) -> AXUIElement? {
        var hit: AXUIElement?, owner: pid_t = 0
        guard AXUIElementCopyElementAtPosition(app, Float(p.x), Float(p.y), &hit) == .success, let hit,
              AXUIElementGetPid(hit, &owner) == .success, owner == pid else { return nil }
        if let w = element(value(hit, kAXWindowAttribute)), let f = frame(w), !close(f, window) { return nil }
        return hit
    }
    func editable(_ e: AXUIElement) -> Bool {
        guard let role = value(e, kAXRoleAttribute) as? String,
              ["AXTextArea", "AXTextField", "AXSearchField", "AXComboBox"].contains(role) else { return false }
        return settable(e, kAXSelectedTextRangeAttribute)
    }
    func index(_ e: AXUIElement, at p: CGPoint) -> Int? {
        var point = p, out: AnyObject?, range = CFRange()
        guard let position = AXValueCreate(.cgPoint, &point),
              AXUIElementCopyParameterizedAttributeValue(e, kAXRangeForPositionParameterizedAttribute as CFString, position, &out) == .success,
              let out, CFGetTypeID(out) == AXValueGetTypeID(), AXValueGetValue(out as! AXValue, .cfRange, &range),
              range.location >= 0 else { return nil }
        return range.location
    }
    func word(_ e: AXUIElement, at index: Int) -> NSRange? {
        guard let text = value(e, kAXValueAttribute) as? String else { return nil }
        let s = text as NSString
        guard s.length <= 1_000_000, index < s.length else { return nil }
        let lower = max(0, index - 200), span = NSRange(location: lower, length: min(s.length, index + 200) - lower)
        var found: NSRange?
        s.enumerateSubstrings(in: span, options: .byWords) { _, r, _, stop in
            if NSLocationInRange(index, r) { found = r; stop.pointee = true }
        }
        return found
    }
    // Whether the app's focused window is the given one (by frame).
    func focused(in window: CGRect) -> Bool {
        guard let w = element(value(app, kAXFocusedWindowAttribute)), let f = frame(w) else { return false }
        return close(f, window)
    }
    func makeMain(_ frame: CGRect) -> Bool {
        guard let windows = value(app, kAXWindowsAttribute) as? [AXUIElement],
              let window = windows.first(where: { self.frame($0).map { close($0, frame) } ?? false }),
              settable(window, kAXMainAttribute) else { return false }
        return AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue) == .success
    }
    // Focus moves inside the app only; an inactive app stays inactive.
    func select(_ e: AXUIElement, _ r: NSRange) -> Bool {
        var range = CFRange(location: r.location, length: r.length)
        guard let value = AXValueCreate(.cfRange, &range) else { return false }
        if settable(e, kAXFocusedAttribute) { AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
        return AXUIElementSetAttributeValue(e, kAXSelectedTextRangeAttribute as CFString, value) == .success
    }
    // The control itself, or the button around a label/icon that was hit.
    func pressable(_ e: AXUIElement) -> AXUIElement? {
        var current: AXUIElement? = e
        for _ in 0..<3 {
            guard let c = current else { return nil }
            var names: CFArray?
            if AXUIElementCopyActionNames(c, &names) == .success, (names as? [String] ?? []).contains(kAXPressAction) { return c }
            guard let role = value(c, kAXRoleAttribute) as? String, ["AXStaticText", "AXImage"].contains(role) else { return nil }
            current = element(value(c, kAXParentAttribute))
        }
        return nil
    }
    // Only an unsupported action means nothing happened. Any other result
    // (including a timeout while the press runs) is a sent press.
    func press(_ e: AXUIElement) -> Bool { AXUIElementPerformAction(e, kAXPressAction as CFString) != .actionUnsupported }
}

@main struct ComputerMain {
    @MainActor static func main() async {
        if CommandLine.arguments.dropFirst().first == "--cursor" { runShapeCursor() }
        var reply: [String: Any]
        do {
            let data = FileHandle.standardInput.readData(ofLength: 32769)
            guard data.count <= 32768, let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw fail("invalid_arguments", "Invalid computer request.") }
            switch request["operation"] as? String {
            case "observe", "windows":
                guard #available(macOS 12.3, *) else { throw fail("unsupported", "Screen control requires macOS 12.3 or newer.") }
                reply = ["success": true, "result": request["operation"] as? String == "windows" ? try await listWindows() : try await observe(request)]
            default: reply = ["success": true, "result": try input(request)]
            }
        } catch let error as ControlError { reply = ["success": false, "error_type": error.code, "error": error.message, "dispatched": false] }
        catch { reply = ["success": false, "error_type": "native_control_failed", "error": "Computer control failed. Observe again or check the Mac app's permissions."] }
        let out = try! JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys])
        FileHandle.standardOutput.write(out); FileHandle.standardOutput.write(Data([10]))
    }
}
