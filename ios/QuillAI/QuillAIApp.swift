import SwiftUI

@main
struct QuillAIApp: App {
    init() {
        // Re-registers the Siri phrases with iOS on every launch, so changes to
        // them take effect without waiting for the system to re-scan the app.
        QuillShortcuts.updateAppShortcutParameters()
    }

    var body: some Scene {
        WindowGroup {
            WebView(url: AppConfig.baseURL)
                .ignoresSafeArea(.container, edges: .bottom)
        }
    }
}
