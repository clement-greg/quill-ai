import XCTest
@testable import Quill_AI

final class TaskSpeechTests: XCTestCase {
    private var calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Denver")!
        return c
    }()

    /// Monday, March 2 2026, mid-morning.
    private var today: Date { calendar.date(from: DateComponents(year: 2026, month: 3, day: 2, hour: 10))! }

    private func summary(open: Int, overdue: Int = 0, next: [QuillTaskItem]) -> TaskSummary {
        TaskSummary(open: open, overdue: overdue, dueThisWeek: 0, next: next)
    }

    func testNoOpenTasks() {
        XCTAssertEqual(TaskSpeech.summary(summary(open: 0, next: []), today: today, calendar: calendar),
                       "You don't have any open tasks.")
    }

    func testReadsCountsAndNextTasksWithDuePhrases() {
        let s = summary(open: 4, overdue: 1, next: [
            QuillTaskItem(id: "1", title: "Fix the timeline", dueDate: "2026-02-27", bookTitle: "Lithium"),
            QuillTaskItem(id: "2", title: "Name the ferry", dueDate: "2026-03-06", bookTitle: "Lithium"),
            QuillTaskItem(id: "3", title: "Cut the dream", dueDate: nil, bookTitle: "Cobalt"),
        ])
        XCTAssertEqual(
            TaskSpeech.summary(s, today: today, calendar: calendar),
            "You have 4 open tasks, 1 overdue. Next up are: Fix the timeline, overdue; Name the ferry, due Friday; and Cut the dream."
        )
    }

    func testDuePhrases() {
        XCTAssertEqual(TaskSpeech.duePhrase("2026-03-02", today: today, calendar: calendar), "due today")
        XCTAssertEqual(TaskSpeech.duePhrase("2026-03-03", today: today, calendar: calendar), "due tomorrow")
        XCTAssertEqual(TaskSpeech.duePhrase("2026-03-20", today: today, calendar: calendar), "due March 20")
        XCTAssertNil(TaskSpeech.duePhrase("not a date", today: today, calendar: calendar))
    }

    func testWhichBookListsChoices() {
        XCTAssertEqual(TaskSpeech.whichBook(["Lithium", "Cobalt"]), "Which book is it for? You have Lithium, and Cobalt.")
        XCTAssertEqual(TaskSpeech.whichBook([]), "Which book is it for?")
    }

    func testDecodesSpokenTaskReply() throws {
        let json = #"{"saved":false,"needsBook":true,"books":["Lithium"],"spoken":"Which book is it for?"}"#
        let result = try JSONDecoder().decode(SpokenTaskResult.self, from: Data(json.utf8))
        XCTAssertFalse(result.saved)
        XCTAssertEqual(result.needsBook, true)
        XCTAssertEqual(result.books, ["Lithium"])
    }
}
