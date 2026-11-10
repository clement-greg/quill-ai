import SwiftUI
import WidgetKit

@main
struct QuillAIApp: App {
    @Environment(\.scenePhase) private var scenePhase
    /// What the web view should show; replaced when a widget link opens the app.
    @State private var page = WebPage(url: AppConfig.baseURL)

    init() {
        // Re-registers the Siri phrases with iOS on every launch, so changes to
        // them take effect without waiting for the system to re-scan the app.
        QuillShortcuts.updateAppShortcutParameters()
    }

    var body: some Scene {
        WindowGroup {
            WebView(page: page)
                .ignoresSafeArea(.container, edges: .bottom)
                .onOpenURL { link in
                    if let url = AppConfig.webURL(forAppLink: link) { page = WebPage(url: url) }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            // New writing usually happens in the app; refresh the widgets as you leave it.
            if phase == .background { WidgetCenter.shared.reloadAllTimelines() }
        }
    }
}

/// A page to load; a new id forces a load even when the URL is unchanged.
struct WebPage: Equatable {
    let url: URL
    let id = UUID()
}
