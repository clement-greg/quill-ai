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

    /// Asks Quill a question and returns the spoken-style answer. `history` is
    /// the conversation so far, so follow-ups are answered in context.
    static func ask(_ question: String, history: [VoiceTurn] = []) async throws -> String {
        struct Answer: Decodable { let answer: String }
        let body: [String: Any] = [
            "question": question,
            "messages": history.map { ["role": $0.role.rawValue, "content": $0.content] },
            // So "what's due Friday" and new tasks' due dates use the phone's calendar.
            "tz": TimeZone.current.identifier,
        ]
        let data = try await authorizedPOST("/api/chat-sessions/voice", body: body)
        return try JSONDecoder().decode(Answer.self, from: data).answer
    }

    /// Adds a task dictated to Siri. The server works out the title, book, and due
    /// date; when it can't tell the book it returns `needsBook` with the choices,
    /// and the caller asks and retries with `bookName`.
    static func addTask(_ text: String, bookName: String? = nil) async throws -> SpokenTaskResult {
        var body: [String: Any] = ["text": text, "tz": TimeZone.current.identifier]
        if let bookName { body["bookName"] = bookName }
        let data = try await authorizedPOST("/api/tasks/voice", body: body)
        return try JSONDecoder().decode(SpokenTaskResult.self, from: data)
    }

    /// Open-task counts and the most pressing few, in the phone's time zone.
    static func taskSummary(limit: Int = 3) async throws -> TaskSummary {
        let data = try await authorizedGET("/api/tasks/summary", query: [
            URLQueryItem(name: "tz", value: TimeZone.current.identifier),
            URLQueryItem(name: "limit", value: String(limit)),
        ])
        return try JSONDecoder().decode(TaskSummary.self, from: data)
    }

    /// Writing activity for the last `days` days, bucketed in the phone's time zone.
    static func writingStats(days: Int) async throws -> WritingStatsResponse {
        let token = try await accessToken()
        var components = URLComponents(url: AppConfig.baseURL.appendingPathComponent("/api/user-stats/writing"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "days", value: String(days)),
            URLQueryItem(name: "tz", value: TimeZone.current.identifier),
        ]
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw QuillAPIError.server(message(from: data, fallback: "Couldn't load writing stats."))
        }
        return try JSONDecoder().decode(WritingStatsResponse.self, from: data)
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

    private static func authorizedPOST(_ path: String, body: [String: Any]) async throws -> Data {
        let token = try await accessToken()
        let (data, response) = try await post(path, body: body, token: token)
        guard (200..<300).contains(response.statusCode) else {
            throw QuillAPIError.server(message(from: data, fallback: "Quill AI ran into a problem. Try again."))
        }
        return data
    }

    private static func authorizedGET(_ path: String, query: [URLQueryItem]) async throws -> Data {
        let token = try await accessToken()
        var components = URLComponents(url: AppConfig.baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.queryItems = query
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw QuillAPIError.server(message(from: data, fallback: "Quill AI ran into a problem. Try again."))
        }
        return data
    }

    private static func post(_ path: String, body: [String: Any], token: String?) async throws -> (Data, HTTPURLResponse) {
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
