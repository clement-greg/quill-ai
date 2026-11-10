import XCTest
@testable import Quill_AI

final class SpeechTimelineTests: XCTestCase {
    /// 29 characters = 2 seconds at normal speed.
    private let para = String(repeating: "a", count: 29)

    private func seg(_ chapter: Int, _ text: String) -> SpeechSegment {
        SpeechSegment(text: text, chapterTitle: "Ch \(chapter)", chapterIndex: chapter)
    }

    private var book: [SpeechSegment] {
        [seg(0, "Ch 0"), seg(0, para), seg(0, para), seg(1, "Ch 1"), seg(1, para), seg(2, "Ch 2")]
    }

    func testEstimatesDurationsWithAOneSecondFloorAndScalesWithRate() {
        let t = SpeechTimeline(segments: book, rate: 1)
        XCTAssertEqual(t.duration, 1 + 2 + 2 + 1 + 2 + 1, accuracy: 0.001)
        XCTAssertEqual(t.startTime(of: 3), 5, accuracy: 0.001)
        XCTAssertEqual(SpeechTimeline(segments: [seg(0, para)], rate: 2).duration, 1, accuracy: 0.001)
    }

    func testFindsTheSegmentAtATime() {
        let t = SpeechTimeline(segments: book, rate: 1)
        XCTAssertEqual(t.index(at: 0), 0)
        XCTAssertEqual(t.index(at: 2.5), 1)
        XCTAssertEqual(t.index(at: 5), 3)
        XCTAssertEqual(t.index(at: 999), 5)
        XCTAssertEqual(SpeechTimeline(segments: [], rate: 1).index(at: 3), 0)
    }

    func testSkipsByTimeAndAlwaysMovesForward() {
        let t = SpeechTimeline(segments: book, rate: 1)
        XCTAssertEqual(t.skip(from: 1, elapsedInSegment: 0, by: 3), 2)
        XCTAssertEqual(t.skip(from: 1, elapsedInSegment: 0, by: 0.1), 2)
        XCTAssertEqual(t.skip(from: 4, elapsedInSegment: 1, by: -15), 0)
        XCTAssertEqual(t.skip(from: 5, elapsedInSegment: 0, by: 15), 5)
    }

    func testChapterNavigation() {
        let t = SpeechTimeline(segments: book, rate: 1)
        XCTAssertEqual(t.chapterCount, 3)
        XCTAssertEqual(t.nextChapterStart(from: 1), 3)
        XCTAssertNil(t.nextChapterStart(from: 5))
        XCTAssertEqual(t.previousChapterStart(from: 2), 0)  // partway in: restart chapter 0
        XCTAssertEqual(t.previousChapterStart(from: 4), 0)  // just started chapter 1: back to chapter 0
        XCTAssertEqual(t.previousChapterStart(from: 5), 3)
        XCTAssertEqual(t.previousChapterStart(from: 99), 0)
    }

    func testMapsWebSpeedOntoUtteranceRate() {
        XCTAssertEqual(SpeechTimeline.utteranceRate(for: 1), 0.5, accuracy: 0.001)
        XCTAssertEqual(SpeechTimeline.utteranceRate(for: 2), 0.7, accuracy: 0.001)
        XCTAssertEqual(SpeechTimeline.utteranceRate(for: 0.75), 0.375, accuracy: 0.001)
        XCTAssertEqual(SpeechTimeline.utteranceRate(for: 9), 1, accuracy: 0.001)
    }

    func testDecodesTheWebRequest() throws {
        let json = #"{"segments":[{"text":"Hi","chapterTitle":"One","chapterIndex":0}],"startIndex":0,"voiceId":null,"rate":1.25,"bookTitle":"B"}"#
        let req = try JSONDecoder().decode(SpeechPlayRequest.self, from: Data(json.utf8))
        XCTAssertEqual(req.segments, [SpeechSegment(text: "Hi", chapterTitle: "One", chapterIndex: 0)])
        XCTAssertNil(req.voiceId)
        XCTAssertEqual(req.rate, 1.25)
    }
}
