import AuthenticationServices
import UIKit

/// Google blocks sign-in inside WKWebView, so sign-in runs in Apple's web-auth
/// sheet (a real Safari context) instead. The sheet opens the site's /login page
/// in hand-off mode; once Google returns, that page navigates to
/// `quillai://auth?state=…&credential=…`, which the sheet captures and closes.
/// The credential is then given to the web app, which completes sign-in with
/// the server exactly as it does in a browser.
@MainActor
final class GoogleSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    enum SignInError: LocalizedError {
        case cancelled
        case mismatched

        var errorDescription: String? {
            switch self {
            case .cancelled: return "Sign-in was cancelled."
            case .mismatched: return "Sign-in didn't match this request. Try again."
            }
        }
    }

    private var session: ASWebAuthenticationSession?
    private weak var anchor: UIWindow?

    init(anchor: UIWindow?) {
        self.anchor = anchor
    }

    /// Resolves with a Google ID token.
    func start() async throws -> String {
        let state = Self.randomState()
        var components = URLComponents(url: AppConfig.baseURL.appendingPathComponent("login"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "nativeCallback", value: AppConfig.callbackScheme),
            URLQueryItem(name: "nativeState", value: state),
        ]
        let loginURL = components.url!

        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: loginURL, callbackURLScheme: AppConfig.callbackScheme) { url, error in
                if let url {
                    continuation.resume(returning: url)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: SignInError.cancelled)
                } else {
                    continuation.resume(throwing: error ?? SignInError.cancelled)
                }
            }
            session.presentationContextProvider = self
            // Share Safari's cookies so an existing Google session can be reused.
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            session.start()
        }
        session = nil

        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in items.first(where: { $0.name == name })?.value }
        guard value("state") == state, let credential = value("credential"), !credential.isEmpty else {
            throw SignInError.mismatched
        }
        return credential
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { anchor ?? ASPresentationAnchor() }
    }

    private static func randomState() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
