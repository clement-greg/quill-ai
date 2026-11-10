import AppIntents
import WidgetKit

/// The time span a stats widget covers, chosen in the widget's settings.
enum StatsRange: Int, AppEnum {
    case week = 7
    case month = 30
    case quarter = 90

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Range"
    static let caseDisplayRepresentations: [StatsRange: DisplayRepresentation] = [
        .week: "7 days",
        .month: "30 days",
        .quarter: "90 days",
    ]

    var label: String { "\(rawValue) days" }
}

struct StatsEntry: TimelineEntry {
    enum Content: Equatable {
        case stats(WritingStats)
        case signedOut
        case unavailable
    }

    let date: Date
    let range: StatsRange
    let content: Content
}
