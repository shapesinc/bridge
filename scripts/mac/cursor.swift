// The shape's own on-screen pointer. It is drawn by a separate accessory
// process in a click-through panel at the assistive-technology window level,
// so it never takes the person's pointer, keyboard focus or front app. The
// Bridge runtime owns its lifetime over private stdin: one JSON object per
// line, and EOF or a minute without commands ends it.
import AppKit
import QuartzCore

@MainActor
final class ShapeCursor: NSObject {
    private static let size = NSSize(width: 280, height: 76)
    // The arrow tip, in the panel's bottom-left coordinate space. The margin
    // leaves room for the click ring around the tip.
    private static let tip = CGPoint(x: 26, y: 50)
    private let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size),
                                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    private let arrow = CAShapeLayer(), ring = CAShapeLayer(), pill = CALayer(), text = CATextLayer()
    private var lastCommand = Date(), visible = false
    private var glideTimer: Timer?

    override init() {
        super.init()
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.assistiveTechHighWindow)))
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.title = "shapes.inc shape pointer"
        let view = NSView(frame: NSRect(origin: .zero, size: Self.size))
        view.wantsLayer = true
        panel.contentView = view
        let root = view.layer!
        let accent = NSColor(srgbRed: 0.42, green: 0.33, blue: 0.96, alpha: 1).cgColor
        let tip = Self.tip
        // Classic arrow outline, y-down offsets from the tip.
        let outline: [(CGFloat, CGFloat)] = [(0, 0), (0, 19), (4.8, 14.6), (8, 22), (11.2, 20.6), (8.1, 13.5), (14, 13.5)]
        let path = CGMutablePath()
        path.addLines(between: outline.map { CGPoint(x: tip.x + $0.0, y: tip.y - $0.1) })
        path.closeSubpath()
        arrow.path = path
        arrow.fillColor = accent
        arrow.strokeColor = NSColor.white.cgColor
        arrow.lineWidth = 1.6
        arrow.lineJoin = .round
        arrow.shadowColor = NSColor.black.cgColor
        arrow.shadowOpacity = 0.35
        arrow.shadowRadius = 2.5
        arrow.shadowOffset = CGSize(width: 0, height: -1)
        ring.path = CGPath(ellipseIn: CGRect(x: -16, y: -16, width: 32, height: 32), transform: nil)
        ring.position = tip
        ring.fillColor = NSColor.clear.cgColor
        ring.strokeColor = accent
        ring.lineWidth = 3
        ring.opacity = 0
        pill.backgroundColor = accent
        pill.cornerRadius = 10
        pill.borderColor = NSColor.white.cgColor
        pill.borderWidth = 1.2
        pill.shadowOpacity = 0.25
        pill.shadowRadius = 2
        pill.shadowOffset = CGSize(width: 0, height: -1)
        text.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        text.fontSize = 12
        text.foregroundColor = NSColor.white.cgColor
        text.contentsScale = NSScreen.screens.map(\.backingScaleFactor).max() ?? 2
        text.alignmentMode = .left
        text.truncationMode = .end
        pill.addSublayer(text)
        [ring, arrow, pill].forEach(root.addSublayer)
        setLabel("shape")
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.idle() }
        }
    }

    private func setLabel(_ value: String) {
        let label = String(value.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.map(Character.init).prefix(32))
        let font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        let width = min(220, ceil((label as NSString).size(withAttributes: [.font: font]).width))
        CATransaction.begin(); CATransaction.setDisableActions(true)
        text.string = label
        pill.frame = CGRect(x: Self.tip.x + 13, y: Self.tip.y - 40, width: width + 18, height: 20)
        text.frame = CGRect(x: 9, y: 3, width: width, height: 15)
        CATransaction.commit()
    }

    private func origin(for point: CGPoint) -> NSPoint {
        // Bridge points are global display coordinates (top-left origin of the
        // primary display); AppKit windows use the primary screen's bottom-left.
        let primary = NSScreen.screens.first?.frame.height ?? 0
        return NSPoint(x: point.x - Self.tip.x, y: primary - point.y - Self.tip.y)
    }

    private func glide(to point: CGPoint, duration: TimeInterval, then done: (() -> Void)? = nil) {
        glideTimer?.invalidate()
        let target = origin(for: point)
        panel.alphaValue = 1
        if !visible {
            visible = true
            panel.setFrameOrigin(target)
            panel.orderFrontRegardless()
            done?()
            return
        }
        panel.orderFrontRegardless()
        let start = panel.frame.origin, began = Date()
        glideTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] timer in
            MainActor.assumeIsolated {
                guard let self else { timer.invalidate(); return }
                let t = min(1, Date().timeIntervalSince(began) / duration), eased = 1 - pow(1 - t, 3)
                self.panel.setFrameOrigin(NSPoint(x: start.x + (target.x - start.x) * eased, y: start.y + (target.y - start.y) * eased))
                if t >= 1 { timer.invalidate(); self.glideTimer = nil; done?() }
            }
        }
    }

    private func pulse(scale: CGFloat) {
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.35; grow.toValue = scale
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.9; fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [grow, fade]; group.duration = 0.45
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        ring.add(group, forKey: "pulse")
    }

    func handle(_ line: String) {
        guard let data = line.data(using: .utf8),
              let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let op = command["op"] as? String else { return }
        lastCommand = Date()
        if let label = command["label"] as? String, !label.isEmpty { setLabel(label) }
        func point(_ x: String, _ y: String) -> CGPoint? {
            guard let px = (command[x] as? NSNumber)?.doubleValue, let py = (command[y] as? NSNumber)?.doubleValue,
                  px.isFinite, py.isFinite else { return nil }
            return CGPoint(x: px, y: py)
        }
        switch op {
        case "move": if let p = point("x", "y") { glide(to: p, duration: 0.25) }
        case "click": if let p = point("x", "y") { glide(to: p, duration: 0.2) { [weak self] in self?.pulse(scale: 1.5) } }
        case "drag":
            if let start = point("x", "y"), let end = point("to_x", "to_y") {
                glide(to: start, duration: 0.2) { [weak self] in
                    self?.pulse(scale: 1.1)
                    self?.glide(to: end, duration: 0.45) { self?.pulse(scale: 1.1) }
                }
            }
        case "key": if visible { pulse(scale: 0.9) }
        case "hide": hide()
        default: break
        }
    }

    private func hide() {
        guard visible else { return }
        visible = false
        glideTimer?.invalidate(); glideTimer = nil
        panel.orderOut(nil)
    }

    private func idle() {
        let quiet = Date().timeIntervalSince(lastCommand)
        if quiet > 20 { hide() }
        if quiet > 60 { exit(0) }
    }
}

@MainActor
func runShapeCursor() -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let cursor = ShapeCursor()
    Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) {
            guard line.utf8.count <= 4096 else { continue }
            DispatchQueue.main.async { MainActor.assumeIsolated { cursor.handle(line) } }
        }
        exit(0)
    }
    withExtendedLifetime(cursor) { app.run() }
    exit(0)
}
