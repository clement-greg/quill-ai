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

/// "Hey Siri, ask Quill AI" → Siri asks for the question and reads the answer.
/// Covers finding thoughts too ("what was my thought about bandaids?").
struct AskQuillIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Quill"
    static let description = IntentDescription(
        "Asks Quill about your story, characters, or saved thoughts and reads the answer."
    )
    static let openAppWhenRun = false

    @Parameter(title: "Question", requestValueDialog: "What would you like to ask?")
    var question: String

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let answer = try await QuillAPI.ask(question)
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
            ],
            shortTitle: "Save a Thought",
            systemImageName: "lightbulb"
        )
        AppShortcut(
            intent: AskQuillIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) a question",
                "Search my \(.applicationName) thoughts",
            ],
            shortTitle: "Ask Quill",
            systemImageName: "bubble.left.and.text.bubble.right"
        )
    }
}
