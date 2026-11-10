import Charts
import SwiftUI
import WidgetKit

/// Colors matching the Writing Stats page.
enum StatsPalette {
    static let teal = Color(red: 0.0, green: 0.41, blue: 0.48)
    static let bar = Color(red: 0.42, green: 0.70, blue: 0.53)
    static let best = Color(red: 0.95, green: 0.71, blue: 0.13)
    static let added = Color(red: 0.30, green: 0.62, blue: 0.33)
    static let deleted = Color(red: 0.85, green: 0.39, blue: 0.39)
    static let flame = Color(red: 0.96, green: 0.55, blue: 0.16)
}

/// Picks the layout for the widget's size; shows a prompt when there's no data.
struct StatsWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StatsEntry

    var body: some View {
        content
            .containerBackground(for: .widget) { background }
    }

    @ViewBuilder private var content: some View {
        switch entry.content {
        case .stats(let stats):
            switch family {
            case .systemSmall: SmallStatsView(stats: stats, range: entry.range)
            case .systemMedium: MediumStatsView(stats: stats, range: entry.range)
            case .systemLarge, .systemExtraLarge: LargeStatsView(stats: stats, range: entry.range)
            case .accessoryCircular: StreakCircularView(stats: stats)
            case .accessoryRectangular: TodayRectangularView(stats: stats)
            case .accessoryInline: TodayInlineView(stats: stats)
            @unknown default: SmallStatsView(stats: stats, range: entry.range)
            }
        case .signedOut:
            MessageView(icon: "person.crop.circle.badge.questionmark", text: "Open Quill AI and sign in to see your stats.")
        case .unavailable:
            MessageView(icon: "wifi.exclamationmark", text: "Couldn't load stats. Will try again soon.")
        }
    }

    @ViewBuilder private var background: some View {
        switch family {
        case .accessoryCircular, .accessoryRectangular, .accessoryInline:
            Color.clear
        default:
            StatsBackground()
        }
    }
}

/// Opaque page color with a faint teal wash toward the bottom, in light and dark.
struct StatsBackground: View {
    var body: some View {
        ZStack {
            Color(.systemBackground)
            LinearGradient(colors: [.clear, StatsPalette.teal.opacity(0.14)], startPoint: .top, endPoint: .bottom)
        }
    }
}

// MARK: - Home Screen

/// Small: net words for the range, streak, and a mini chart.
struct SmallStatsView: View {
    let stats: WritingStats
    let range: StatsRange

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: "pencil.and.scribble").foregroundStyle(StatsPalette.teal)
                Text("Writing").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                StreakBadge(streak: stats.streak)
            }
            Spacer(minLength: 0)
            Text(stats.net.wordCount(signed: true, compact: true))
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                .contentTransition(.numericText())
            Text("words · \(range.label)").font(.caption2).foregroundStyle(.secondary)
            DailyBarChart(series: stats.series, showAxes: false)
                .frame(height: 34)
                .padding(.top, 2)
        }
    }
}

/// Medium: the headline numbers beside the chart.
struct MediumStatsView: View {
    let stats: WritingStats
    let range: StatsRange

    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 4) {
                    Text("Writing · \(range.label)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
                Text(stats.net.wordCount(signed: true, compact: true))
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                Text("net words").font(.caption2).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                StatLine(icon: "plus.circle", color: StatsPalette.added, value: stats.added.wordCount(compact: true), label: "added")
                StatLine(icon: "minus.circle", color: StatsPalette.deleted, value: stats.deleted.wordCount(compact: true), label: "deleted")
                StatLine(icon: "flame", color: StatsPalette.flame, value: "\(stats.streak)", label: stats.streak == 1 ? "day streak" : "day streak")
            }
            .frame(maxWidth: 130, alignment: .leading)

            VStack(alignment: .leading, spacing: 4) {
                if let best = stats.bestDay {
                    Label {
                        Text("Best \(best.added.wordCount(compact: true)) · \(best.date.formatted(.dateTime.month(.abbreviated).day()))")
                    } icon: {
                        Image(systemName: "trophy.fill").foregroundStyle(StatsPalette.best)
                    }
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
                DailyBarChart(series: stats.series, showAxes: true, highlight: stats.bestDay)
            }
        }
    }
}

/// Large: the Writing Stats page in miniature.
struct LargeStatsView: View {
    let stats: WritingStats
    let range: StatsRange

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: "pencil.and.scribble").foregroundStyle(StatsPalette.teal)
                Text("Writing Stats").font(.headline)
                Spacer()
                Text(range.label).font(.caption.weight(.medium)).foregroundStyle(.secondary)
            }

            Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                GridRow {
                    StatTile(icon: "plus.circle", color: StatsPalette.added, value: stats.added.wordCount(compact: true), label: "Words Added")
                    StatTile(icon: "minus.circle", color: StatsPalette.deleted, value: stats.deleted.wordCount(compact: true), label: "Words Deleted")
                    StatTile(icon: "arrow.up.arrow.down", color: StatsPalette.teal, value: stats.net.wordCount(signed: true, compact: true), label: "Net Change")
                }
                GridRow {
                    StatTile(icon: "flame", color: StatsPalette.flame, value: "\(stats.streak)", label: "Day Streak")
                    StatTile(
                        icon: "trophy", color: StatsPalette.best,
                        value: stats.bestDay?.added.wordCount(compact: true) ?? "—",
                        label: stats.bestDay.map { "Best · \($0.date.formatted(.dateTime.month(.abbreviated).day()))" } ?? "Best Day"
                    )
                    StatTile(
                        icon: "sun.max", color: StatsPalette.teal,
                        value: (stats.today?.added ?? 0).wordCount(compact: true), label: "Today"
                    )
                }
            }

            DailyBarChart(series: stats.series, showAxes: true, highlight: stats.bestDay)
                .frame(maxHeight: .infinity)
        }
    }
}

// MARK: - Lock Screen

/// Circular: the streak.
struct StreakCircularView: View {
    let stats: WritingStats

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: "flame.fill").font(.caption)
                Text("\(stats.streak)").font(.system(.title3, design: .rounded).weight(.bold))
            }
        }
        .widgetAccentable()
    }
}

/// Rectangular: today's words, the streak, and the last week as bars.
struct TodayRectangularView: View {
    let stats: WritingStats

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Quill AI").font(.caption2.weight(.semibold)).widgetAccentable()
                Text("\((stats.today?.added ?? 0).wordCount(compact: true)) words today").font(.caption).lineLimit(1)
                Label("\(stats.streak)-day streak", systemImage: "flame.fill").font(.caption2).lineLimit(1)
            }
            Spacer(minLength: 0)
            DailyBarChart(series: Array(stats.series.suffix(7)), showAxes: false, monochrome: true)
                .frame(width: 44)
        }
    }
}

/// Inline: one line above the clock.
struct TodayInlineView: View {
    let stats: WritingStats

    var body: some View {
        Label("\((stats.today?.added ?? 0).wordCount(compact: true)) words today · \(stats.streak)🔥", systemImage: "pencil")
    }
}

// MARK: - Pieces

/// Words added per day as bars; the best day can be highlighted.
struct DailyBarChart: View {
    let series: [DayPoint]
    var showAxes: Bool
    var highlight: DayPoint? = nil
    var monochrome: Bool = false

    var body: some View {
        Chart(series) { day in
            BarMark(
                x: .value("Day", day.date, unit: .day),
                y: .value("Words", day.added)
            )
            .foregroundStyle(color(for: day))
            .cornerRadius(2)
        }
        .chartYScale(domain: 0...max(series.map(\.added).max() ?? 0, 1))
        .chartXAxis {
            if showAxes {
                AxisMarks(values: axisDates) { value in
                    // Pin the end labels inside the plot so they aren't clipped.
                    let anchor: UnitPoint = value.index == 0 ? .topLeading
                        : value.index == value.count - 1 ? .topTrailing : .top
                    AxisValueLabel(format: .dateTime.month(.defaultDigits).day(), anchor: anchor)
                }
            }
        }
        .chartYAxis {
            if showAxes {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
                    AxisGridLine().foregroundStyle(.secondary.opacity(0.25))
                    AxisValueLabel {
                        if let words = value.as(Int.self) { Text(words.wordCount(compact: true)) }
                    }
                }
            }
        }
        .chartPlotStyle { plot in
            plot.background(showAxes ? Color.clear : Color.secondary.opacity(0.06))
        }
    }

    private func color(for day: DayPoint) -> Color {
        if monochrome { return .primary }
        if let highlight, highlight.date == day.date { return StatsPalette.best }
        return StatsPalette.bar
    }

    /// First, middle and last day, so labels never crowd.
    private var axisDates: [Date] {
        guard let first = series.first?.date, let last = series.last?.date else { return [] }
        let middle = series[series.count / 2].date
        return series.count > 2 ? [first, middle, last] : [first, last]
    }
}

struct StreakBadge: View {
    let streak: Int

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "flame.fill").foregroundStyle(StatsPalette.flame)
            Text("\(streak)").fontWeight(.semibold)
        }
        .font(.caption)
    }
}

struct StatLine: View {
    let icon: String
    let color: Color
    let value: String
    let label: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon).foregroundStyle(color).frame(width: 14)
            Text(value).fontWeight(.semibold)
            Text(label).foregroundStyle(.secondary)
        }
        .font(.caption)
        .lineLimit(1)
    }
}

struct StatTile: View {
    let icon: String
    let color: Color
    let value: String
    let label: String

    var body: some View {
        VStack(spacing: 2) {
            Image(systemName: icon).foregroundStyle(color).font(.caption)
            Text(value).font(.system(.headline, design: .rounded).weight(.bold)).lineLimit(1).minimumScaleFactor(0.6)
            Text(label).font(.caption2).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 10))
    }
}

struct MessageView: View {
    let icon: String
    let text: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: icon).font(.title3).foregroundStyle(StatsPalette.teal)
            Text(text).font(.caption).multilineTextAlignment(.center).foregroundStyle(.secondary)
        }
    }
}
