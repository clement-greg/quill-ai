import AVFoundation
import XCTest
@testable import Quill_AI

/// Resuming partway through a paragraph: the audio already heard is dropped
/// from the re-rendered paragraph, buffer by buffer.
final class SpeechResumeTests: XCTestCase {
    func testSkipDropsWholeBuffersThenPartOfOne() {
        var skip = FrameSkip(frames: 2500)
        XCTAssertEqual(skip.take(1000), 1000)
        XCTAssertEqual(skip.take(1000), 1000)
        XCTAssertEqual(skip.take(1000), 500)
        XCTAssertEqual(skip.take(1000), 0)
        XCTAssertEqual(skip.remaining, 0)
    }

    func testNothingToSkipFromTheStart() {
        var skip = FrameSkip(frames: 0)
        XCTAssertEqual(skip.take(512), 0)
        XCTAssertEqual(FrameSkip(frames: -5).remaining, 0)
    }

    @MainActor
    func testTrimmedKeepsTheTailOfEachChannel() throws {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 22050, channels: 2))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 6))
        buffer.frameLength = 6
        for channel in 0..<2 {
            for i in 0..<6 { buffer.floatChannelData![channel][i] = Float(channel * 10 + i) }
        }

        let tail = try XCTUnwrap(SpeechController.trimmed(buffer, dropping: 4))
        XCTAssertEqual(tail.frameLength, 2)
        XCTAssertEqual(tail.floatChannelData![0][0], 4)
        XCTAssertEqual(tail.floatChannelData![1][1], 15)

        XCTAssertTrue(SpeechController.trimmed(buffer, dropping: 0) === buffer)
        XCTAssertNil(SpeechController.trimmed(buffer, dropping: 6))
    }
}
