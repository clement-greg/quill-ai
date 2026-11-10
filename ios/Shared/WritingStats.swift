import Foundation

/// The parts of `GET /api/user-stats/writing` the widgets use.
struct WritingStatsResponse: Decodable {
    struct Day: Decodable {
        let date: String // yyyy-MM-dd in the requested time zone
        let wordsAdded: Int
        let wordsDeleted: Int
    }

    struct Summary: Decodable {
        let totalAdded: Int
        let totalDeleted: Int
        let netWords: Int
        let activeDays: Int
        let currentStreak: Int
    }

    let daily: [Day]
    let summary: Summary
}

/// One calendar day of writing, including days with no activity.
struct DayPoint: Identifiable, Equatable {
    let date: Date
    let added: Int
    let deleted: Int

    var id: Date { date }
    var net: Int { added - deleted }
}

/// Writing stats shaped for display: a gap-free daily series plus the
/// headline numbers the Writing Stats page shows.
struct WritingStats: Equatable {
    let rangeDays: Int
    /// Every day in the range, oldest first, ending today.
    let series: [DayPoint]
    let added: Int
    let deleted: Int
    let streak: Int

    var net: Int { added - deleted }
    var today: DayPoint? { series.last }
    /// The day with the most words added (nil when nothing was written).
    var bestDay: DayPoint? { series.max { $0.added < $1.added }.flatMap { $0.added > 0 ? $0 : nil } }

    init(rangeDays: Int, series: [DayPoint], added: Int, deleted: Int, streak: Int) {
        self.rangeDays = rangeDays
        self.series = series
        self.added = added
        self.deleted = deleted
        self.streak = streak
    }

    /// Fills the server's sparse daily list into one point per day, ending `now`.
    init(response: WritingStatsResponse, rangeDays: Int, now: Date = .now, calendar: Calendar = .current) {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"

        let byDate = Dictionary(response.daily.map { ($0.date, $0) }, uniquingKeysWith: { a, _ in a })
        let today = calendar.startOfDay(for: now)
        let series: [DayPoint] = (0..<rangeDays).reversed().compactMap { offset in
            guard let day = calendar.date(byAdding: .day, value: -offset, to: today) else { return nil }
            let entry = byDate[formatter.string(from: day)]
            return DayPoint(date: day, added: entry?.wordsAdded ?? 0, deleted: entry?.wordsDeleted ?? 0)
        }
        self.init(
            rangeDays: rangeDays,
            series: series,
            added: response.summary.totalAdded,
            deleted: response.summary.totalDeleted,
            streak: response.summary.currentStreak
        )
    }

    /// Plausible numbers for widget previews and the gallery.
    static func sample(rangeDays: Int = 30, now: Date = .now, calendar: Calendar = .current) -> WritingStats {
        let today = calendar.startOfDay(for: now)
        let pattern = [0, 180, 0, 0, 420, 0, 0, 0, 1_240, 610, 0, 0, 0, 0, 260, 0, 0, 90, 0, 0, 0, 0, 0, 0, 0, 0, 340, 0, 120, 480]
        let series: [DayPoint] = (0..<rangeDays).reversed().compactMap { offset in
            guard let day = calendar.date(byAdding: .day, value: -offset, to: today) else { return nil }
            let added = pattern[(rangeDays - 1 - offset) % pattern.count]
            return DayPoint(date: day, added: added, deleted: added / 12)
        }
        return WritingStats(
            rangeDays: rangeDays,
            series: series,
            added: series.reduce(0) { $0 + $1.added },
            deleted: series.reduce(0) { $0 + $1.deleted },
            streak: 2
        )
    }
}

extension Int {
    /// 2,756 / +2,735; above 9,999 abbreviated as 12.3k.
    func wordCount(signed: Bool = false, compact: Bool = false) -> String {
        let sign = signed && self > 0 ? "+" : ""
        if compact, abs(self) >= 10_000 {
            return sign + String(format: "%.1fk", Double(self) / 1_000).replacingOccurrences(of: ".0k", with: "k")
        }
        return sign + self.formatted(.number)
    }
}
