import SwiftUI
import WidgetKit

@main
struct QuillAIWidgetBundle: WidgetBundle {
    var body: some Widget {
        WritingStatsWidget()
    }
}

struct WritingStatsWidget: Widget {
    static let kind = "WritingStats"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: Self.kind, intent: StatsWidgetConfiguration.self, provider: StatsProvider()) { entry in
            StatsWidgetView(entry: entry)
                .widgetURL(AppConfig.writingStatsDeepLink)
        }
        .configurationDisplayName("Writing Stats")
        .description("Words you've written, your streak, and your best day.")
        .supportedFamilies([
            .systemSmall, .systemMedium, .systemLarge,
            .accessoryCircular, .accessoryRectangular, .accessoryInline,
        ])
    }
}
