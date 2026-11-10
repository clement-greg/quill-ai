# Quill AI for iPhone

A thin native wrapper around the Quill AI web app. The app itself is the
website in a `WKWebView`; the Swift code only adds what a web page can't do:

- **Siri.** Two commands, available as soon as the app is installed with no
  setup in the Shortcuts app:
  - *"Hey Siri, save a thought in Quill AI"*: Siri asks "What's the thought?" and
    saves your answer to Thoughts.
  - *"Hey Siri, ask Quill AI"*: Siri asks what you'd like to know and reads the
    answer. This covers story questions and finding saved thoughts ("what was my
    thought about bandaids?").
  - Both also appear in the Shortcuts app and Spotlight, and can be assigned to the
    Action button.
- **Google sign-in.** Google blocks sign-in inside embedded web views, so the app
  signs in through Apple's sign-in sheet (`GoogleSignIn.swift`), the same idea
  the desktop app uses with the system browser.

## How it fits together

| Piece | Where |
|---|---|
| Web view and the `window.quillNative` bridge | `QuillAI/WebView.swift` |
| Bridge, web side (sign-in, sharing the session) | `client/src/app/core/native/quill-native.ts` |
| Sign-in sheet hand-off (`/login?nativeCallback=quillai`) | `QuillAI/GoogleSignIn.swift`, `client/src/app/features/login/login.ts` |
| Refresh token for Siri, in the Keychain | `QuillAI/SessionStore.swift` |
| Siri commands | `QuillAI/QuillIntents.swift` |
| API calls Siri makes | `QuillAI/QuillAPI.swift`: `POST /api/thoughts`, `POST /api/chat-sessions/voice` |

When you sign in, the web app passes its refresh token to the native side.
Siri commands exchange it for a fresh access token at `/api/auth/refresh` and
store the rotated token, so Siri keeps working as long as it's used at least
once every 30 days (or you open the app). Signing out in the app clears it.

Simulator builds load `http://localhost:6258` (run `npm run dev` first);
device builds load the hosted site (`AppConfig.swift`).

## One-time setup

1. **Install Xcode** from the Mac App Store, open it once, and let it install
   its components. When it asks which platforms to download, include **iOS**.
2. **Sign Xcode in to your Apple Developer account:** Xcode → Settings →
   Accounts → **+** → Apple ID.
3. **Open the project:** `open ios/QuillAI.xcodeproj`
4. **Pick your team:** select the **QuillAI** project in the left sidebar →
   **QuillAI** target → **Signing & Capabilities** → *Team* → your team. If Xcode
   says the bundle identifier is taken, change `app.quillai.ios` to something
   unique to you (e.g. `com.yourname.quillai`) there and in `project.yml`.

## Running it

- **Simulator:** start the dev server (`npm run dev` in the repo root), choose an
  iPhone simulator in Xcode's toolbar, and press **Run** (⌘R).
- **Your iPhone:**
  1. Connect it by cable the first time, and unlock it.
  2. On the phone: Settings → Privacy & Security → **Developer Mode** → on
     (it restarts).
  3. Choose your iPhone in Xcode's toolbar and press **Run**.
  4. Open Quill AI on the phone and **sign in**. Siri can't do anything until
     you've signed in once.
  5. Try *"Hey Siri, save a thought in Quill AI."*

Builds installed this way with a paid developer account last a year. To share
with others, or to install without Xcode, use TestFlight: Product → Archive →
Distribute App → TestFlight.

## Changing the project

`project.yml` is the source of truth for the Xcode project (generated with
[XcodeGen](https://github.com/yonaskolb/XcodeGen)). After adding files or
changing settings, run `cd ios && xcodegen` and commit the regenerated
`QuillAI.xcodeproj`. Adding or editing Swift files inside Xcode works too, but
regenerating from `project.yml` will drop anything not captured there.
