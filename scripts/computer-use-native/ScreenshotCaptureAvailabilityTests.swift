import XCTest
import CoreGraphics
@testable import OpenComputerUseKit

final class ScreenshotCaptureAvailabilityTests: XCTestCase {
    func testMissingNativeImageReportsUnavailabilityInsteadOfSilentAXOnlySuccess() {
        let result = screenshotCaptureResult(for: nil, config: .defaults)
        XCTAssertNil(result.data)
        XCTAssertEqual(result.note, "Screenshot unavailable: native window capture did not produce an image.")
    }

    func testActualImageStillEncodesAndKeepsExistingOmissionDiagnostics() throws {
        let context = try XCTUnwrap(CGContext(data: nil, width: 20, height: 20,
            bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try XCTUnwrap(context.makeImage())
        let encoded = screenshotCaptureResult(for: image, config: .defaults)
        XCTAssertNotNil(encoded.data)
        XCTAssertNil(encoded.note)
        var tiny = ImageCaptureConfig.defaults
        tiny.discardBelowPixelCount = 401
        let omitted = screenshotCaptureResult(for: image, config: tiny)
        XCTAssertNil(omitted.data)
        XCTAssertEqual(omitted.note, "Screenshot omitted: 20×20 has fewer than 401 pixels")
    }
}
