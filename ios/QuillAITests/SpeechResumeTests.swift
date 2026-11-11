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

/// Telling which word is being spoken from the synthesizer's word markers.
final class WordTimelineTests: XCTestCase {
    private func mark(_ byte: Int, _ location: Int, _ length: Int) -> WordTimeline.Mark {
        WordTimeline.Mark(byteOffset: byte, location: location, length: length)
    }

    func testFindsTheWordThatHasStarted() {
        var words = WordTimeline()
        [mark(0, 0, 3), mark(4000, 4, 10), mark(8000, 15, 6)].forEach { words.add($0) }
        // Markers count bytes; Float32 mono audio is 4 bytes a frame.
        XCTAssertEqual(words.word(atFrame: 0, bytesPerFrame: 4)?.location, 0)
        XCTAssertEqual(words.word(atFrame: 999, bytesPerFrame: 4)?.location, 0)
        XCTAssertEqual(words.word(atFrame: 1000, bytesPerFrame: 4)?.location, 4)
        XCTAssertEqual(words.word(atFrame: 50_000, bytesPerFrame: 4)?.location, 15)
        XCTAssertEqual(WordTimeline.startFrame(of: mark(8000, 15, 6), bytesPerFrame: 4), 2000)
        XCTAssertEqual(WordTimeline.startFrame(of: mark(8000, 15, 6), bytesPerFrame: 2), 4000)
    }

    func testNoWordWithoutMarkersOrBeforeTheFirst() {
        XCTAssertNil(WordTimeline().word(atFrame: 100, bytesPerFrame: 4))
        var words = WordTimeline()
        words.add(mark(400, 0, 3))
        XCTAssertNil(words.word(atFrame: 50, bytesPerFrame: 4))
        XCTAssertNil(words.word(atFrame: 500, bytesPerFrame: 0))
    }

    func testKeepsMarkersInOrder() {
        var words = WordTimeline()
        [mark(8000, 15, 6), mark(0, 0, 3), mark(4000, 4, 10)].forEach { words.add($0) }
        XCTAssertEqual(words.marks.map(\.location), [0, 4, 15])
    }
}
