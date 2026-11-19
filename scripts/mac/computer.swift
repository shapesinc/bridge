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
    let filter = SCContentFilter(display: display, excludingWindows: content.windows.filter { window in
        // The shape's own pointer is drawn by this executable's --cursor process.
        window.owningApplication.map { owner in
            NSRunningApplication(processIdentifier: owner.processID)?.executableURL?.resolvingSymlinksInPath()
                == Bundle.main.executableURL?.resolvingSymlinksInPath() } ?? false
    })
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

// Whole-screen input is not available on a Mac: it would move the person's
// pointer and type into whatever they have in front. Input goes to one
// observed app's window instead (appInput), in the background.
func wholeScreenInputRefused() -> ControlError {
    fail("background_target_required", "A whole-screen view is look-only on a Mac. Observe the app to act in it; the person's pointer and keyboard stay theirs.")
}


// MARK: - App-scoped background control
//
// These operations act on one named app's window without bringing it forward,
// so the person can keep using the Mac. The window is captured on its own
// (even behind other windows), its accessibility elements are listed with
// indexes, and input goes to that app only: accessibility actions first, then
// events posted to that process. Nothing is ever sent to the frontmost app.

let actionableRoles: Set<String> = ["AXButton", "AXTextField", "AXTextArea", "AXLink", "AXCheckBox", "AXRadioButton",
    "AXMenuItem", "AXMenuButton", "AXPopUpButton", "AXComboBox", "AXRow", "AXCell", "AXTab", "AXTabGroup",
    "AXSearchField", "AXSlider", "AXDisclosureTriangle", "AXOutlineRow", "AXSegment", "AXIncrementor", "AXSecureTextField"]
let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]

func axValue<T>(_ element: AXUIElement, _ attribute: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value as? T
}
func axFrame(_ element: AXUIElement) -> CGRect? {
    var position = CGPoint.zero, size = CGSize.zero
    guard let p: AXValue = axValue(element, kAXPositionAttribute), let s: AXValue = axValue(element, kAXSizeAttribute),
          AXValueGetValue(p, .cgPoint, &position), AXValueGetValue(s, .cgSize, &size) else { return nil }
    return CGRect(origin: position, size: size)
}
func axActions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}
func clip(_ text: String?, _ limit: Int = 80) -> String? {
    guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
    return text.count > limit ? String(text.prefix(limit)) + "…" : text
}

func pause(_ seconds: Double) { usleep(useconds_t(seconds * 1_000_000)) }

@MainActor
func consoleSession() throws {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
          session[kCGSessionOnConsoleKey as String] as? Bool == true,
          (session[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value == getuid() else {
        throw fail("session_unavailable", "Unlock the Mac and use its active desktop before computer control.")
    }
}

@MainActor
func findApp(_ name: String) -> NSRunningApplication? {
    let wanted = name.lowercased()
    let apps = NSWorkspace.shared.runningApplications.filter { !$0.isTerminated && $0.activationPolicy == .regular }
    return apps.first { $0.bundleIdentifier?.lowercased() == wanted }
        ?? apps.first { $0.localizedName?.lowercased() == wanted }
        ?? apps.first { ($0.localizedName?.lowercased() ?? "").hasPrefix(wanted) }
}

@MainActor
func launchInBackground(_ name: String) async throws -> NSRunningApplication {
    let workspace = NSWorkspace.shared
    var url = workspace.urlForApplication(withBundleIdentifier: name)
    if url == nil {
        for dir in ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities",
                    NSHomeDirectory() + "/Applications"] {
            let candidate = URL(fileURLWithPath: dir).appendingPathComponent(name.hasSuffix(".app") ? name : name + ".app")
            if FileManager.default.fileExists(atPath: candidate.path) { url = candidate; break }
        }
    }
    guard let url else { throw fail("app_not_found", "No running or installed app has that name or bundle id. Use operation apps to list running apps.") }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    let app = try await workspace.openApplication(at: url, configuration: configuration)
    // Give the app a moment to create its first window.
    for _ in 0..<25 {
        if axWindows(AXUIElementCreateApplication(app.processIdentifier)).isEmpty == false { break }
        try await Task.sleep(nanoseconds: 200_000_000)
    }
    return app
}

func axWindows(_ appElement: AXUIElement) -> [AXUIElement] {
    (axValue(appElement, kAXWindowsAttribute) as [AXUIElement]?) ?? []
}

// Electron/Chromium apps (Slack, Discord, VS Code...) only expose their
// accessibility tree after a client asks for it.
func enableAccessibilityTree(_ appElement: AXUIElement) {
    AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
}

// The same deterministic walk runs in the observing and the acting process,
// so an index refers to the same element; role and frame are checked again
// before any action.
func collectElements(_ window: AXUIElement, limit: Int = 150) -> [AXUIElement] {
    var found: [AXUIElement] = [], visited = 0
    func walk(_ element: AXUIElement, _ depth: Int) {
        guard found.count < limit, visited < 6000, depth < 60 else { return }
        visited += 1
        let role: String = axValue(element, kAXRoleAttribute) ?? ""
        if actionableRoles.contains(role), let frame = axFrame(element), frame.width >= 2, frame.height >= 2 { found.append(element) }
        let children: [AXUIElement] = axValue(element, kAXChildrenAttribute) ?? []
        for child in children { walk(child, depth + 1) }
    }
    walk(window, 0)
    return found
}

func describe(_ element: AXUIElement) -> [String: Any] {
    let role: String = axValue(element, kAXRoleAttribute) ?? ""
    var entry: [String: Any] = ["role": role.hasPrefix("AX") ? String(role.dropFirst(2)) : role]
    let title = clip(axValue(element, kAXTitleAttribute)) ?? clip(axValue(element, kAXDescriptionAttribute))
        ?? clip(axValue(element, kAXHelpAttribute))
    if let title { entry["label"] = title }
    if role != "AXSecureTextField", let value: String = axValue(element, kAXValueAttribute), let v = clip(value) { entry["value"] = v }
    if let enabled: Bool = axValue(element, kAXEnabledAttribute), !enabled { entry["enabled"] = false }
    return entry
}


// Chromium and Electron apps stop drawing a window that is completely
// covered, so a capture would show an old frame. Such a window is raised with
// the accessibility raise action: it moves just below the active app's front
// window without activating its app, so keyboard focus stays with the person.
func drawsOnlyWhenVisible(_ app: NSRunningApplication) -> Bool {
    guard let url = app.bundleURL?.appendingPathComponent("Contents/Frameworks"),
          let names = try? FileManager.default.contentsOfDirectory(atPath: url.path) else { return false }
    return names.contains { $0.contains("Electron") || $0.contains("Chromium") || $0.contains("Chrome") || $0.contains("Edge") || $0.contains("Brave") }
}
func fullyCovered(_ windowID: CGWindowID, _ frame: CGRect) -> Bool {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow], windowID) as? [[String: Any]] else { return false }
    let covers = list.compactMap { w -> CGRect? in
        guard (w[kCGWindowLayer as String] as? Int) == 0, let b = w[kCGWindowBounds as String] else { return nil }
        return CGRect(dictionaryRepresentation: b as! CFDictionary)
    }
    let screens = NSScreen.screens.map { s -> CGRect in
        // NSScreen is bottom-left based; window bounds are top-left based.
        let h = NSScreen.screens.first?.frame.height ?? 0
        return CGRect(x: s.frame.minX, y: h - s.frame.maxY, width: s.frame.width, height: s.frame.height)
    }
    for i in 0..<12 { for j in 0..<12 {
        let p = CGPoint(x: frame.minX + frame.width * (Double(i) + 0.5) / 12, y: frame.minY + frame.height * (Double(j) + 0.5) / 12)
        if screens.contains(where: { $0.contains(p) }) && !covers.contains(where: { $0.contains(p) }) { return false }
    } }
    return true
}

typealias WindowLocationStamp = @convention(c) (CGEvent, CGPoint) -> Void
// From macOS 27, WindowServer reads a process-posted mouse event's window
// location as window-local; earlier releases derive it from the screen point.
// Without it a background click is dropped. The setter is not in the public
// SDK, so it is optional.
let windowLocationStamp: WindowLocationStamp? = {
    guard ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 27,
          let symbol = dlsym(dlopen(nil, RTLD_NOW), "CGEventSetWindowLocation") else { return nil }
    return unsafeBitCast(symbol, to: WindowLocationStamp.self)
}()
func sameFrame(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) < 2 && abs(a.minY - b.minY) < 2 && abs(a.width - b.width) < 2 && abs(a.height - b.height) < 2
}

struct AppWindow { let app: NSRunningApplication; let appElement: AXUIElement; let window: AXUIElement; let frame: CGRect; let windowID: CGWindowID }

@available(macOS 12.3, *) @MainActor
func resolveWindow(pid: pid_t, windowID: CGWindowID?) async throws -> (AppWindow, SCWindow) {
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
        throw fail("app_closed", "That app is no longer running. Observe it again.")
    }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    let candidates = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0
        && $0.frame.width >= 80 && $0.frame.height >= 60 }
    let chosen = windowID.flatMap { id in candidates.first { $0.windowID == id } }
        ?? candidates.filter { $0.isOnScreen }.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
        ?? candidates.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    guard let window = chosen else {
        throw fail("window_unavailable", "That app has no open window. Use the app's menu (operation menu) or ask the person to open one.")
    }
    if windowID != nil && window.windowID != windowID! { throw fail("desktop_changed", "That window closed. Observe the app again.") }
    let appElement = AXUIElementCreateApplication(pid)
    enableAccessibilityTree(appElement)
    // Match the capture window to its accessibility window by frame.
    let axWindow = axWindows(appElement).min { a, b in
        let fa = axFrame(a) ?? .zero, fb = axFrame(b) ?? .zero
        return abs(fa.minX - window.frame.minX) + abs(fa.minY - window.frame.minY) + abs(fa.width - window.frame.width)
            < abs(fb.minX - window.frame.minX) + abs(fb.minY - window.frame.minY) + abs(fb.width - window.frame.width)
    } ?? appElement
    return (AppWindow(app: app, appElement: appElement, window: axWindow, frame: window.frame, windowID: window.windowID), window)
}

@available(macOS 12.3, *) @MainActor
func listApps() async throws -> [String: Any] {
    try consoleSession()
    guard CGPreflightScreenCaptureAccess() else { throw fail("screen_recording_denied", "Allow Screen Recording in the Mac app's computer setup.") }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let apps = NSWorkspace.shared.runningApplications.filter { !$0.isTerminated && $0.activationPolicy == .regular }.prefix(60)
    return ["apps": apps.map { app -> [String: Any] in
        let windows = content.windows.filter { $0.owningApplication?.processID == app.processIdentifier && $0.windowLayer == 0
            && $0.frame.width >= 80 && $0.frame.height >= 60 }.prefix(8).map { w -> [String: Any] in
            var entry: [String: Any] = ["window_id": Int(w.windowID), "on_screen": w.isOnScreen]
            if let title = clip(w.title) { entry["title"] = title }
            return entry
        }
        var entry: [String: Any] = ["name": app.localizedName ?? "", "bundle_id": app.bundleIdentifier ?? "",
            "frontmost": app.processIdentifier == front, "windows": Array(windows)]
        if app.isHidden { entry["hidden"] = true }
        return entry
    }]
}

@available(macOS 12.3, *) @MainActor
func observeApp(_ request: [String: Any]) async throws -> [String: Any] {
    try consoleSession()
    guard CGPreflightScreenCaptureAccess() else { throw fail("screen_recording_denied", "Allow Screen Recording in the Mac app's computer setup.") }
    guard AXIsProcessTrusted() else { throw fail("accessibility_denied", "Allow Keyboard and mouse in the Mac app's computer setup.") }
    guard let name = request["app"] as? String else { throw fail("invalid_arguments", "Name the app to observe.") }
    var launched = false
    let app: NSRunningApplication
    if let running = findApp(name) { app = running } else { app = try await launchInBackground(name); launched = true }
    if app.isHidden { app.unhide() }
    let windowID = (request["window_id"] as? NSNumber).map { CGWindowID($0.uint32Value) }
    var resolved: (AppWindow, SCWindow)?
    for attempt in 0..<(launched ? 10 : 1) {
        do { resolved = try await resolveWindow(pid: app.processIdentifier, windowID: windowID); break }
        catch let error as ControlError where error.code == "window_unavailable" && attempt < 9 && launched {
            try await Task.sleep(nanoseconds: 300_000_000)
        }
    }
    guard var (target, scWindow) = resolved else { throw fail("window_unavailable", "That app has no open window yet. Observe it again shortly.") }
    var raised = false
    if drawsOnlyWhenVisible(app), fullyCovered(target.windowID, target.frame),
       AXUIElementPerformAction(target.window, kAXRaiseAction as CFString) == .success {
        raised = true
        try await Task.sleep(nanoseconds: 700_000_000)
        (target, scWindow) = try await resolveWindow(pid: app.processIdentifier, windowID: target.windowID)
    }
    // Let a just-enabled Electron accessibility tree populate.
    if collectElements(target.window, limit: 1).isEmpty { try await Task.sleep(nanoseconds: 400_000_000) }
    let frame = target.frame
    let scale = min(1, 1600 / max(frame.width, frame.height))
    let config = SCStreamConfiguration()
    config.width = max(1, Int((frame.width * scale).rounded()))
    config.height = max(1, Int((frame.height * scale).rounded()))
    config.showsCursor = false; config.queueDepth = 1
    config.pixelFormat = kCVPixelFormatType_32BGRA
    let receiver = FrameReceiver()
    let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: scWindow), configuration: config, delegate: nil)
    try stream.addStreamOutput(receiver, type: .screen, sampleHandlerQueue: DispatchQueue(label: "shapes.computer.window"))
    try await stream.startCapture()
    let image: CGImage
    do { image = try await receiver.frame() }
    catch {
        try? await stream.stopCapture()
        throw fail("window_unavailable", "The window could not be captured (it may be minimized or on another desktop). Use operation menu, or ask the person to show it.")
    }
    try await stream.stopCapture()
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.8]), jpeg.count <= 3_000_000 else {
        throw fail("capture_failed", "Could not produce a bounded screenshot.")
    }
    let sx = Double(image.width) / frame.width, sy = Double(image.height) / frame.height
    let elements = collectElements(target.window)
    var listed: [[String: Any]] = [], identities: [[String: Any]] = []
    for (index, element) in elements.enumerated() {
        guard let f = axFrame(element) else { continue }
        var entry = describe(element)
        entry["index"] = index
        entry["frame"] = [((f.minX - frame.minX) * sx).rounded(), ((f.minY - frame.minY) * sy).rounded(),
                          (f.width * sx).rounded(), (f.height * sy).rounded()]
        listed.append(entry)
        identities.append(["index": index, "role": (axValue(element, kAXRoleAttribute) as String?) ?? "", "frame": rectangle(f)])
    }
    let front = NSWorkspace.shared.frontmostApplication
    return ["width": image.width, "height": image.height, "display_id": 0,
            "bounds": rectangle(frame), "window_id": Int(target.windowID), "window_title": clip(scWindow.title, 120) ?? "",
            "app": ["pid": app.processIdentifier, "bundle_id": app.bundleIdentifier ?? "", "name": app.localizedName ?? ""],
            "frontmost": ["pid": Int(front?.processIdentifier ?? 0), "bundle_id": front?.bundleIdentifier ?? "", "name": front?.localizedName ?? ""] as [String: Any],
            "launched": launched, "raised": raised, "elements": listed, "element_identities": identities,
            "image_base64": jpeg.base64EncodedString(), "image_content_type": "image/jpeg"]
}

@available(macOS 12.3, *) @MainActor
func appInput(_ request: [String: Any]) async throws -> [String: Any] {
    try consoleSession()
    guard AXIsProcessTrusted() else { throw fail("accessibility_denied", "Allow Keyboard and mouse in the Mac app's computer setup.") }
    guard let expected = request["expected"] as? [String: Any], let pid = (expected["pid"] as? NSNumber)?.int32Value,
          let windowID = (expected["window_id"] as? NSNumber)?.uint32Value,
          let bounds = expected["bounds"] as? [String: Double],
          let width = expected["width"] as? Double, let height = expected["height"] as? Double, width > 0, height > 0 else {
        throw fail("stale_observation", "Observe the app again before input.")
    }
    let (target, _) = try await resolveWindow(pid: pid, windowID: CGWindowID(windowID))
    guard abs(target.frame.minX - (bounds["x"] ?? .nan)) < 2, abs(target.frame.minY - (bounds["y"] ?? .nan)) < 2,
          abs(target.frame.width - (bounds["width"] ?? .nan)) < 2, abs(target.frame.height - (bounds["height"] ?? .nan)) < 2 else {
        throw fail("desktop_changed", "The window moved or resized. Observe the app again.")
    }
    let frame = target.frame
    let operation = request["operation"] as? String ?? ""
    let typing = ["type", "press_key", "set_text"].contains(operation)
    if typing && IsSecureEventInputEnabled() && NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
        throw fail("secure_input", "Secure input is active. The person must complete that interaction.")
    }
    func element(_ index: Int) throws -> AXUIElement {
        let identities = expected["element_identities"] as? [[String: Any]] ?? []
        let elements = collectElements(target.window)
        guard index >= 0, index < elements.count, let identity = identities.first(where: { ($0["index"] as? Int) == index }),
              let role = identity["role"] as? String, (axValue(elements[index], kAXRoleAttribute) as String?) == role,
              let saved = identity["frame"] as? [String: Double], let now = axFrame(elements[index]),
              abs(now.minX - (saved["x"] ?? .nan)) < 3, abs(now.minY - (saved["y"] ?? .nan)) < 3 else {
            throw fail("stale_observation", "That element changed. Observe the app again and use the new index.")
        }
        return elements[index]
    }
    func globalPoint(_ name: String) throws -> CGPoint {
        guard let p = request[name] as? [Double], p.count == 2, p.allSatisfy({ $0.isFinite }),
              p[0] >= 0, p[0] < width, p[1] >= 0, p[1] < height else {
            throw fail("invalid_arguments", "Use coordinates inside the observed window image.")
        }
        return CGPoint(x: frame.minX + p[0] * frame.width / width, y: frame.minY + p[1] * frame.height / height)
    }
    let source = CGEventSource(stateID: .privateState)
    // WindowServer does not route events posted to a process, so each carries
    // its target process and window, and from macOS 27 its window-local point.
    func route(_ event: CGEvent, _ at: CGPoint) {
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
        windowLocationStamp?(event, CGPoint(x: at.x - frame.minX, y: at.y - frame.minY))
    }
    func postMouse(_ type: CGEventType, _ at: CGPoint, _ button: CGMouseButton, _ count: Int64) {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: button) else { return }
        event.setIntegerValueField(.mouseEventClickState, value: count)
        route(event, at)
        event.postToPid(pid)
    }
    // Keys go to the window this app has focused, which is not necessarily the
    // observed one. Make the observed window the app's main window, as a real
    // click would; the app stays inactive and the person's front app keeps focus.
    func focusWindow() -> Bool {
        if let focused: AXUIElement = axValue(target.appElement, kAXFocusedWindowAttribute), let f = axFrame(focused), sameFrame(f, frame) { return true }
        AXUIElementSetAttributeValue(target.window, kAXMainAttribute as CFString, kCFBooleanTrue)
        guard let focused: AXUIElement = axValue(target.appElement, kAXFocusedWindowAttribute), let f = axFrame(focused) else { return false }
        return sameFrame(f, frame)
    }
    if ["type", "press_key"].contains(operation), !focusWindow() {
        throw fail("target_not_focused", "Keys would go to another window of this app. Click a field in the observed window first.")
    }
    var pointer: [String: Double] = [:]
    func postKey(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags = []) {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
        event.flags = flags; event.postToPid(pid)
        pause(0.02)
    }
    func pressable(_ start: AXUIElement) -> AXUIElement? {
        var current: AXUIElement? = start
        for _ in 0..<6 {
            guard let element = current else { return nil }
            if axActions(element).contains(kAXPressAction as String) { return element }
            current = axValue(element, kAXParentAttribute)
        }
        return nil
    }
    var method = "event"
    switch operation {
    case "click":
        let right = request["button"] as? String == "right"
        let count = request["click_count"] as? Int ?? 1
        guard (1...2).contains(count) else { throw fail("invalid_arguments", "Use one or two clicks.") }
        var hit: AXUIElement?
        let at: CGPoint
        if let index = request["element"] as? Int {
            let e = try element(index); hit = e
            let f = axFrame(e) ?? .zero; at = CGPoint(x: f.midX, y: f.midY)
        } else {
            at = try globalPoint("point")
            var found: AXUIElement?
            if AXUIElementCopyElementAtPosition(target.appElement, Float(at.x), Float(at.y), &found) == .success { hit = found }
        }
        pointer = ["x": at.x, "y": at.y]
        _ = focusWindow()
        if count == 1, let e = hit {
            if right, axActions(e).contains(kAXShowMenuAction as String),
               AXUIElementPerformAction(e, kAXShowMenuAction as CFString) == .success { method = "accessibility"; break }
            let role: String = axValue(e, kAXRoleAttribute) ?? ""
            if !right, textRoles.contains(role), AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success {
                // A click at a point in text puts the caret there; inactive apps
                // ignore the mouse events that would otherwise do it.
                var point = at, range: AnyObject?, caret = CFRange()
                if request["point"] != nil, let position = AXValueCreate(.cgPoint, &point),
                   AXUIElementCopyParameterizedAttributeValue(e, kAXRangeForPositionParameterizedAttribute as CFString, position, &range) == .success,
                   let range, CFGetTypeID(range) == AXValueGetTypeID(), AXValueGetValue(range as! AXValue, .cfRange, &caret), caret.location >= 0, caret.length > 0 {
                    // An empty range means no text under the point: keep the caret.
                    // Otherwise that is the character under it. A click on its right
                    // half puts the caret after it, except at a line break.
                    var location = caret.location, one = CFRange(location: caret.location, length: 1)
                    var bounds: AnyObject?, glyph: AnyObject?, box = CGRect.zero
                    if let character = AXValueCreate(.cfRange, &one),
                       AXUIElementCopyParameterizedAttributeValue(e, kAXStringForRangeParameterizedAttribute as CFString, character, &glyph) == .success,
                       let text = glyph as? String, text != "\n", text != "\r",
                       AXUIElementCopyParameterizedAttributeValue(e, kAXBoundsForRangeParameterizedAttribute as CFString, character, &bounds) == .success,
                       let bounds, CFGetTypeID(bounds) == AXValueGetTypeID(), AXValueGetValue(bounds as! AXValue, .cgRect, &box),
                       at.x > box.midX { location += 1 }
                    var empty = CFRange(location: location, length: 0)
                    if let value = AXValueCreate(.cfRange, &empty) { AXUIElementSetAttributeValue(e, kAXSelectedTextRangeAttribute as CFString, value) }
                }
                method = "accessibility_focus"; break
            }
            if !right, let p = pressable(e), AXUIElementPerformAction(p, kAXPressAction as CFString) == .success { method = "accessibility"; break }
            if !right, ["AXRow", "AXCell", "AXOutlineRow"].contains(role) || (axValue(e, kAXSelectedAttribute) as Bool?) != nil,
               AXUIElementSetAttributeValue(e, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success { method = "accessibility_select"; break }
        }
        for i in 1...count {
            postMouse(right ? .rightMouseDown : .leftMouseDown, at, right ? .right : .left, Int64(i))
            pause(0.04)
            postMouse(right ? .rightMouseUp : .leftMouseUp, at, right ? .right : .left, Int64(i))
            pause(0.04)
        }
    case "set_text":
        guard let index = request["element"] as? Int, let text = request["text"] as? String, text.utf16.count <= 4096 else {
            throw fail("invalid_arguments", "Supply an element index and at most 4096 characters.")
        }
        let e = try element(index)
        guard (axValue(e, kAXRoleAttribute) as String?) != "AXSecureTextField" else {
            throw fail("secure_input", "That is a password field. The person must fill it.")
        }
        AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        guard AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, text as CFString) == .success else {
            throw fail("not_editable", "That element does not accept text. Click it, then use type.")
        }
        method = "accessibility"
    case "type":
        guard let text = request["text"] as? String, !text.isEmpty, text.utf16.count <= 4096 else { throw fail("invalid_arguments", "Supply at most 4096 UTF-16 units of text.") }
        if let focused: AXUIElement = axValue(target.appElement, kAXFocusedUIElementAttribute),
           (axValue(focused, kAXRoleAttribute) as String?) != "AXSecureTextField",
           AXUIElementSetAttributeValue(focused, kAXSelectedTextAttribute as CFString, text as CFString) == .success {
            method = "accessibility"; break
        }
        var chunk: [UniChar] = []
        func send() {
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
                chunk.withUnsafeBufferPointer { e.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress!) }
                e.postToPid(pid)
            }
            chunk.removeAll(); pause(0.01)
        }
        // An app drops a whole Unicode event that carries a line break or tab,
        // so those go as real Return/Tab presses between text chunks.
        for character in text {
            if character == "\n" || character == "\r\n" || character == "\r" || character == "\t" {
                if !chunk.isEmpty { send() }
                let code: CGKeyCode = character == "\t" ? 48 : 36
                postKey(code, true); postKey(code, false)
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
        if chord == ["RETURN"], let focused: AXUIElement = axValue(target.appElement, kAXFocusedUIElementAttribute),
           axActions(focused).contains(kAXConfirmAction as String),
           AXUIElementPerformAction(focused, kAXConfirmAction as CFString) == .success { method = "accessibility"; break }
        var flags: CGEventFlags = []
        for name in chord.dropLast() { let (key, flag) = modifiers[name]!; flags.insert(flag); postKey(key, true, flags) }
        postKey(code, true, flags); postKey(code, false, flags)
        for name in chord.dropLast().reversed() { let (key, flag) = modifiers[name]!; flags.remove(flag); postKey(key, false, flags) }
    case "scroll":
        let at = try globalPoint("point")
        guard let dx = request["dx"] as? Int32, let dy = request["dy"] as? Int32, abs(Int(dx)) <= 2000, abs(Int(dy)) <= 2000 else {
            throw fail("invalid_arguments", "Scroll deltas must be between -2000 and 2000 pixels.")
        }
        // Prefer the scroll area's own scroll bar: it works without the pointer.
        var hit: AXUIElement?
        if dx == 0, AXUIElementCopyElementAtPosition(target.appElement, Float(at.x), Float(at.y), &hit) == .success {
            var current = hit
            for _ in 0..<12 {
                guard let e = current else { break }
                if (axValue(e, kAXRoleAttribute) as String?) == "AXScrollArea",
                   let bar: AXUIElement = axValue(e, kAXVerticalScrollBarAttribute),
                   let value: NSNumber = axValue(bar, kAXValueAttribute), let area = axFrame(e), area.height > 0 {
                    let next = min(1, max(0, value.doubleValue - Double(dy) / Double(area.height) * 0.25))
                    if AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: next)) == .success { method = "accessibility" }
                    break
                }
                current = axValue(e, kAXParentAttribute)
            }
        }
        if method != "accessibility", let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
            event.location = at
            route(event, at)
            event.postToPid(pid)
        }
        pointer = ["x": at.x, "y": at.y]
    case "menu":
        guard let path = request["path"] as? [String], !path.isEmpty, path.count <= 6 else { throw fail("invalid_arguments", "Give the menu path, e.g. [\"File\", \"New Window\"].") }
        func norm(_ s: String) -> String { s.lowercased().replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "").trimmingCharacters(in: .whitespaces) }
        guard var current: AXUIElement = axValue(target.appElement, kAXMenuBarAttribute) else { throw fail("menu_unavailable", "That app has no menu bar.") }
        var available: [String] = []
        for (depth, title) in path.enumerated() {
            var children: [AXUIElement] = axValue(current, kAXChildrenAttribute) ?? []
            // Menu bar items and menu items hold their entries inside an AXMenu child.
            if depth > 0, children.count == 1, (axValue(children[0], kAXRoleAttribute) as String?) == "AXMenu" { children = axValue(children[0], kAXChildrenAttribute) ?? [] }
            available = children.compactMap { axValue($0, kAXTitleAttribute) as String? }.filter { !$0.isEmpty }
            guard let match = children.first(where: { norm((axValue($0, kAXTitleAttribute) as String?) ?? "") == norm(title) }) else {
                throw fail("menu_item_not_found", "No menu item '\(title.prefix(60))'. Available here: \(available.prefix(40).joined(separator: ", ").prefix(600))")
            }
            current = match
        }
        guard AXUIElementPerformAction(current, kAXPressAction as CFString) == .success else { throw fail("menu_unavailable", "That menu item could not be pressed. It may be disabled.") }
        method = "accessibility"
    default: throw fail("invalid_arguments", "Unsupported app operation.")
    }
    pause(0.1)
    var reply: [String: Any] = ["dispatched": true, "delivery_verified": false, "source_pid": getpid(), "method": method,
                                "message": "Sent to that app only. Observe the app again to verify the result."]
    if !pointer.isEmpty { reply["pointer"] = pointer }
    return reply
}

@main struct ComputerMain {
    @MainActor static func main() async {
        // The shape's pointer is its own long-lived process (see cursor.swift).
        if CommandLine.arguments.dropFirst().first == "--cursor" { runShapeCursor() }
        var reply: [String: Any]
        // Window capture needs a WindowServer connection. Open it with a
        // display query: creating NSApplication here would make this helper
        // an app of its own, which changes how macOS checks its permissions.
        _ = CGMainDisplayID()
        do {
            let data = FileHandle.standardInput.readData(ofLength: 32769)
            guard data.count <= 32768, let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw fail("invalid_arguments", "Invalid computer request.") }
            let operation = request["operation"] as? String
            let appScoped = request["app"] != nil || (request["expected"] as? [String: Any])?["mode"] as? String == "app"
            if operation == "apps" || appScoped || operation == "set_text" || operation == "menu" {
                guard #available(macOS 12.3, *) else { throw fail("unsupported", "App control requires macOS 12.3 or newer.") }
                if operation == "apps" { reply = ["success": true, "result": try await listApps()] }
                else if operation == "observe" { reply = ["success": true, "result": try await observeApp(request)] }
                else { reply = ["success": true, "result": try await appInput(request)] }
            } else if operation == "observe" {
                guard #available(macOS 12.3, *) else { throw fail("unsupported", "Screen control requires macOS 12.3 or newer.") }
                reply = ["success": true, "result": try await observe(request)]
            } else { throw wholeScreenInputRefused() }
        } catch let error as ControlError { reply = ["success": false, "error_type": error.code, "error": error.message, "dispatched": false] }
        catch { reply = ["success": false, "error_type": "native_control_failed", "error": "Computer control failed. Observe again or check the Mac app's permissions."] }
        let out = try! JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys])
        FileHandle.standardOutput.write(out); FileHandle.standardOutput.write(Data([10]))
    }
}
