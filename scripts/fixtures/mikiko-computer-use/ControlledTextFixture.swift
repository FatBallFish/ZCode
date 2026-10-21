import Cocoa

// 只暴露本测试创建的文本框；不查询其他应用或请求任何系统权限。
final class DragSurface: NSView {
    var starts = 0
    var moves = 0
    var ends = 0
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlBackgroundColor.setFill(); bounds.fill()
        ("Synthetic drag target" as NSString).draw(at: NSPoint(x: 8, y: 18), withAttributes: [.foregroundColor: NSColor.labelColor])
    }
    override func mouseDown(with event: NSEvent) { starts += 1 }
    override func mouseDragged(with event: NSEvent) { moves += 1 }
    override func mouseUp(with event: NSEvent) { ends += 1 }
}

final class ControlledScrollView: NSScrollView {
    var scrollActions: [String] = []
    var wheelEvents = 0
    override func accessibilityPerformAction(_ action: NSAccessibility.Action) {
        scrollActions.append(action.rawValue)
        // 测试应用显式实现自己声明的AX分页动作；通过真实系统AX分发，不接入任何私有fixture bridge。
        if action.rawValue == "AXScrollDownByPage", let documentView {
            let maxY = max(0, documentView.frame.height - contentView.bounds.height)
            contentView.scroll(to: NSPoint(x: contentView.bounds.origin.x, y: min(maxY, contentView.bounds.origin.y + contentView.bounds.height)))
            reflectScrolledClipView(contentView)
        } else { super.accessibilityPerformAction(action) }
    }
    override func scrollWheel(with event: NSEvent) {
        wheelEvents += 1
        super.scrollWheel(with: event)
    }
}

final class FixtureDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var field: NSTextField!
    var button: NSButton!
    var scroll: ControlledScrollView!
    var drag: DragSurface!
    var clicks = 0
    var completedClicks = 0
    var clickEvents: [[String: Any]] = []
    var timer: Timer?
    let statePath: String
    let nonce: String

    init(statePath: String, nonce: String) {
        self.statePath = statePath
        self.nonce = nonce
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 540, height: 480),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Mikiko Controlled Fixture \(nonce)"
        window.isReleasedWhenClosed = false
        let label = NSTextField(labelWithString: "Synthetic Computer Use test data only")
        label.frame = NSRect(x: 24, y: 425, width: 490, height: 24)
        field = NSTextField(frame: NSRect(x: 24, y: 365, width: 490, height: 30))
        field.stringValue = "mikiko-initial-\(nonce)"
        field.setAccessibilityIdentifier("mikiko-smoke-input-\(nonce)")
        field.setAccessibilityLabel("Mikiko smoke input \(nonce)")
        window.contentView?.addSubview(label)
        window.contentView?.addSubview(field)
        button = NSButton(title: "Mikiko test button", target: self, action: #selector(clicked))
        button.frame = NSRect(x: 24, y: 310, width: 210, height: 30)
        button.setAccessibilityIdentifier("mikiko-smoke-button-\(nonce)")
        window.contentView?.addSubview(button)
        let template = NSTextView.scrollableTextView()
        let document = template.documentView as! NSTextView
        template.documentView = nil
        scroll = ControlledScrollView(frame: NSRect(x: 24, y: 105, width: 490, height: 180))
        scroll.hasVerticalScroller = true
        scroll.setAccessibilityIdentifier("mikiko-smoke-scroll-\(nonce)")
        scroll.documentView = document
        document.string = (0..<200).map { "Synthetic scroll line \($0)" }.joined(separator: "\n")
        document.isEditable = false
        scroll.documentView = document
        window.contentView?.addSubview(scroll)
        drag = DragSurface(frame: NSRect(x: 24, y: 20, width: 490, height: 60))
        window.contentView?.addSubview(drag)
        // 台前调度可把后台新窗口折成显示器外的缩略窗；测试必须先展示自己的有效窗口。
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window.makeFirstResponder(field)
        writeState()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.writeState()
        }
    }

    @objc func clicked() {
        clicks += 1
        clickEvents.append(["count": clicks, "time": Date().timeIntervalSince1970,
                            "eventType": NSApp.currentEvent.map { Int($0.type.rawValue) } ?? -1])
        window.makeFirstResponder(field)
        writeState()
        // 合成验收可延迟回复，证明 AX 已产生副作用但未确认时不会再次发送。
        if let raw = ProcessInfo.processInfo.environment["MIKIKO_TEST_ACTION_DELAY_MS"], let delay = Double(raw), delay > 0 {
            Thread.sleep(forTimeInterval: min(delay, 3000) / 1000)
        }
        completedClicks += 1
        writeState()
    }

    func writeState() {
        let ownWindow = (CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(window.windowNumber)) as? [[String: Any]])?
            .first { ($0[kCGWindowOwnerPID as String] as? Int) == Int(ProcessInfo.processInfo.processIdentifier) }
        let boundsData = ownWindow?[kCGWindowBounds as String] as? [String: Any]
        let bounds = boundsData.flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
        let displays = NSScreen.screens.compactMap { screen -> CGRect? in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
            return CGDisplayBounds(CGDirectDisplayID(number.uint32Value))
        }
        let intersects = bounds.map { frame in displays.contains { $0.intersects(frame) } } ?? false
        let state: [String: Any] = [
            "pid": ProcessInfo.processInfo.processIdentifier,
            "bundleId": Bundle.main.bundleIdentifier ?? "",
            "nonce": nonce,
            "title": window.title,
            "windowId": window.windowNumber,
            "fieldIdentifier": "mikiko-smoke-input-\(nonce)",
            "fieldLabel": "Mikiko smoke input \(nonce)",
            "value": field.currentEditor()?.string ?? field.stringValue,
            "buttonIdentifier": "mikiko-smoke-button-\(nonce)",
            "clicks": clicks,
            "completedClicks": completedClicks,
            "selectionLocation": (field.currentEditor() as? NSTextView)?.selectedRange().location ?? -1,
            "selectionLength": (field.currentEditor() as? NSTextView)?.selectedRange().length ?? -1,
            "scrollIdentifier": "mikiko-smoke-scroll-\(nonce)",
            "scrollY": scroll.contentView.bounds.origin.y,
            "scrollActions": scroll.scrollActions,
            "scrollWheelEvents": scroll.wheelEvents,
            "scrollAdvertisedActions": scroll.accessibilityActionNames().map { $0.rawValue },
            "scrollDocumentHeight": scroll.documentView?.frame.height ?? 0,
            "scrollViewportHeight": scroll.contentView.bounds.height,
            "dragStarts": drag.starts, "dragMoves": drag.moves, "dragEnds": drag.ends,
            "dragFromX": drag.frame.minX + 25, "dragToX": drag.frame.minX + 145,
            "dragY": window.frame.height - drag.frame.midY,
            "clickEvents": clickEvents,
            "active": NSApp.isActive,
            "visible": window.isVisible && window.occlusionState.contains(.visible),
            "intersectsDisplay": intersects,
            "cgBounds": ["x": bounds?.origin.x ?? 0, "y": bounds?.origin.y ?? 0,
                         "width": bounds?.width ?? 0, "height": bounds?.height ?? 0],
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
