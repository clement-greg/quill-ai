import Foundation

/// Reply to `POST /api/tasks/voice`.
struct SpokenTaskResult: Decodable {
    let saved: Bool
    /// True when the server couldn't tell which book the task is for.
    let needsBook: Bool?
    /// The author's book titles, when `needsBook` is true.
    let books: [String]?
    /// A sentence for Siri to say.
    let spoken: String
}

/// What the server says after a note is dictated: same shape as a dictated task.
typealias SpokenNoteResult = SpokenTaskResult

/// One task as the summary endpoint returns it (only the fields Siri reads).
struct QuillTaskItem: Decodable {
    let id: String
    let title: String
    let dueDate: String?
    let bookTitle: String?
}

/// Reply to `GET /api/tasks/summary`.
struct TaskSummary: Decodable {
    let open: Int
    let overdue: Int
    let dueThisWeek: Int
    let next: [QuillTaskItem]
}

enum TaskSpeech {
    /// "Which book is it for? You have Lithium, and Cobalt."
    static func whichBook(_ books: [String]) -> String {
        guard !books.isEmpty else { return "Which book is it for?" }
        return "Which book is it for? You have \(list(books))."
    }

    /// A spoken rundown of the open tasks, e.g. "You have 4 open tasks, 1 overdue. Next up: …".
    static func summary(_ s: TaskSummary, today: Date = Date(), calendar: Calendar = .current) -> String {
        guard s.open > 0 else { return "You don't have any open tasks." }
        var head = s.open == 1 ? "You have one open task" : "You have \(s.open) open tasks"
        if s.overdue > 0 { head += ", \(s.overdue) overdue" }
        head += "."
        let items = s.next.map { task -> String in
            var line = task.title
            if let due = task.dueDate, let phrase = duePhrase(due, today: today, calendar: calendar) { line += ", \(phrase)" }
            return line
        }
        guard !items.isEmpty else { return head }
        return "\(head) \(s.next.count == 1 ? "Next up" : "Next up are"): \(list(items, separator: "; "))."
    }

    /// "overdue", "due today", "due tomorrow", "due Friday" (within a week), else "due March 4".
    static func duePhrase(_ date: String, today: Date, calendar: Calendar) -> String? {
        let parts = date.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
              let due = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { return nil }
        let start = calendar.startOfDay(for: today)
        guard let days = calendar.dateComponents([.day], from: start, to: due).day else { return nil }
        if days < 0 { return "overdue" }
        if days == 0 { return "due today" }
        if days == 1 { return "due tomorrow" }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US")
        formatter.dateFormat = days < 7 ? "EEEE" : "MMMM d"
        return "due \(formatter.string(from: due))"
    }

    private static func list(_ items: [String], separator: String = ", ") -> String {
        guard items.count > 1 else { return items.first ?? "" }
        return items.dropLast().joined(separator: separator) + "\(separator)and " + items.last!
    }
}
