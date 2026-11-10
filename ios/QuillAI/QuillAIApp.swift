import SwiftUI

@main
struct QuillAIApp: App {
    var body: some Scene {
        WindowGroup {
            WebView(url: AppConfig.baseURL)
                .ignoresSafeArea(.container, edges: .bottom)
        }
    }
}
