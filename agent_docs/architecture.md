# Architecture — iOS ↔ Backend

WhereToEat is two halves connected over HTTPS:

- **iOS app** (SwiftUI, single user, single device) — `ios/WhereToEat/`
- **Vercel serverless backend** (`@vercel/node`, TypeScript) — `backend/api/`

The backend's deployed URL is `https://wheretoeat-red.vercel.app`. The iOS client picks it up via `APIClient.swift` (see `ios/agent_docs/networking.md`).

## Topology

```
┌─────────────────────────┐         HTTPS (JSON)          ┌──────────────────────────────┐
│ iOS app                 │ ─────────────────────────────▶ │ Vercel serverless functions │
│  Views → ViewModels →   │   X-User-Id (Keychain UUID)    │   /api/restaurants/...      │
│  Services → APIClient   │   Authorization (Apple/Google) │   /api/user/...             │
└─────────────────────────┘                                │   /api/auth/login           │
                                                           │   /api/locations            │
                                                           └──────────────┬───────────────┘
                                                                          │
                            ┌─────────────────────────────────────────────┤
                            ▼                                             ▼
                  ┌──────────────────┐                          ┌────────────────────┐
                  │ Neon Postgres    │                          │ Vercel Blob        │
                  │ (prod)           │                          │ (Places photos)    │
                  └────────┬─────────┘                          └────────────────────┘
                           ▲
                           │ npm run push-data / scripts/_sync-fields-to-neon.ts
                  ┌────────┴─────────┐         ┌──────────────────┐
                  │ Local SQLite     │ ◀────── │ Local pipeline    │
                  │ backend/data/*.db│         │ scripts/ingest-* │
                  └──────────────────┘         └──────────────────┘
```

## Request lifecycle (iOS → backend)

1. View calls a ViewModel method (e.g. `HomeViewModel.refresh`).
2. ViewModel asks a Service (e.g. `WeeklyRestaurantService.shared.fetch(city:)`) — see `ios/WhereToEat/Services/WeeklyRestaurantService.swift:21`.
3. Service builds an `Endpoint` case from `ios/WhereToEat/Networking/Endpoints.swift:3` and calls `APIClient.shared.request(...)` at `ios/WhereToEat/Networking/APIClient.swift:60`.
4. `APIClient` adds `X-User-Id` from `IdentityService` at `APIClient.swift:71`, base-URL-resolves at `APIClient.swift:49-57`, and decodes the standard `APIResponse<T>` envelope at `APIClient.swift:23`.
5. Backend handler runs through `withRequestLogging` (`backend/api/_lib/logger.ts`) and, for user routes, `withUser` at `backend/api/_lib/withUser.ts:18` which upserts the user row.
6. Handler returns `{ success, data }` via `ok()` from `backend/api/_lib/types.ts:14` or `{ success, error, code }` via `err()` at `:18`.

## Two databases, one schema

`backend/api/_lib/db.ts` is a dual-backend tagged-template SQL helper:

- On Vercel (`process.env.VERCEL === '1'`) → Neon Postgres via `@neondatabase/serverless` (`db.ts:28-42`).
- Locally → SQLite via `better-sqlite3` (`db.ts:44-69`).

Both expose the same `sql\`...\`` template returning `Promise<Row[]>`. SQL must stay dialect-portable — see the rules in `db.ts:1-22` (no `julianday()`, INTEGER booleans, `ON CONFLICT` works on both).

Schema is defined in `backend/scripts/migrate.ts` for local SQLite and the cloud equivalent. Sync rules and table inventory live in `backend/agent_docs/data-model.md`.

## Pipeline execution model (2026-04-28)

The XHS / Resy / Eater ingest pipeline runs **locally**, not on Vercel — the Hobby tier 60s function cap is too short for a multi-source pagination crawl. The local runner writes to SQLite, then `npm run push-data` (or `scripts/_sync-fields-to-neon.ts` for column updates) ships rows to Neon.

Vercel still hosts:

- `POST /api/restaurants/import-xhs` — single-link XHS import path that fits inside 60s. See `backend/api/restaurants/import-xhs.ts:83`.
- `POST /api/restaurants/pipeline/run` — the full weekly pipeline. Has `maxDuration: 300` in `vercel.json` but **times out under Hobby**; kept deployed for future Pro reactivation. Auth via `CRON_SECRET` at `backend/api/restaurants/pipeline/run.ts:64-72`.
- `GET /api/restaurants/weekly` — reads the deck from Neon and serves it. Falls back gracefully through `ready` / `stale` / `building` states. See `backend/api/restaurants/weekly.ts:139-251`.

## Auth model

- **Anonymous default** — every install gets a Keychain UUID via `IdentityService` (`ios/WhereToEat/Services/IdentityService.swift`). It's attached to every request as `X-User-Id` and upserted into `users` by `withUser` (`backend/api/_lib/withUser.ts:18`).
- **Apple / Google sign-in** — `POST /api/auth/login` (`backend/api/auth/login.ts:1`) verifies the identity token via JWKS (`_lib/{appleAuth,googleAuth,jwtVerify}.ts`), then merges the anonymous id's `user_reservations` + `user_favorites` rows onto the verified subject id. iOS code is shipped; entitlement is gated until the Apple Developer Portal capability is enabled.

## Cross-references

- `agent_docs/api-contract.md` — endpoint inventory + shapes
- `agent_docs/glossary.md` — domain terms
- `ios/agent_docs/` — iOS-side details
- `backend/agent_docs/` — backend-side details
- `SPEC.md` — product spec
- `TASKS.md` — active queue
- `CLAUDE.md` — house rules
