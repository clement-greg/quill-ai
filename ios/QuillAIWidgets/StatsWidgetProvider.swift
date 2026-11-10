import AppIntents
import WidgetKit

struct StatsWidgetConfiguration: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Writing Stats"
    static let description = IntentDescription("Words you've written, your streak, and your best day.")

    @Parameter(title: "Range", default: .month)
    var range: StatsRange
}

struct StatsProvider: AppIntentTimelineProvider {
    /// How often widgets refetch. The app also asks for a reload whenever it goes
    /// to the background, so new writing shows up sooner than this.
    static let refreshInterval: TimeInterval = 30 * 60

    func placeholder(in context: Context) -> StatsEntry {
        StatsEntry(date: .now, range: .month, content: .stats(.sample()))
    }

    func snapshot(for configuration: StatsWidgetConfiguration, in context: Context) async -> StatsEntry {
        if context.isPreview {
            return StatsEntry(date: .now, range: configuration.range, content: .stats(.sample(rangeDays: configuration.range.rawValue)))
        }
        return await entry(for: configuration.range)
    }

    func timeline(for configuration: StatsWidgetConfiguration, in context: Context) async -> Timeline<StatsEntry> {
        let entry = await entry(for: configuration.range)
        return Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(Self.refreshInterval)))
    }

    private func entry(for range: StatsRange) async -> StatsEntry {
        do {
            let response = try await QuillAPI.writingStats(days: range.rawValue)
            return StatsEntry(date: .now, range: range, content: .stats(WritingStats(response: response, rangeDays: range.rawValue)))
        } catch QuillAPIError.notSignedIn {
            return StatsEntry(date: .now, range: range, content: .signedOut)
        } catch {
            return StatsEntry(date: .now, range: range, content: .unavailable)
        }
    }
}
