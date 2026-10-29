import AppKit

// This small AppKit window runs independently of the sandboxed Catalyst host.
// It owns a private stdio controller, never a local HTTP control port.
final class BridgeControls: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let heading = NSTextField(labelWithString: "Computer connection")
    private let detail = NSTextField(wrappingLabelWithString: "Checking connection…")
    private let approval = NSButton(title: "Approve in shapes.inc", target: nil, action: nil)
    private let connect = NSButton(title: "Connect", target: nil, action: nil)
    private let pause = NSButton(title: "Disconnect", target: nil, action: nil)
    private let permissions = NSButton(title: "Computer permissions…", target: nil, action: nil)
    private var process: Process?
    private var input: FileHandle?
    private var timer: Timer?
    private var pendingData = Data()
    private var approvalURL: URL?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 310),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "shapes.inc"
        window.isReleasedWhenClosed = false
        heading.font = .systemFont(ofSize: 22, weight: .semibold)
        detail.maximumNumberOfLines = 0
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        [connect, pause, permissions, approval].forEach { $0.target = self; $0.bezelStyle = .rounded }
        connect.action = #selector(connectComputer)
        pause.action = #selector(pauseComputer)
        permissions.action = #selector(requestPermissions)
        approval.action = #selector(openApproval)
        let buttons = NSStackView(views: [connect, pause])
        buttons.orientation = .horizontal
        let stack = NSStackView(views: [heading, detail, approval, buttons, permissions])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24)
        ])
        approval.isHidden = true
        connect.isEnabled = false
        pause.isEnabled = false
        permissions.isEnabled = false
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startController()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        // EOF cancels unfinished approval; an explicitly connected LaunchAgent
        // keeps running, as the window copy explains. Its own Disconnect stops it.
        try? input?.close()
        if let process, process.isRunning {
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
            process.waitUntilExit()
        }
    }

    private func startController() {
        let task = Process(), stdin = Pipe(), stdout = Pipe()
        let contents = Bundle.main.bundleURL.appendingPathComponent("Contents")
        task.executableURL = contents.appendingPathComponent("MacOS/shapes.inc Bridge Runtime")
        task.arguments = [contents.appendingPathComponent("Resources/runtime/bin/desktop.js").path]
        task.standardInput = stdin
        task.standardOutput = stdout
        task.standardError = FileHandle.nullDevice
        input = stdin.fileHandleForWriting
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        task.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.timer?.invalidate()
                self?.detail.stringValue = "The computer connection controller stopped. Close this window and open Computer connection again."
                self?.connect.isEnabled = false
                self?.pause.isEnabled = false
                self?.permissions.isEnabled = false
            }
        }
        do {
            try task.run()
            process = task
            timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.send("status") }
        } catch {
            detail.stringValue = "The built-in computer connection is unavailable. Reinstall shapes.inc."
        }
    }

    private func consume(_ data: Data) {
        pendingData.append(data)
        guard pendingData.count < 65536 else { pendingData.removeAll(); return }
        while let newline = pendingData.firstIndex(of: 10) {
            let line = pendingData.prefix(upTo: newline)
            pendingData.removeSubrange(...newline)
            guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let status = message["status"] as? [String: Any] else { continue }
            render(status)
        }
    }

    private func render(_ status: [String: Any]) {
        let state = status["connection"] as? String ?? "offline"
        let pairing = status["pairing"] as? [String: String]
        approvalURL = pairing?["url"].flatMap(URL.init(string:))
        approval.isHidden = approvalURL == nil
        connect.isEnabled = !["connected", "starting", "connecting", "reconnecting", "pairing", "disconnect_failed"].contains(state)
        pause.isEnabled = !["disconnected", "paused", "revoked"].contains(state)
        pause.title = state == "pairing" ? "Cancel" : "Disconnect"
        permissions.isEnabled = ["connected", "connecting", "reconnecting"].contains(state)
        let text: String
        switch state {
        case "pairing": text = pairing.map { "Approve this computer with code \($0["code"] ?? "") in shapes.inc. You choose which chats can use it." } ?? "Starting computer approval…"
        case "connected": text = "Connected. Only chats you allow can use this computer. The connection stays on when you close this window."
        case "starting", "connecting", "reconnecting": text = "Connecting… The connection retries automatically. You can disconnect at any time."
        case "paused": text = "Disconnected. This computer stays disconnected after restart. Connect when you want to use it again."
        case "disconnect_failed": text = "The computer connection is still running. Disconnect again to stop access."
        case "revoked": text = "This computer was removed from your account. Connect to approve it again."
        default: text = "Connect your computer to shapes.inc, then choose which chats can use it. Connection starts at sign-in until you disconnect."
        }
        let error = status["error"] as? String
        detail.stringValue = text + (error.map { "\n\n\($0)" } ?? "")
    }

    private func send(_ command: String) {
        guard process?.isRunning == true else { return }
        do { try input?.write(contentsOf: Data((command + "\n").utf8)) }
        catch { detail.stringValue = "The connection controller is unavailable. Close this window and try again." }
    }
    @objc private func connectComputer() { send("connect") }
    @objc private func pauseComputer() { send("pause") }
    @objc private func requestPermissions() { send("permissions") }
    @objc private func openApproval() {
        guard let url = approvalURL, url.scheme == "https", url.host == "talk.shapes.inc" else { return }
        NSWorkspace.shared.open(url)
    }
}

let app = NSApplication.shared
let delegate = BridgeControls()
app.delegate = delegate
app.run()
