import Foundation
import ApplicationServices

/// 查询仅给50/100ms，动作确认另有2秒预算；AX发送后未确认就停止，不把超时当成未执行。
func performMikikoAXAction(
    on element: AXUIElement,
    action: String,
    repeatCount: Int,
    beforeEach: () throws -> Void = {},
    setMessagingTimeout: (AXUIElement, Float) -> AXError = AXUIElementSetMessagingTimeout,
    perform: (AXUIElement, CFString) -> AXError = AXUIElementPerformAction
) throws -> Bool {
    for index in 0..<max(repeatCount, 1) {
        try beforeEach()
        let budget = setMessagingTimeout(element, 2)
        guard budget == .success else {
            throw ComputerUseError.message("AX action not sent: could not reset query messaging budget (error=\(budget.rawValue)).")
        }
        let result = perform(element, action as CFString)
        guard result == .success else {
            throw ComputerUseError.message("AX action \(action) outcome unconfirmed (error=\(result.rawValue)); it may have run. Inspect fresh state before deciding a next action; do not automatically retry.")
        }
        if index < max(repeatCount, 1) - 1 { Thread.sleep(forTimeInterval: 0.05) }
    }
    return true
}
