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
}
