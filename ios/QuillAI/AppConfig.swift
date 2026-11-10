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
}
