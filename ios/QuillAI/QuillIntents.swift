import AppIntents

/// "Hey Siri, save a thought in Quill AI" → Siri asks for the thought, then saves it.
struct SaveThoughtIntent: AppIntent {
    static let title: LocalizedStringResource = "Save a Thought"
    static let description = IntentDescription("Saves a thought to your Quill AI Thoughts list.")
    static let openAppWhenRun = false

    @Parameter(title: "Thought", requestValueDialog: "What's the thought?")
    var text: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .result(dialog: "There was nothing to save.") }
        try await QuillAPI.saveThought(trimmed)
        return .result(dialog: "Saved to your thoughts.")
    }
}

/// "Hey Siri, ask Quill AI" → Siri asks for the question, reads the answer, and
/// asks "Anything else?". Follow-ups stay in this conversation (answered with
/// the earlier turns as context) until the author says something like "no" or
/// "that's all", or stops replying. Covers finding thoughts too.
struct AskQuillIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Quill"
    static let description = IntentDescription(
        "Asks Quill about your story, characters, or saved thoughts, reads the answer, and takes follow-up questions."
    )
    static let openAppWhenRun = false

    @Parameter(title: "Question", requestValueDialog: "What would you like to ask?")
    var question: String

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        var history: [VoiceTurn] = []
        var current = question
        var answer = ""

        for turn in 1...Conversation.maxTurns {
            answer = try await QuillAPI.ask(current, history: history)
            history += [VoiceTurn(role: .user, content: current), VoiceTurn(role: .assistant, content: answer)]
            if turn == Conversation.maxTurns { break }

            // Read the answer and keep listening, still inside Quill rather than Siri.
            let reply: String
            do {
                reply = try await $question.requestValue(IntentDialog(stringLiteral: "\(answer) Anything else?"))
            } catch {
                // No reply, or the author dismissed Siri: the answer has already been read.
                return .result(value: answer, dialog: "")
            }
            if Conversation.isClosing(reply) {
                return .result(value: answer, dialog: "Okay.")
            }
            current = reply
        }
        return .result(value: answer, dialog: IntentDialog(stringLiteral: answer))
    }
}

/// Phrases Siri recognizes as soon as the app is installed; no setup in the Shortcuts app.
/// Every phrase must include the app name.
struct QuillShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SaveThoughtIntent(),
            phrases: [
                "Save a thought in \(.applicationName)",
                "Add a thought to \(.applicationName)",
                "New \(.applicationName) thought",
                "Save an idea in \(.applicationName)",
                "Add an idea to \(.applicationName)",
                "New \(.applicationName) idea",
                "Jot something down in \(.applicationName)",
            ],
            shortTitle: "Save a Thought",
            systemImageName: "lightbulb"
        )
        AppShortcut(
            intent: AskQuillIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) a question",
                "Ask \(.applicationName) something",
                "Question for \(.applicationName)",
                "Search my \(.applicationName) thoughts",
                "Search \(.applicationName)",
            ],
            shortTitle: "Ask Quill",
            systemImageName: "bubble.left.and.text.bubble.right"
        )
    }
}
