import XCTest
@testable import Quill_AI

/// How Microsoft voices split a paragraph into sentence-sized requests.
final class AzurePiecesTests: XCTestCase {
    private func sentence(_ n: Int) -> String {
        "Sentence \(n) " + Array(repeating: "word", count: 20).joined(separator: " ") + "."
    }

    func testShortParagraphIsOnePiece() {
        XCTAssertEqual(SpeechController.pieces(of: "  Hello   there. How are you?  "), ["Hello there. How are you?"])
    }

    func testEmptyTextHasNoPieces() {
        XCTAssertEqual(SpeechController.pieces(of: "   \n "), [])
    }

    func testLongParagraphSplitsAtSentencesAndKeepsEveryWord() {
        let text = (1...6).map(sentence).joined(separator: " ")
        let pieces = SpeechController.pieces(of: text)
        XCTAssertGreaterThan(pieces.count, 1)
        XCTAssertTrue(pieces.allSatisfy { $0.count <= 250 }, "\(pieces.map(\.count))")
        XCTAssertTrue(pieces[0].hasPrefix("Sentence 1"))
        XCTAssertEqual(pieces.joined(separator: " "), text)
    }

    func testOverlongSentenceBreaksAtCommasThenSpaces() {
        let clause = Array(repeating: "word", count: 15).joined(separator: " ")
        let long = Array(repeating: clause, count: 6).joined(separator: ", ") + "."
        let pieces = SpeechController.pieces(of: long)
        XCTAssertTrue(pieces.allSatisfy { $0.count <= 250 }, "\(pieces.map(\.count))")
        XCTAssertTrue(pieces.dropLast().allSatisfy { $0.hasSuffix(",") })
        XCTAssertEqual(pieces.joined(separator: " "), long)

        let noBreaks = String(repeating: "x", count: 600)
        XCTAssertEqual(SpeechController.pieces(of: noBreaks).map(\.count), [250, 250, 100])
    }

    // MARK: Character voices

    private func segment(_ text: String, parts: [VoicedPart]? = nil) -> SpeechSegment {
        SpeechSegment(text: text, chapterTitle: "One", chapterIndex: 0, chapterId: "c", blockIndex: 0, parts: parts)
    }

    func testPlainParagraphIsReadInTheNarrationVoice() {
        XCTAssertEqual(SpeechController.voicedPieces(of: segment("Just this."), narration: "en-US-JaneNeural"),
                       [AzurePiece(text: "Just this.", voice: "en-US-JaneNeural")])
    }

    func testDialogueIsReadInTheCharactersVoice() {
        let parts = [
            VoicedPart(text: "\"Go.\"", voiceId: "azure:en-US-AdamNeural"),
            VoicedPart(text: " He sighed. ", voiceId: nil),
            VoicedPart(text: "Fine", voiceId: "azure:en-US-AdamNeural"),
            VoicedPart(text: ".", voiceId: nil),
        ]
        let pieces = SpeechController.voicedPieces(of: segment("\"Go.\" He sighed. Fine.", parts: parts), narration: "Jane")
        XCTAssertEqual(pieces, [
            AzurePiece(text: "\"Go.\"", voice: "en-US-AdamNeural"),
            AzurePiece(text: "He sighed.", voice: "Jane"),
            AzurePiece(text: "Fine", voice: "en-US-AdamNeural"),
        ])
    }

    func testAPartWithADeviceVoiceFallsBackToNarration() {
        let parts = [VoicedPart(text: "\"Hi.\"", voiceId: "com.apple.voice.Ava"), VoicedPart(text: " Said Ann.", voiceId: nil)]
        XCTAssertEqual(SpeechController.voicedPieces(of: segment("\"Hi.\" Said Ann.", parts: parts), narration: "Jane").map(\.voice),
                       ["Jane", "Jane"])
    }

    func testDecodesPartsAndToleratesTheirAbsence() throws {
        let json = """
        [{"text":"A","chapterTitle":"T","chapterIndex":0,"parts":[{"text":"A","voiceId":"azure:X"},{"text":" b","voiceId":null}]},
         {"text":"B","chapterTitle":"T","chapterIndex":0}]
        """
        let segments = try JSONDecoder().decode([SpeechSegment].self, from: Data(json.utf8))
        XCTAssertEqual(segments[0].parts, [VoicedPart(text: "A", voiceId: "azure:X"), VoicedPart(text: " b", voiceId: nil)])
        XCTAssertNil(segments[1].parts)
    }
}
