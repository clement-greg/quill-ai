import AppIntents
import XCTest
@testable import Quill_AI

final class SiriCommandTests: XCTestCase {
    func testAllSiriCommandsAreRegistered() {
        XCTAssertEqual(QuillShortcuts.appShortcuts.count, 4)
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

        // A follow-up only makes sense with the first turn as context.
        let history = [VoiceTurn(role: .user, content: intent.question), VoiceTurn(role: .assistant, content: answer)]
        let followUp = try await QuillAPI.ask("Which one is untitled?", history: history)
        print("FOLLOW-UP ANSWER: \(followUp)")
        XCTAssertFalse(followUp.isEmpty)
    }
}

final class ConversationTests: XCTestCase {
    func testClosingRepliesEndTheConversation() {
        for reply in ["No", "no.", "Nope!", "No, thanks", "no thank you", "That's all", "That’s it.", "I'm done",
                      "nothing else", "Thanks", "Thank you, Quill", "Bye", "no, I'm good", "Never mind", "", "  "] {
            XCTAssertTrue(Conversation.isClosing(reply), "\(reply) should end the conversation")
        }
    }

    func testFollowUpQuestionsContinue() {
        for reply in ["And her sister?", "No wait, what about Mara?", "Thanks, and who is Elara?",
                      "Is that all of them?", "Stop the war chapter: when does it start?", "nobody else?"] {
            XCTAssertFalse(Conversation.isClosing(reply), "\(reply) should be sent as a question")
        }
    }
}
