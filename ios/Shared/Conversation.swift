import Foundation

/// One turn of a spoken conversation with Quill.
struct VoiceTurn: Equatable {
    enum Role: String { case user, assistant }
    let role: Role
    let content: String
}

/// Helpers for Ask Quill's back-and-forth.
enum Conversation {
    /// Questions answered in one Siri session before it wraps up.
    static let maxTurns = 10

    /// Replies that end the conversation instead of being sent as a question.
    private static let closingPhrases: Set<String> = [
        "no", "nope", "nah", "no thanks", "no thank you", "not now",
        "that's all", "that is all", "that's it", "that is it", "thats all", "thats it",
        "i'm done", "im done", "i am done", "done", "all done", "i'm good", "im good", "i'm all set",
        "nothing", "nothing else", "that's everything", "stop", "cancel", "exit", "quit",
        "never mind", "nevermind", "thanks", "thank you", "thanks quill", "thank you quill",
        "bye", "goodbye", "good bye", "see you",
    ]

    /// Whether a reply to "Anything else?" means the author is finished.
    static func isClosing(_ reply: String) -> Bool {
        let normalized = reply
            .lowercased()
            .replacingOccurrences(of: "’", with: "'")
            .components(separatedBy: CharacterSet.letters.union(.whitespaces).union(CharacterSet(charactersIn: "'")).inverted)
            .joined()
            .split(separator: " ")
            .joined(separator: " ")
        if normalized.isEmpty { return true }
        if closingPhrases.contains(normalized) { return true }
        // "No, thanks", "no that's all", "nope, I'm good"…
        for lead in ["no ", "nope ", "nah "] where normalized.hasPrefix(lead) {
            let rest = String(normalized.dropFirst(lead.count))
            if closingPhrases.contains(rest) { return true }
        }
        return false
    }
}
