import AppIntents
import XCTest
@testable import Quill_AI

final class SiriCommandTests: XCTestCase {
    func testBothSiriCommandsAreRegistered() {
        XCTAssertEqual(QuillShortcuts.appShortcuts.count, 2)
    }

    func testSignedOutAskExplainsWhatToDo() async throws {
        let saved = SessionStore.refreshToken
        defer { SessionStore.save(saved) }
        SessionStore.save(nil)

        do {
            _ = try await QuillAPI.ask("hello")
            XCTFail("Expected notSignedIn")
        } catch QuillAPIError.notSignedIn {
            // expected
        }
    }

    /// End to end against the dev server, using the session the app stored
    /// when you signed in. Read-only question. Opt in with:
    ///   TEST_RUNNER_QUILL_LIVE_TESTS=1 xcodebuild test …
    func testAskQuillLive() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["QUILL_LIVE_TESTS"] == "1", "Live test not requested")
        XCTAssertNotNil(SessionStore.refreshToken, "Sign in to the app in this Simulator first")

        let intent = AskQuillIntent()
        intent.question = "Which of my saved thoughts are tagged funny?"
        let answer = try await QuillAPI.ask(intent.question)
        print("ASK QUILL ANSWER: \(answer)")
        XCTAssertFalse(answer.isEmpty)
        XCTAssertNotNil(SessionStore.refreshToken, "Rotated refresh token should be stored")
    }
}
