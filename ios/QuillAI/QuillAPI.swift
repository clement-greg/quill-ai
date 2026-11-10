import Foundation

enum QuillAPIError: LocalizedError {
    case notSignedIn
    case server(String)

    var errorDescription: String? {
        switch self {
        case .notSignedIn:
            return "You're not signed in. Open Quill AI and sign in first."
        case .server(let message):
            return message
        }
    }
}

/// The few API calls Siri commands make, outside the web view.
enum QuillAPI {
    private struct TokenPair: Decodable {
        let token: String
        let refreshToken: String
    }

    private struct ErrorBody: Decodable {
        let error: String?
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        // Answers that search chapters can take a while; Siri keeps waiting.
        config.timeoutIntervalForRequest = 60
        return URLSession(configuration: config)
    }()

    /// Saves a thought to the user's Thoughts list.
    static func saveThought(_ text: String) async throws {
        _ = try await authorizedPOST("/api/thoughts", body: ["content": text])
    }

    /// Asks Quill a question and returns the spoken-style answer.
    static func ask(_ question: String) async throws -> String {
        struct Answer: Decodable { let answer: String }
        let data = try await authorizedPOST("/api/chat-sessions/voice", body: ["question": question])
        return try JSONDecoder().decode(Answer.self, from: data).answer
    }

    // MARK: - Plumbing

    /// Trades the stored refresh token for a short-lived access token, storing
    /// the rotated refresh token so the session keeps sliding forward.
    private static func accessToken() async throws -> String {
        guard let refresh = SessionStore.refreshToken else { throw QuillAPIError.notSignedIn }
        let (data, response) = try await post("/api/auth/refresh", body: ["refreshToken": refresh], token: nil)
        guard response.statusCode == 200 else {
            if response.statusCode == 401 {
                SessionStore.save(nil)
                throw QuillAPIError.notSignedIn
            }
            throw QuillAPIError.server(message(from: data, fallback: "Quill AI couldn't sign you in."))
        }
        let pair = try JSONDecoder().decode(TokenPair.self, from: data)
        SessionStore.save(pair.refreshToken)
        return pair.token
    }

    private static func authorizedPOST(_ path: String, body: [String: String]) async throws -> Data {
        let token = try await accessToken()
        let (data, response) = try await post(path, body: body, token: token)
        guard (200..<300).contains(response.statusCode) else {
            throw QuillAPIError.server(message(from: data, fallback: "Quill AI ran into a problem. Try again."))
        }
        return data
    }

    private static func post(_ path: String, body: [String: String], token: String?) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: AppConfig.baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw QuillAPIError.server("No response from Quill AI.") }
        return (data, http)
    }

    private static func message(from data: Data, fallback: String) -> String {
        (try? JSONDecoder().decode(ErrorBody.self, from: data).error) ?? fallback
    }
}
