import SwiftUI
import WidgetKit
import XCTest
@testable import Quill_AI

/// Renders each widget layout with sample data to PNGs for a visual check, and
/// covers the stats model the widgets depend on.
@MainActor
final class WidgetSnapshotTests: XCTestCase {
    func testStatsFillEveryDayAndFindTheBestDay() throws {
        let calendar = Calendar(identifier: .gregorian)
        var utc = calendar
        utc.timeZone = TimeZone(identifier: "UTC")!
        let now = ISO8601DateFormatter().date(from: "2026-11-09T18:00:00Z")!
        let json = """
        {"daily":[{"date":"2026-11-01","wordsAdded":120,"wordsDeleted":5,"chapters":[]},
                  {"date":"2026-11-09","wordsAdded":40,"wordsDeleted":0,"chapters":[]}],
         "summary":{"totalAdded":160,"totalDeleted":5,"netWords":155,"activeDays":2,"totalVersionsSaved":3,"currentStreak":1}}
        """
        let response = try JSONDecoder().decode(WritingStatsResponse.self, from: Data(json.utf8))
        let stats = WritingStats(response: response, rangeDays: 30, now: now, calendar: utc)

        XCTAssertEqual(stats.series.count, 30)
        XCTAssertEqual(stats.today?.added, 40)
        XCTAssertEqual(stats.bestDay?.added, 120)
        XCTAssertEqual(stats.net, 155)
        XCTAssertEqual(stats.series.filter { $0.added == 0 }.count, 28)
    }

    func testNoWritingHasNoBestDay() {
        let stats = WritingStats(rangeDays: 7, series: [], added: 0, deleted: 0, streak: 0)
        XCTAssertNil(stats.bestDay)
    }

    func testWordCountFormatting() {
        XCTAssertEqual(2_735.wordCount(signed: true), "+2,735")
        XCTAssertEqual((-21).wordCount(signed: true), "-21")
        XCTAssertEqual(12_340.wordCount(compact: true), "12.3k")
        XCTAssertEqual(20_000.wordCount(compact: true), "20k")
    }

    func testWidgetLinkOpensWritingStats() {
        XCTAssertEqual(AppConfig.webURL(forAppLink: AppConfig.writingStatsDeepLink)?.path, "/writing-stats")
        XCTAssertNil(AppConfig.webURL(forAppLink: URL(string: "quillaiapp://open/../evil?x=1")!))
        XCTAssertNil(AppConfig.webURL(forAppLink: URL(string: "https://example.com/open/writing-stats")!))
    }

    /// Writes PNGs to $QUILL_SNAPSHOT_DIR (set TEST_RUNNER_QUILL_SNAPSHOT_DIR). Skipped otherwise.
    func testRenderLayouts() throws {
        guard let dir = ProcessInfo.processInfo.environment["QUILL_SNAPSHOT_DIR"] else {
            throw XCTSkip("Set TEST_RUNNER_QUILL_SNAPSHOT_DIR to render widget images")
        }
        let stats = WritingStats.sample()
        for scheme in [ColorScheme.light, .dark] {
            let suffix = scheme == .light ? "light" : "dark"
            try render(SmallStatsView(stats: stats, range: .month), size: CGSize(width: 170, height: 170), scheme: scheme, to: "\(dir)/small-\(suffix).png")
            try render(MediumStatsView(stats: stats, range: .month), size: CGSize(width: 364, height: 170), scheme: scheme, to: "\(dir)/medium-\(suffix).png")
            try render(LargeStatsView(stats: stats, range: .month), size: CGSize(width: 364, height: 382), scheme: scheme, to: "\(dir)/large-\(suffix).png")
        }
        try render(TodayRectangularView(stats: stats), size: CGSize(width: 172, height: 76), scheme: .dark, homeScreen: false, to: "\(dir)/lock-rectangular.png")
        try render(StreakCircularView(stats: stats), size: CGSize(width: 76, height: 76), scheme: .dark, homeScreen: false, to: "\(dir)/lock-circular.png")
    }

    private func render<V: View>(_ view: V, size: CGSize, scheme: ColorScheme, homeScreen: Bool = true, to path: String) throws {
        let framed = view
            .padding(homeScreen ? 16 : 4)
            .frame(width: size.width, height: size.height)
            .background {
                if homeScreen {
                    StatsBackground()
                } else {
                    Color.black
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: homeScreen ? 22 : 12))
            .environment(\.colorScheme, scheme)
        let renderer = ImageRenderer(content: framed)
        renderer.scale = 3
        let data = try XCTUnwrap(renderer.uiImage?.pngData())
        try data.write(to: URL(fileURLWithPath: path))
    }
}
