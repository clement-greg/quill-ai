import Foundation
import Security

/// The signed-in user's refresh token, kept in the Keychain so Siri commands and
/// the home-screen widgets can reach the API without the web view. The web app
/// hands it over on sign-in and after every refresh (see WebView's bridge), and
/// clears it on sign-out.
///
/// It lives in a Keychain group shared by the app and its widget extension
/// (`QuillKeychainGroup` in each Info.plist, granted by `keychain-access-groups`).
enum SessionStore {
    private static let service = "app.quillai.session"
    private static let account = "refreshToken"

    /// The shared access group, e.g. `ABCDE12345.com.elevatehomescriptions.quillai.shared`.
    private static let accessGroup = Bundle.main.object(forInfoDictionaryKey: "QuillKeychainGroup") as? String

    static var refreshToken: String? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        var item: CFTypeRef?
        var status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound || status == errSecMissingEntitlement {
            // Saved before the shared group existed (or a build without it): look anywhere this app can.
            query.removeValue(forKey: kSecAttrAccessGroup as String)
            status = SecItemCopyMatching(query as CFDictionary, &item)
        }
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String?) {
        // Without an access group this removes the item from every group the app
        // can reach, including the pre-sharing copy.
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        guard let token, let data = token.data(using: .utf8) else { return }
        var add = base
        add[kSecValueData as String] = data
        // Readable after the first unlock since boot, so Siri and widgets work while the phone is locked.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        if let accessGroup {
            var shared = add
            shared[kSecAttrAccessGroup as String] = accessGroup
            if SecItemAdd(shared as CFDictionary, nil) == errSecSuccess { return }
        }
        SecItemAdd(add as CFDictionary, nil)
    }
}
