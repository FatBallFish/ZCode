import XCTest
import ApplicationServices
@testable import OpenComputerUseKit

final class MikikoAXActionTests: XCTestCase {
    func testUnconfirmedMutationIsNeverReplayedOrRepeated() throws {
        let element = AXUIElementCreateSystemWide()
        var sent = 0
        var budgets: [Float] = []
        XCTAssertThrowsError(try performMikikoAXAction(on: element, action: "AXPress", repeatCount: 2,
            setMessagingTimeout: { _, timeout in budgets.append(timeout); return .success },
            perform: { _, _ in sent += 1; return .cannotComplete })) { error in
                XCTAssertTrue(String(describing: error).contains("unconfirmed"))
            }
        XCTAssertEqual(sent, 1)
        XCTAssertEqual(budgets, [2])
    }
    func testOnlyConfirmedExplicitRepeatsContinue() throws {
        let element = AXUIElementCreateSystemWide()
        var events: [String] = []
        XCTAssertTrue(try performMikikoAXAction(on: element, action: "AXPress", repeatCount: 2,
            beforeEach: { events.append("admit") },
            setMessagingTimeout: { _, value in XCTAssertEqual(value, 2); events.append("budget"); return .success },
            perform: { _, _ in events.append("send"); return .success }))
        XCTAssertEqual(events, ["admit", "budget", "send", "admit", "budget", "send"])
    }
    func testInvalidMessagingBudgetDoesNotDispatchAnyMutation() {
        XCTAssertThrowsError(try performMikikoAXAction(on: AXUIElementCreateSystemWide(), action: "AXPress", repeatCount: 1,
            setMessagingTimeout: { _, _ in .invalidUIElement },
            perform: { _, _ in XCTFail("sent after invalid element"); return .success }))
    }
    func testProductionAppPostDragDoesNotAdvertiseDisabledGlobalMode() {
        let note = dragDeliveryNote(for: .appPost)
        XCTAssertFalse(note.contains("MIKIKO_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS=1"))
        XCTAssertTrue(note.contains("unavailable"))
    }

}
