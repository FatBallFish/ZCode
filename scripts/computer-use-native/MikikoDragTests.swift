import XCTest
import CoreGraphics
@testable import OpenComputerUseKit

final class MikikoDragTests: XCTestCase {
    func testProductionDragUsesVisiblePointerWithoutOpeningOtherGlobalModes() {
        XCTAssertEqual(dragDeliveryPath(environment: [:]), .global)
        XCTAssertFalse(globalPointerFallbacksEnabled(environment: [:]))
        XCTAssertTrue(dragDeliveryNote(for: .global).contains("real pointer"))
        XCTAssertFalse(dragDeliveryNote(for: .global).contains("is enabled"))
    }
    func testCancellationAfterDownReleasesWithoutFurtherMotion() {
        var validations = 0
        var events: [CGEventType] = []
        enum Cancelled: Error { case cancelled }
        XCTAssertThrowsError(try performMikikoDragGesture(from: .init(x: 10, y: 20), to: .init(x: 50, y: 20), steps: 10,
            validate: { _ in validations += 1; if validations == 4 { throw Cancelled.cancelled } },
            post: { type, _, _ in events.append(type) },
            release: { _ in events.append(.leftMouseUp) }))
        XCTAssertEqual(events, [.mouseMoved, .leftMouseDown, .leftMouseDragged, .leftMouseUp])
    }
    func testRejectionBeforeDownDoesNotSendCleanupClick() {
        enum Denied: Error { case denied }
        var events: [CGEventType] = []
        XCTAssertThrowsError(try performMikikoDragGesture(from: .zero, to: .init(x: 10, y: 10), steps: 2,
            validate: { _ in throw Denied.denied }, post: { type, _, _ in events.append(type) },
            release: { _ in events.append(.leftMouseUp) }))
        XCTAssertTrue(events.isEmpty)
    }
    func testSuccessReleasesExactlyOnceAtDestination() throws {
        var events: [(CGEventType, CGPoint)] = []
        let end = CGPoint(x: 40, y: 20)
        try performMikikoDragGesture(from: .init(x: 10, y: 20), to: end, steps: 3,
            validate: { _ in }, post: { type, point, _ in events.append((type, point)) },
            release: { point in events.append((.leftMouseUp, point)) })
        XCTAssertEqual(events.map(\.0), [.mouseMoved, .leftMouseDown, .leftMouseDragged, .leftMouseDragged, .leftMouseDragged, .leftMouseUp])
        XCTAssertEqual(events.last?.1, end)
    }
    func testStaleOrOccludedWindowAndOutsideCoordinatesAreRejected() throws {
        let bounds = CGRect(x: 10, y: 10, width: 100, height: 100)
        let target = MikikoDragWindow(id: 7, pid: 42, bounds: bounds)
        try validateMikikoDragWindow(target, current: [target], point: .init(x: 20, y: 20), hitWindowID: 7)
        for windows in [[MikikoDragWindow(id: 7, pid: 43, bounds: bounds)],
                        [MikikoDragWindow(id: 7, pid: 42, bounds: bounds.offsetBy(dx: 1, dy: 0))],
                        []] {
            XCTAssertThrowsError(try validateMikikoDragWindow(target, current: windows, point: .init(x: 20, y: 20), hitWindowID: 7))
        }
        XCTAssertThrowsError(try validateMikikoDragWindow(target, current: [target], point: .init(x: 20, y: 20), hitWindowID: 8))
        XCTAssertThrowsError(try validateMikikoDragWindow(target, current: [target], point: .init(x: 200, y: 20), hitWindowID: 7))
    }
}
