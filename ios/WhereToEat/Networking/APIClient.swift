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

final class APIClient {
    static let shared = APIClient()

    private let session: URLSession
    private let baseURL: String

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)

        // Read base URL from Info.plist key API_BASE_URL
        self.baseURL = Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String
            ?? "https://your-app.vercel.app"
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

        if let body = endpoint.body {
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.networkError(error)
        }

        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            throw APIError.unauthorized
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
        return result
    }
}
