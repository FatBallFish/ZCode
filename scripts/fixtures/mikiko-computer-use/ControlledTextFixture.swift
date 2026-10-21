import Cocoa

// 只暴露本测试创建的文本框；不查询其他应用或请求任何系统权限。
final class FixtureDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var field: NSTextField!
    var timer: Timer?
    let statePath: String
    let nonce: String

    init(statePath: String, nonce: String) {
        self.statePath = statePath
        self.nonce = nonce
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 540, height: 180),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Mikiko Controlled Fixture \(nonce)"
        window.isReleasedWhenClosed = false
        let label = NSTextField(labelWithString: "Synthetic Computer Use test data only")
        label.frame = NSRect(x: 24, y: 120, width: 490, height: 24)
        field = NSTextField(frame: NSRect(x: 24, y: 65, width: 490, height: 30))
        field.stringValue = "mikiko-initial-\(nonce)"
        field.setAccessibilityIdentifier("mikiko-smoke-input-\(nonce)")
        field.setAccessibilityLabel("Mikiko smoke input \(nonce)")
        window.contentView?.addSubview(label)
        window.contentView?.addSubview(field)
        window.orderFront(nil)
        writeState()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.writeState()
        }
    }

    func writeState() {
        let state: [String: Any] = [
            "pid": ProcessInfo.processInfo.processIdentifier,
            "bundleId": Bundle.main.bundleIdentifier ?? "",
            "nonce": nonce,
            "title": window.title,
            "windowId": window.windowNumber,
            "fieldIdentifier": "mikiko-smoke-input-\(nonce)",
            "fieldLabel": "Mikiko smoke input \(nonce)",
            "value": field.stringValue,
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
        } catch {
            fputs("Fixture state write failed: \(error)\n", stderr)
            NSApp.terminate(nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

guard CommandLine.arguments.count == 3 else { fatalError("Expected state path and nonce") }
let app = NSApplication.shared
let delegate = FixtureDelegate(statePath: CommandLine.arguments[1], nonce: CommandLine.arguments[2])
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
