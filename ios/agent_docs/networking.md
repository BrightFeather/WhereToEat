# iOS Networking

All HTTP traffic goes through one file: `ios/WhereToEat/Networking/APIClient.swift`. Endpoint definitions sit beside it in `Endpoints.swift`.

## Singleton

```swift
APIClient.shared.request(.weeklyRestaurants(city: "nyc"), as: WeeklyResponse.self)
```

`APIClient` is a `final class` with a `static let shared = APIClient()` (`APIClient.swift:31`). 30s `URLSession` timeout (`:38`).

## Base URL resolution

Order, top-to-bottom (`APIClient.swift:49-57`):

1. **`dev_api_base_url` UserDefaults key** — per-install override. Lets you point at a Mac LAN IP / ngrok tunnel without rebuilding.
2. **`API_BASE_URL` Info.plist key** — per-build-config override (set via xcconfig).
3. **`https://wheretoeat-red.vercel.app`** — default. Works everywhere (sim, device, Wi-Fi, cellular).

`localhost:3000` is **never** the default — a physical iPhone resolves localhost to its own loopback and can never reach the Mac.

## Request flow

`APIClient.request(_:as:)` at `APIClient.swift:60`:

1. Build `URLComponents` from `baseURL + endpoint.path` and attach `endpoint.queryItems` (`:61-66`).
2. Set method, `Content-Type: application/json`, and `X-User-Id` from `IdentityService.shared.userId` (`:68-71`).
3. Serialize `endpoint.body` to JSON via `JSONSerialization` (`:73-75`). The body is `[String: Any]?` so it accepts heterogeneous payloads.
4. Log `[API] →` (`:78-81`), perform `session.data(for:)` (`:86`).
5. Log `[API] ← <status> <path> (<ms>ms, <bytes>B)` (`:92-94`).
6. **401 → `APIError.unauthorized`** (`:96-98`).
7. **Non-2xx → `APIError.serverError`** with code `HTTP_<status>` and a message decoded from JSON `error` if present (`:100-112`).
8. Decode `APIResponse<T>` envelope (`:114-122`). Logs the raw body on decode failure.
9. Unwrap `success` + `data` (`:124-130`).

## Response envelope

`APIResponse<T>` at `APIClient.swift:23-28`:

```swift
struct APIResponse<T: Decodable>: Decodable {
    var success: Bool
    var data: T?
    var error: String?
    var code: String?
}
```

Mirrors the backend `ok()` / `err()` builders at `backend/api/_lib/types.ts:14-20`.

## Errors

`APIError` enum at `APIClient.swift:3-21`. Cases: `invalidURL`, `noData`, `serverError(code:message:)`, `decodingError(Error)`, `networkError(Error)`, `unauthorized`. All carry a `LocalizedError.errorDescription`.

## `Endpoint`

`enum Endpoint` at `Endpoints.swift:3-115`. Every backend route has a case with:

- `path: String` — `/api/...`
- `method: String` — `GET` / `POST` / `PATCH` / `DELETE`
- `queryItems: [URLQueryItem]?` — only set for `GET`s with params
- `body: [String: Any]?` — only set for write methods

Adding a new route = add a case + extend the four switches. Don't make HTTP calls outside `APIClient`.

## Logging convention

Three log prefixes — keep them when editing:

```
[API] → POST https://…/api/restaurants/import-xhs
[API]   body: ["url": "https://xhslink.com/…"]
[API] ← 200 /api/restaurants/import-xhs (1234ms, 2048B)
[API] ✗ HTTP 500 /api/restaurants/import-xhs: …
```

## Auth header (future)

Today every request carries `X-User-Id`. Once Apple/Google sign-in ships and `AuthService.signedIn == true`, attach `Authorization: Bearer <token>` on the same request — backend `withUser` will keep using `X-User-Id` and `auth/login` is the migration point.
