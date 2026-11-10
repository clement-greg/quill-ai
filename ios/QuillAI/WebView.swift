import SwiftUI
import WebKit
import WidgetKit

/// The whole Quill AI web app in a WKWebView, plus the `window.quillNative`
/// bridge the web app uses for sign-in and to share its session with Siri.
struct WebView: UIViewRepresentable {
    let page: WebPage

    func makeCoordinator() -> Coordinator {
        Coordinator(appURL: AppConfig.baseURL)
    }

    func makeUIView(context: Context) -> WKWebView {
        let contentController = WKUserContentController()
        contentController.addUserScript(
            WKUserScript(source: Coordinator.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        contentController.add(context.coordinator, name: Coordinator.handlerName)

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        #if DEBUG
        // Lets Safari's Develop menu inspect the page (Simulator and debug builds).
        webView.isInspectable = true
        #endif
        context.coordinator.webView = webView
        context.coordinator.loadedPage = page.id
        webView.load(URLRequest(url: page.url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.loadedPage != page.id else { return }
        context.coordinator.loadedPage = page.id
        webView.load(URLRequest(url: page.url))
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        static let handlerName = "quillNative"

        /// Defines `window.quillNative` (see client/src/app/core/native/quill-native.ts).
        /// Promises are settled from Swift through `__quillNativeSettle`.
        static let bridgeScript = """
        (function () {
          if (window.quillNative) return;
          var pending = new Map();
          var seq = 0;
          var post = function (msg) { window.webkit.messageHandlers.\(handlerName).postMessage(msg); };
          Object.defineProperty(window, '__quillNativeSettle', {
            value: function (id, ok, value) {
              var p = pending.get(id);
              if (!p) return;
              pending.delete(id);
              if (ok) p.resolve(value); else p.reject(new Error(value));
            },
          });
          var call = function (type) {
            return new Promise(function (resolve, reject) {
              var id = ++seq;
              pending.set(id, { resolve: resolve, reject: reject });
              post({ type: type, id: id });
            });
          };
          window.quillNative = Object.freeze({
            platform: 'ios',
            signInWithGoogle: function () {
              return new Promise(function (resolve, reject) {
                var id = ++seq;
                pending.set(id, { resolve: resolve, reject: reject });
                post({ type: 'signIn', id: id });
              });
            },
            setSession: function (refreshToken) {
              post({ type: 'setSession', refreshToken: refreshToken == null ? null : String(refreshToken) });
            },
            speech: Object.freeze({
              voices: function () { return call('speechVoices'); },
              status: function () { return call('speechStatus'); },
              play: function (request) { post({ type: 'speechPlay', request: request }); },
              pause: function () { post({ type: 'speechPause' }); },
              resume: function () { post({ type: 'speechResume' }); },
              stop: function () { post({ type: 'speechStop' }); },
            }),
          });
        })();
        """

        let appURL: URL
        weak var webView: WKWebView?
        /// The `WebPage` last loaded, so a new one from a widget link loads exactly once.
        var loadedPage: UUID?
        private var signIn: GoogleSignIn?

        init(appURL: URL) {
            self.appURL = appURL
        }

        private func isAppOrigin(_ url: URL?) -> Bool {
            guard let url else { return false }
            return url.scheme == appURL.scheme && url.host == appURL.host && url.port == appURL.port
        }

        // MARK: Bridge messages

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            // Only the Quill AI site itself may use the bridge.
            let origin = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame,
                  origin.protocol == appURL.scheme, origin.host == appURL.host,
                  origin.port == (appURL.port ?? 0),
                  let body = message.body as? [String: Any],
                  let type = body["type"] as? String else { return }

            switch type {
            case "setSession":
                let token = body["refreshToken"] as? String
                let changed = (token == nil) != (SessionStore.refreshToken == nil)
                SessionStore.save(token)
                // Signing in or out changes what the widgets can show.
                if changed { WidgetCenter.shared.reloadAllTimelines() }
            case "signIn":
                guard let id = body["id"] as? Int else { return }
                runSignIn(id: id)
            case "speechPlay":
                guard let raw = body["request"],
                      let data = try? JSONSerialization.data(withJSONObject: raw),
                      let request = try? JSONDecoder().decode(SpeechPlayRequest.self, from: data) else { return }
                connectSpeech()
                SpeechController.shared.play(request)
            case "speechPause":
                SpeechController.shared.pause()
            case "speechResume":
                SpeechController.shared.resume()
            case "speechStop":
                SpeechController.shared.stop()
            case "speechVoices":
                guard let id = body["id"] as? Int else { return }
                Task { await settle(id: id, ok: true, value: SpeechController.voices()) }
            case "speechStatus":
                guard let id = body["id"] as? Int else { return }
                Task { await settle(id: id, ok: true, value: SpeechController.shared.status) }
            default:
                break
            }
        }

        private func runSignIn(id: Int) {
            let signIn = GoogleSignIn(anchor: webView?.window)
            self.signIn = signIn
            Task {
                do {
                    let credential = try await signIn.start()
                    await settle(id: id, ok: true, value: credential)
                } catch {
                    await settle(id: id, ok: false, value: error.localizedDescription)
                }
                self.signIn = nil
            }
        }

        /// Sends the speech player's progress to the page as a `quillspeech` event.
        private func connectSpeech() {
            SpeechController.shared.onEvent = { [weak self] event in
                guard let webView = self?.webView else { return }
                Task {
                    _ = try? await webView.callAsyncJavaScript(
                        "window.dispatchEvent(new CustomEvent('quillspeech', { detail: detail }))",
                        arguments: ["detail": event],
                        contentWorld: .page
                    )
                }
            }
        }

        private func settle(id: Int, ok: Bool, value: Any) async {
            _ = try? await webView?.callAsyncJavaScript(
                "window.__quillNativeSettle(id, ok, value)",
                arguments: ["id": id, "ok": ok, "value": value],
                contentWorld: .page
            )
        }

        // MARK: Navigation

        /// Keeps the app's own pages in the web view; sends other http(s) links to Safari.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .allow }
            let isWeb = url.scheme == "http" || url.scheme == "https"
            if action.targetFrame?.isMainFrame != false, isWeb, !isAppOrigin(url), action.navigationType == .linkActivated {
                await UIApplication.shared.open(url)
                return .cancel
            }
            return .allow
        }

        /// `target="_blank"` links: open in Safari rather than silently doing nothing.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for action: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = action.request.url {
                if isAppOrigin(url) { webView.load(action.request) } else { UIApplication.shared.open(url) }
            }
            return nil
        }

        /// Reloads after the web content process is killed (e.g. memory pressure),
        /// instead of leaving a blank screen.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }
    }
}
