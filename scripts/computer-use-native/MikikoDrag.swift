import CoreGraphics

struct MikikoDragWindow {
    let id: CGWindowID
    let pid: Int32
    let bounds: CGRect
}

func validateMikikoDragWindow(_ target: MikikoDragWindow, current: [MikikoDragWindow], point: CGPoint, hitWindowID: CGWindowID?) throws {
    guard point.x.isFinite, point.y.isFinite, target.bounds.contains(point) else {
        throw ComputerUseError.stateUnavailable("Drag coordinates are outside the observed window.")
    }
    guard let exact = current.first(where: { $0.id == target.id }), exact.pid == target.pid else {
        throw ComputerUseError.stateUnavailable("Drag target window is no longer on screen; obtain a fresh screenshot.")
    }
    guard exact.bounds == target.bounds else {
        throw ComputerUseError.stateUnavailable("Drag target bounds changed from \(target.bounds) to \(exact.bounds); obtain a fresh screenshot.")
    }
    guard hitWindowID == target.id else {
        throw ComputerUseError.stateUnavailable("Drag target is occluded at \(point); expose the observed window and obtain a fresh screenshot.")
    }
}

/// 中文：按下之后，取消或目标变化也必须释放；清理不再走已拒绝的准入校验。
func performMikikoDragGesture(
    from start: CGPoint, to end: CGPoint, steps: Int,
    validate: (CGPoint) throws -> Void,
    post: (CGEventType, CGPoint, CGSize?) throws -> Void,
    release: (CGPoint) -> Void
) throws {
    try validate(start)
    try post(.mouseMoved, start, nil)
    try validate(start)
    try post(.leftMouseDown, start, nil)
    var previous = start
    defer { release(previous) }
    for step in 1...max(1, steps) {
        let progress = CGFloat(step) / CGFloat(max(1, steps))
        let point = CGPoint(x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress)
        try validate(point)
        try post(.leftMouseDragged, point, CGSize(width: point.x - previous.x, height: point.y - previous.y))
        previous = point
    }
}
