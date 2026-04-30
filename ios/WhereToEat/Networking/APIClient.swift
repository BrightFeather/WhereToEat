import Foundation

enum APIError: LocalizedError {
    case invalidURL
    case noData
    case serverError(code: String, message: String)
    case decodingError(Error)
    case networkError(Error)
    case unauthorized

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .noData: return "No data received"
        case .serverError(_, let msg): return msg
        case .decodingError(let e): return "Decoding error: \(e.localizedDescription)"
        case .networkError(let e): return e.localizedDescription
        case .unauthorized: return "Unauthorized"
        }
    }
}

struct APIResponse<T: Decodable>: Decodable {
    var success: Bool
    var data: T?
    var error: String?
    var code: String?
}

/// Result of a conditional `If-None-Match` request — see
/// `APIClient.requestConditional`. `notModified` is the cheap path: server
/// returned 304, no body, we can keep the cached payload as-is.
enum ConditionalResult<T: Decodable> {
    case notModified
    case ok(T, etag: String?)
}

final class APIClient {
    static let shared = APIClient()

    private let session: URLSession
    private let baseURL: String

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)

        // Resolution order:
        //   1. `dev_api_base_url` in UserDefaults — per-install override so you
        //      can point at a Mac LAN IP or ngrok tunnel without rebuilding.
        //   2. `API_BASE_URL` Info.plist key — per-build-config override.
        //   3. Deployed Vercel URL — works everywhere (simulator, device,
        //      Wi-Fi, cellular). `localhost:3000` is specifically *not* the
        //      default because a physical iPhone resolves localhost to its
        //      own loopback and can never reach the Mac.
        if let userOverride = UserDefaults.standard.string(forKey: "dev_api_base_url"),
           !userOverride.isEmpty {
            self.baseURL = userOverride
        } else if let plistOverride = Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String,
                  !plistOverride.isEmpty {
            self.baseURL = plistOverride
        } else {
            self.baseURL = "https://wheretoeat-red.vercel.app"
        }
    }

    func request<T: Decodable>(_ endpoint: Endpoint, as type: T.Type = T.self) async throws -> T {
        guard var components = URLComponents(string: baseURL + endpoint.path) else {
            throw APIError.invalidURL
        }
        components.queryItems = endpoint.queryItems

        guard let url = components.url else { throw APIError.invalidURL }

        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(IdentityService.shared.userId, forHTTPHeaderField: "X-User-Id")

        if let body = endpoint.body {
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }

        let start = Date()
        print("[API] → \(endpoint.method) \(url.absoluteString)")
        if let body = endpoint.body {
            print("[API]   body: \(body)")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            print("[API] ✗ \(endpoint.method) \(url.path) — network error: \(error.localizedDescription)")
            throw APIError.networkError(error)
        }

        let ms = Int(Date().timeIntervalSince(start) * 1000)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        print("[API] ← \(statusCode) \(url.path) (\(ms)ms, \(data.count)B)")

        if statusCode == 401 {
            throw APIError.unauthorized
        }

        // Non-2xx → don't try to decode as APIResponse. Surface a clear server error.
        if !(200...299).contains(statusCode) {
            let body = String(data: data, encoding: .utf8) ?? ""
            let message: String
            if let errJson = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let m = errJson["error"] as? String {
                message = m
            } else {
                message = body.isEmpty ? "HTTP \(statusCode)" : String(body.prefix(200))
            }
            print("[API] ✗ HTTP \(statusCode) \(url.path): \(message)")
            throw APIError.serverError(code: "HTTP_\(statusCode)", message: "Server error (\(statusCode)): \(message)")
        }

        let decoded: APIResponse<T>
        do {
            decoded = try JSONDecoder().decode(APIResponse<T>.self, from: data)
        } catch {
            let body = String(data: data, encoding: .utf8)?.prefix(500) ?? "<binary>"
            print("[API] ✗ decoding failed for \(url.path): \(error)")
            print("[API]   raw response: \(body)")
            throw APIError.decodingError(error)
        }

        guard decoded.success, let result = decoded.data else {
            let code = decoded.code ?? "unknown"
            let message = decoded.error ?? "Unknown error"
            print("[API] ✗ server error \(code): \(message)")
            throw APIError.serverError(code: code, message: message)
        }
        return result
    }

    /// GET-only conditional fetch. Pass `ifNoneMatch: cache.etag`; if the
    /// server returns 304 we hand back `.notModified` so the caller can keep
    /// using its cached payload. Otherwise we decode like `request(...)` and
    /// return `.ok(value, etag: <ETag header>)` for the caller to persist.
    func requestConditional<T: Decodable>(
        _ endpoint: Endpoint,
        ifNoneMatch: String?,
        as type: T.Type = T.self
    ) async throws -> ConditionalResult<T> {
        guard var components = URLComponents(string: baseURL + endpoint.path) else {
            throw APIError.invalidURL
        }
        components.queryItems = endpoint.queryItems
        guard let url = components.url else { throw APIError.invalidURL }

        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(IdentityService.shared.userId, forHTTPHeaderField: "X-User-Id")
        if let etag = ifNoneMatch, !etag.isEmpty {
            request.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }

        let start = Date()
        print("[API] → \(endpoint.method) \(url.absoluteString) [If-None-Match: \(ifNoneMatch ?? "—")]")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            print("[API] ✗ \(endpoint.method) \(url.path) — network error: \(error.localizedDescription)")
            throw APIError.networkError(error)
        }

        let ms = Int(Date().timeIntervalSince(start) * 1000)
        let http = response as? HTTPURLResponse
        let statusCode = http?.statusCode ?? 0
        print("[API] ← \(statusCode) \(url.path) (\(ms)ms, \(data.count)B)")

        if statusCode == 304 { return .notModified }
        if statusCode == 401 { throw APIError.unauthorized }

        if !(200...299).contains(statusCode) {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw APIError.serverError(
                code: "HTTP_\(statusCode)",
                message: "Server error (\(statusCode)): \(body.prefix(200))"
            )
        }

        let decoded: APIResponse<T>
        do {
            decoded = try JSONDecoder().decode(APIResponse<T>.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
        guard decoded.success, let result = decoded.data else {
            throw APIError.serverError(
                code: decoded.code ?? "unknown",
                message: decoded.error ?? "Unknown error"
            )
        }
        let etagHeader = http?.value(forHTTPHeaderField: "ETag")
        return .ok(result, etag: etagHeader)
    }
}
