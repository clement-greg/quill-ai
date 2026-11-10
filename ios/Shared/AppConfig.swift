import Foundation

/// Where the web app and API live.
enum AppConfig {
    /// The hosted Quill AI site. Simulator builds use the local dev server
    /// (`npm run dev`) instead, so changes can be tried before they're deployed.
    static let baseURL: URL = {
        #if targetEnvironment(simulator)
        return URL(string: "http://localhost:6258")!
        #else
        return URL(string: "https://quill-ai-gjgegbgrgjdmdzbv.westus-01.azurewebsites.net")!
        #endif
    }()

    /// Custom URL scheme the login page hands the Google credential back on.
    /// Must match NATIVE_CALLBACK_SCHEME in client/src/app/core/native/quill-native.ts.
    static let callbackScheme = "quillai"

    /// Scheme for links into the app from widgets: `quillaiapp://open/<path>`
    /// opens `<baseURL>/<path>` in the web view. Separate from `callbackScheme`
    /// so it can't be confused with a sign-in callback.
    static let appLinkScheme = "quillaiapp"

    static let writingStatsDeepLink = URL(string: "\(appLinkScheme)://open/writing-stats")!

    /// The web page a `quillaiapp://open/<path>` link points at, or nil if it isn't one.
    static func webURL(forAppLink link: URL) -> URL? {
        guard link.scheme == appLinkScheme, link.host == "open" else { return nil }
        let path = link.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        // Only plain in-app paths: letters, digits, dashes and slashes.
        guard !path.isEmpty, path.range(of: "^[A-Za-z0-9/-]+$", options: .regularExpression) != nil else { return nil }
        return baseURL.appendingPathComponent(path)
    }
}
