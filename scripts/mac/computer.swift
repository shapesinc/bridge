// One bounded request, invoked only by the authenticated Bridge service.
// OS consent is checked here, in the process that captures/posts the events.
import AppKit
import ApplicationServices
import Carbon
import ScreenCaptureKit
import CoreImage

struct ControlError: Error { let code: String; let message: String }
func fail(_ code: String, _ message: String) -> ControlError { ControlError(code: code, message: message) }
func rectangle(_ rect: CGRect) -> [String: Double] { ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height] }

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

@available(macOS 12.3, *) @MainActor
func observe(_ request: [String: Any]) async throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else { throw fail("screen_recording_denied", "Allow Screen Recording in the Mac app's computer setup.") }
    let app = try activeApp()
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let displayID = (request["display_id"] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
    guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
        throw fail("display_unavailable", "That display is unavailable. Observe an available display.")
    }
    let bounds = CGDisplayBounds(displayID)
    let scale = min(1, 1600 / max(bounds.width, bounds.height))
    let config = SCStreamConfiguration()
    config.width = max(1, Int((bounds.width * scale).rounded()))
    config.height = max(1, Int((bounds.height * scale).rounded()))
    config.showsCursor = true; config.queueDepth = 1
    config.pixelFormat = kCVPixelFormatType_32BGRA
    let receiver = FrameReceiver()
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let stream = SCStream(filter: filter, configuration: config, delegate: nil)
    try stream.addStreamOutput(receiver, type: .screen, sampleHandlerQueue: DispatchQueue(label: "shapes.computer.frame"))
    try await stream.startCapture()
    let image: CGImage
    do { image = try await receiver.frame() }
    catch { try? await stream.stopCapture(); throw error }
    try await stream.stopCapture()
    guard (try activeApp()).processIdentifier == app.processIdentifier, CGDisplayBounds(displayID) == bounds else {
        throw fail("desktop_changed", "The active app or display changed during capture. Observe again.")
    }
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.8]), jpeg.count <= 3_000_000 else {
        throw fail("capture_failed", "Could not produce a bounded screenshot.")
    }
    return ["width": image.width, "height": image.height, "display_id": displayID, "bounds": rectangle(bounds),
            "displays": content.displays.map { ["id": $0.displayID, "bounds": rectangle(CGDisplayBounds($0.displayID))] as [String: Any] },
            "frontmost": ["pid": app.processIdentifier, "bundle_id": app.bundleIdentifier ?? "", "name": app.localizedName ?? ""],
            "image_base64": jpeg.base64EncodedString(), "image_content_type": "image/jpeg"]
}

@MainActor
func input(_ request: [String: Any]) throws -> [String: Any] {
    guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw fail("accessibility_denied", "Allow Keyboard and mouse in the Mac app's computer setup.") }
    guard CGPreflightScreenCaptureAccess() else { throw fail("screen_recording_denied", "Screen Recording is required to observe the target before input.") }
    guard !IsSecureEventInputEnabled() else { throw fail("secure_input", "Secure input is active. The person must complete that interaction.") }
    let app = try activeApp()
    guard let expected = request["expected"] as? [String: Any],
          let pid = expected["pid"] as? Int32, app.processIdentifier == pid,
          let displayID = (expected["display_id"] as? NSNumber)?.uint32Value,
          let bounds = expected["bounds"] as? [String: Double], bounds == rectangle(CGDisplayBounds(displayID)),
          CGDisplayIsActive(displayID) != 0,
          let width = expected["width"] as? Double, let height = expected["height"] as? Double, width > 0, height > 0 else {
        throw fail("desktop_changed", "The observed app or display changed. Observe again before input.")
    }
    let rect = CGDisplayBounds(displayID)
    func point(_ name: String) throws -> CGPoint {
        guard let p = request[name] as? [Double], p.count == 2, p.allSatisfy({ $0.isFinite }),
              p[0] >= 0, p[0] < width, p[1] >= 0, p[1] < height else {
            throw fail("invalid_arguments", "Use coordinates inside the observed image.")
        }
        return CGPoint(x: rect.minX + p[0] * rect.width / width, y: rect.minY + p[1] * rect.height / height)
    }
    let source = CGEventSource(stateID: .privateState)
    func postKey(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags = []) {
        let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)!
        event.flags = flags; event.post(tap: .cghidEventTap)
        // Give WindowServer a distinct key transition before releasing it.
        Thread.sleep(forTimeInterval: 0.02)
    }
    func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left, count: Int64 = 1) {
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)!
        event.setIntegerValueField(.mouseEventClickState, value: count); event.post(tap: .cghidEventTap)
    }
    switch request["operation"] as? String {
    case "click":
        let p = try point("point"), right = request["button"] as? String == "right"
        let count = request["click_count"] as? Int ?? 1
        guard (1...2).contains(count) else { throw fail("invalid_arguments", "Use one or two clicks.") }
        for i in 1...count {
            mouse(right ? .rightMouseDown : .leftMouseDown, p, right ? .right : .left, count: Int64(i))
            Thread.sleep(forTimeInterval: 0.04)
            mouse(right ? .rightMouseUp : .leftMouseUp, p, right ? .right : .left, count: Int64(i))
            Thread.sleep(forTimeInterval: 0.04)
        }
    case "move": mouse(.mouseMoved, try point("point"))
    case "drag":
        let start = try point("point"), end = try point("to")
        mouse(.leftMouseDown, start)
        defer { mouse(.leftMouseUp, end) }
        for i in 1...20 {
            let t = Double(i) / 20
            mouse(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t))
            Thread.sleep(forTimeInterval: 0.015)
        }
    case "scroll":
        let p = try point("point")
        guard let dx = request["dx"] as? Int32, let dy = request["dy"] as? Int32, abs(Int(dx)) <= 2000, abs(Int(dy)) <= 2000 else {
            throw fail("invalid_arguments", "Scroll deltas must be between -2000 and 2000 pixels.")
        }
        mouse(.mouseMoved, p)
        CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)!.post(tap: .cghidEventTap)
    case "type":
        guard let text = request["text"] as? String, !text.isEmpty, text.utf16.count <= 4096 else { throw fail("invalid_arguments", "Supply at most 4096 UTF-16 units of text.") }
        // Unicode events do not overwrite the person's clipboard. Split on
        // Characters so surrogate pairs/graphemes are never split between events.
        var chunk: [UniChar] = []
        func send() {
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)!
                chunk.withUnsafeBufferPointer { e.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress!) }
                e.post(tap: .cghidEventTap)
            }
            chunk.removeAll(); Thread.sleep(forTimeInterval: 0.01)
        }
        for character in text {
            let units = Array(String(character).utf16)
            guard units.count <= 20 else { throw fail("invalid_arguments", "A text character exceeds the event size limit.") }
        }
        for character in text { let units = Array(String(character).utf16); if chunk.count + units.count > 20 { send() }; chunk += units }
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
    // CGEvent posting is asynchronous. A short-lived helper must not exit while
    // WindowServer is still accepting its final events (short key actions were
    // lost in signed acceptance). This grace period is not delivery verification;
    // callers must still observe the intended effect and must never replay input.
    Thread.sleep(forTimeInterval: 0.1)
    return ["dispatched": true, "delivery_verified": false, "source_pid": getpid(),
            "message": "Events were posted. Observe again to verify the result; this receipt alone does not prove the intended effect."]
}

@main struct ComputerMain {
    @MainActor static func main() async {
        var reply: [String: Any]
        do {
            let data = FileHandle.standardInput.readData(ofLength: 32769)
            guard data.count <= 32768, let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw fail("invalid_arguments", "Invalid computer request.") }
            if request["operation"] as? String == "observe" {
                guard #available(macOS 12.3, *) else { throw fail("unsupported", "Screen control requires macOS 12.3 or newer.") }
                reply = ["success": true, "result": try await observe(request)]
            } else { reply = ["success": true, "result": try input(request)] }
        } catch let error as ControlError { reply = ["success": false, "error_type": error.code, "error": error.message, "dispatched": false] }
        catch { reply = ["success": false, "error_type": "native_control_failed", "error": "Computer control failed. Observe again or check the Mac app's permissions."] }
        let out = try! JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys])
        FileHandle.standardOutput.write(out); FileHandle.standardOutput.write(Data([10]))
    }
}
