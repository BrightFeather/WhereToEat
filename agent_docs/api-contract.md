# API Contract

All endpoints live under `backend/api/`. Active routes (deployed) are listed below; archived routes under `backend/api-archive/` are not deployed and are excluded.

## Envelope

Every JSON response follows the same wrapper, defined at `backend/api/_lib/types.ts:1-20`:

```json
{ "success": true,  "data": <T> }
{ "success": false, "error": "<msg>", "code": "<CODE>" }
```

iOS decodes via `APIResponse<T>` at `ios/WhereToEat/Networking/APIClient.swift:23`.

## Headers

- `Content-Type: application/json` — set on every request (`APIClient.swift:70`).
- `X-User-Id: <Keychain UUID>` — required for `withUser`-wrapped routes; injected by `APIClient.swift:71`.
- `Authorization: Bearer <jwt>` — added when signed in (Apple/Google).

## Endpoint inventory

Endpoint cases on the iOS side are defined at `ios/WhereToEat/Networking/Endpoints.swift`.

### Weekly deck

**`GET /api/restaurants/weekly?city=<slug>`** — `backend/api/restaurants/weekly.ts:139`
- Returns the most recent completed pipeline output for a city, or a `stale` fallback, or `building`.
- Response data shape: `{ status: 'ready' | 'stale' | 'building', restaurants?: WeeklyRestaurant[], pipelineStartedAt?: string }`.
- `WeeklyRestaurant` shape: `weekly.ts:23-53` (id, restaurantName, address, borough, neighborhood, cuisineType, recommendation, postUrl, postCreatedAt, mentionCount, totalLikes, googlePlaceId, googleMapsUrl, googleDisplayName, websiteUrl, photoUrl, photoUrls, features, googleRating, googleUserRatingCount, instagramUrl, resyBookingUrl, opentableBookingUrl, sources).
- `XHSSource` shape (per-post evidence rows): `weekly.ts:10-21` (postUrl, recommendation, likes, postCreatedAt, sourceType, author, sourceTitle).

**`PATCH /api/restaurants/{id}/unavailable`** — `backend/api/restaurants/[id]/unavailable.ts`
- Marks a restaurant as not-available-this-week so it drops out of the deck.

### Import (single XHS link)

**`POST /api/restaurants/import-xhs`** — `backend/api/restaurants/import-xhs.ts:83`
- Body: `{ url: string }` (a `xhslink.com` short URL or a full `xiaohongshu.com/explore/<noteId>` URL).
- Response: `{ postTitle: string, postUrl: string, restaurants: ImportedRestaurant[] }`.
- `ImportedRestaurant` shape: `import-xhs.ts:27-48`.
- Pipeline: redirect-resolve → noteId+xsec_token extract (`:50-81`) → `readNote` from `_lib/xhsScraper.ts` → LLM extract via `extractRestaurantData` → Places enrich → opportunistic Resy / OpenTable lookup → return.
- **xsec_token is single-use** — see memory `project_xhs_xsec_token_singleuse.md`. Real share-sheet flow is fine; smoke-tests must pull a fresh token per attempt.

### Pipeline (archived from deployed bundle)

**`POST /api/restaurants/pipeline/run`** — archived as `backend/api-archive/restaurants-pipeline/run.ts` (2026-04-28). Not deployed. The pipeline runs locally via `bash backend/scripts/run-pipeline.sh` → `npx ts-node backend/scripts/test-pipeline.ts`, then `npm run push-data` to Neon.

### Feedback

**`POST /api/feedback`** — `backend/api/feedback.ts`
- Body: `{ message: string, email?: string, appVersion?: string, deviceModel?: string, iosVersion?: string }`.
- Wrapped with `withUser` (requires `X-User-Id`). Server reads `users.email` as the `reply_to` fallback when the form `email` is empty.
- Sends an email to `prompt.and.ship@gmail.com` via Resend's REST API (`https://api.resend.com/emails`).
- Env: `RESEND_API_KEY` (required), `FEEDBACK_FROM` (optional, default `WhereToEat <onboarding@resend.dev>`).
- Errors: 400 `MISSING_MESSAGE` / `MESSAGE_TOO_LONG` (cap 5000 chars), 500 `NO_API_KEY`, 502 `RESEND_ERROR`.

### Auth

**`POST /api/auth/login`** — `backend/api/auth/login.ts`
- Body: `{ provider: 'apple' | 'google', idToken: string, anonymousUserId?: string, displayName?: string, email?: string }` (full shape inside the handler).
- Verifies the provider's JWT via JWKS, returns the verified user id, and migrates anonymous-id rows in `user_reservations` + `user_favorites`.
- Env: `APPLE_BUNDLE_IDS` (must include `com.weijia.wheretoeat`), `GOOGLE_IOS_CLIENT_IDS`.

### User state

All wrapped with `withUser` (`backend/api/_lib/withUser.ts:18`), which requires `X-User-Id` and upserts the user row.

**`POST /api/user/ensure`** — `backend/api/user/ensure.ts` — idempotent user-row upsert.

**`GET  /api/user/reservations`** — `backend/api/user/reservations/index.ts` — list reservations for the user.
**`POST /api/user/reservations`** — `index.ts` — create a reservation.
**`DELETE /api/user/reservations/{id}`** — `backend/api/user/reservations/[id].ts` — cancel.

**`GET  /api/user/blocks`** — `backend/api/user/blocks/index.ts` — list blocked restaurants.
**`POST /api/user/blocks`** — body: `{ restaurantId, blockedUntil? }`. Null `blockedUntil` = block forever.
**`DELETE /api/user/blocks/{restaurantId}`** — `backend/api/user/blocks/[restaurantId].ts` — unblock.

### Locations

**`GET /api/locations?city=<slug>`** — `backend/api/locations/index.ts` — returns the canonical borough → neighborhood mapping for a city. Backed by `backend/api/_lib/cityRegions.ts`.

## Status / error codes used

- `200 ok` — `success: true`.
- `400 MISSING_USER_ID` (`withUser`), `MISSING_URL` (`import-xhs`).
- `401 UNAUTHORIZED` — pipeline `CRON_SECRET` mismatch.
- `404 POST_NOT_FOUND` — XHS post couldn't be read (often a stale `xsec_token`).
- `405 METHOD_NOT_ALLOWED` — wrong verb on a route.
- `500 IMPORT_ERROR`, generic server errors.

## What's archived (not deployed)

`backend/api-archive/` holds routes parked because of the Hobby 12-function cap: `restaurants-pipeline/run` (XHS pipeline — runs locally), `places/enrich`, `reservations/{resy,opentable,tock}/{search,book}`, `scrape/{eater,xiaohongshu}`, `stripe/create-payment-intent`, `user/favorites`. To re-activate, move the file back into `backend/api/` and swap something else out — see `backend/CLAUDE.md`.
