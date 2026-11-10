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

/// "Hey Siri, add a task in Quill AI" → Siri asks for the task, the server works out
/// the book and due date from what was said, and Siri asks which book when it can't tell.
struct AddTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Add a Task"
    static let description = IntentDescription("Adds a to-do for one of your books, with a due date if you say one.")
    static let openAppWhenRun = false

    @Parameter(title: "Task", requestValueDialog: "What's the task?")
    var text: String

    @Parameter(title: "Book")
    var bookName: String?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .result(dialog: "There was no task to add.") }

        var result = try await QuillAPI.addTask(trimmed, bookName: bookName)
        if !result.saved, result.needsBook == true {
            let book = try await $bookName.requestValue(IntentDialog(stringLiteral: TaskSpeech.whichBook(result.books ?? [])))
            result = try await QuillAPI.addTask(trimmed, bookName: book)
            if !result.saved, result.needsBook == true {
                return .result(dialog: "I couldn't find that book, so the task wasn't added.")
            }
        }
        return .result(dialog: IntentDialog(stringLiteral: result.spoken))
    }
}

/// "Hey Siri, what's on my Quill AI task list" → reads the open-task count and the next few.
struct ListTasksIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Tasks"
    static let description = IntentDescription("Tells you how many tasks are open and which are most pressing.")
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let summary = try await QuillAPI.taskSummary(limit: 3)
        return .result(dialog: IntentDialog(stringLiteral: TaskSpeech.summary(summary)))
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
            intent: AddTaskIntent(),
            phrases: [
                "Add a task in \(.applicationName)",
                "Add a task to \(.applicationName)",
                "New \(.applicationName) task",
                "Add a to-do in \(.applicationName)",
                "Remind me in \(.applicationName)",
            ],
            shortTitle: "Add a Task",
            systemImageName: "checklist"
        )
        AppShortcut(
            intent: ListTasksIntent(),
            phrases: [
                "What's on my \(.applicationName) task list",
                "What are my \(.applicationName) tasks",
                "Read my \(.applicationName) tasks",
                "What's due in \(.applicationName)",
            ],
            shortTitle: "Open Tasks",
            systemImageName: "checklist.checked"
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
