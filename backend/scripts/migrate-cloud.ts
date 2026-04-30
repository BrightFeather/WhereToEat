/**
 * Run once to create Postgres tables in Neon:
 *   npm run migrate
 *
 * Reads DATABASE_URL from .env.local (run `vercel env pull` first).
 * Idempotent: safe to re-run; uses CREATE TABLE IF NOT EXISTS and
 * ADD COLUMN IF NOT EXISTS throughout.
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { neon } from '@neondatabase/serverless';

const url =
  process.env.DATABASE_URL ||
  process.env.WHERE_TO_EAT_DATABASE_URL ||
  process.env.WHERE_TO_EAT_POSTGRES_URL ||
  process.env.POSTGRES_URL;
if (!url) throw new Error('No Neon connection string in env — run `vercel env pull` first');
const sql = neon(url);

async function main() {
  console.log('Running migrations against Neon…');

  await sql`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id               TEXT PRIMARY KEY,
      city             TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'running',
      started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at     TIMESTAMPTZ,
      post_count       INTEGER,
      restaurant_count INTEGER,
      error_message    TEXT
    )
  `;
  console.log('✓ pipeline_runs');

  await sql`
    CREATE TABLE IF NOT EXISTS xhs_restaurants (
      id                     TEXT PRIMARY KEY,
      city                   TEXT NOT NULL,
      restaurant_name        TEXT NOT NULL,
      address                TEXT,
      borough                TEXT,
      neighborhood           TEXT,
      cuisine_type           TEXT,
      recommendation         TEXT,
      post_url               TEXT,
      post_created_at        TEXT,
      mention_count          INTEGER NOT NULL DEFAULT 1,
      total_likes            INTEGER NOT NULL DEFAULT 0,
      google_place_id        TEXT,
      google_maps_url        TEXT,
      google_display_name    TEXT,
      website_url            TEXT,
      photo_url              TEXT,
      photo_urls             TEXT,
      resy_venue_id          TEXT,
      resy_booking_url       TEXT,
      opentable_rid          TEXT,
      opentable_booking_url  TEXT,
      features               TEXT,
      is_available_this_week INTEGER NOT NULL DEFAULT 1,
      pipeline_run_id        TEXT REFERENCES pipeline_runs(id),
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  console.log('✓ xhs_restaurants');

  await sql`
    CREATE INDEX IF NOT EXISTS idx_xhs_restaurants_city_run
      ON xhs_restaurants(city, pipeline_run_id)
  `;
  console.log('✓ index xhs_restaurants(city, pipeline_run_id)');

  await sql`
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_city_status
      ON pipeline_runs(city, status, started_at)
  `;
  console.log('✓ index pipeline_runs(city, status)');

  await sql`
    CREATE TABLE IF NOT EXISTS xhs_sources (
      id              TEXT PRIMARY KEY,
      restaurant_id   TEXT NOT NULL REFERENCES xhs_restaurants(id),
      post_url        TEXT NOT NULL,
      recommendation  TEXT,
      likes           INTEGER NOT NULL DEFAULT 0,
      post_created_at TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  console.log('✓ xhs_sources');

  await sql`
    CREATE INDEX IF NOT EXISTS idx_xhs_sources_restaurant
      ON xhs_sources(restaurant_id)
  `;
  console.log('✓ index xhs_sources(restaurant_id)');

  // Per-post dedupe key for the pipeline's ON CONFLICT upsert when the same
  // post resurfaces on a later weekly run.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_xhs_sources_restaurant_post
      ON xhs_sources(restaurant_id, post_url)
  `;
  console.log('✓ unique xhs_sources(restaurant_id, post_url)');

  // Stable restaurant key across weekly runs. Partial index — the pipeline
  // only upserts when google_place_id is non-null and falls back to INSERT
  // for rows without a Places hit.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_xhs_restaurants_city_placeid
      ON xhs_restaurants(city, google_place_id)
      WHERE google_place_id IS NOT NULL
  `;
  console.log('✓ unique xhs_restaurants(city, google_place_id)');

  // Multi-source attribution on xhs_sources. One canonical restaurant can
  // have N source rows (one per XHS / Resy blog / Eater mention), each with
  // its own verbatim author_quote in `recommendation`. Additive + defaulted
  // so the XHS writer keeps working unchanged.
  await sql`ALTER TABLE xhs_sources ADD COLUMN IF NOT EXISTS source_type  TEXT NOT NULL DEFAULT 'xiaohongshu'`;
  await sql`ALTER TABLE xhs_sources ADD COLUMN IF NOT EXISTS source_title TEXT`;
  await sql`ALTER TABLE xhs_sources ADD COLUMN IF NOT EXISTS author       TEXT`;
  console.log('✓ xhs_sources multi-source columns (source_type, source_title, author)');

  // Map coordinates — needed for the Find tab's pin layer. Populated by
  // `placesEnricher` from the Places API `location` field; nullable so legacy
  // rows ingested before this migration still validate.
  await sql`ALTER TABLE xhs_restaurants ADD COLUMN IF NOT EXISTS latitude  DOUBLE PRECISION`;
  await sql`ALTER TABLE xhs_restaurants ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION`;
  console.log('✓ xhs_restaurants coordinates (latitude, longitude)');

  // `updated_at` drives the etag for /api/restaurants/weekly's
  // `If-None-Match` flow. Trigger keeps it correct without every backfill
  // script having to set it manually — works for the Vercel pipeline path
  // *and* the laptop `npm run push-data` path, since both use UPSERT/UPDATE.
  await sql`ALTER TABLE xhs_restaurants ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`;
  console.log('✓ xhs_restaurants.updated_at');

  await sql`
    CREATE OR REPLACE FUNCTION trg_xhs_restaurants_set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `;
  await sql`DROP TRIGGER IF EXISTS xhs_restaurants_set_updated_at ON xhs_restaurants`;
  await sql`
    CREATE TRIGGER xhs_restaurants_set_updated_at
    BEFORE UPDATE ON xhs_restaurants
    FOR EACH ROW EXECUTE FUNCTION trg_xhs_restaurants_set_updated_at()
  `;
  console.log('✓ trigger xhs_restaurants_set_updated_at');

  // --- User tables ---------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      display_name TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  console.log('✓ users');

  await sql`
    CREATE TABLE IF NOT EXISTS user_reservations (
      id                        TEXT PRIMARY KEY,
      user_id                   TEXT NOT NULL REFERENCES users(id),
      restaurant_id             TEXT NOT NULL,
      restaurant_name           TEXT NOT NULL,
      restaurant_photo_url      TEXT,
      datetime                  TEXT NOT NULL,
      party_size                INTEGER NOT NULL,
      confirmation_code         TEXT,
      platform                  TEXT,
      status                    TEXT NOT NULL DEFAULT 'confirmed',
      calendar_event_id         TEXT,
      reminder_notification_id  TEXT,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  console.log('✓ user_reservations');

  await sql`
    CREATE INDEX IF NOT EXISTS idx_user_reservations_user_datetime
      ON user_reservations(user_id, datetime)
  `;
  console.log('✓ index user_reservations(user_id, datetime)');

  await sql`
    CREATE TABLE IF NOT EXISTS user_favorites (
      user_id       TEXT NOT NULL REFERENCES users(id),
      restaurant_id TEXT NOT NULL,
      saved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, restaurant_id)
    )
  `;
  // Custom-list imports (paste-link / share-sheet) live entirely client-side
  // and never appear in `xhs_restaurants`. To round-trip them across devices
  // we snapshot the full iOS `Restaurant` JSON at save time. `null` for rows
  // that point at a weekly-deck restaurant (the backend already has the data).
  await sql`ALTER TABLE user_favorites ADD COLUMN IF NOT EXISTS snapshot_json JSONB`;
  console.log('✓ user_favorites (+ snapshot_json)');

  // --- Auth columns on users (idempotent) --------------------------------
  // `auth_provider` is 'anonymous' for Keychain-only users, 'apple' or
  // 'google' once they sign in. `apple_sub` / `google_sub` are the verified
  // subject ids from the respective identity tokens — UNIQUE so a provider
  // can't bind to two WhereToEat users.
  // `features` JSON array of normalized feature keys (see api/_lib/features.ts).
  // Separate from `cuisine_type` so region sub-cuisines (Sichuan, Cantonese)
  // and non-cuisine facets (coffee, brunch) don't pollute the coarse enum.
  await sql`ALTER TABLE xhs_restaurants ADD COLUMN IF NOT EXISTS features TEXT`;
  // Google Maps rating signals + Instagram profile link.
  await sql`ALTER TABLE xhs_restaurants ADD COLUMN IF NOT EXISTS google_rating REAL`;
  await sql`ALTER TABLE xhs_restaurants ADD COLUMN IF NOT EXISTS google_user_rating_count INTEGER`;
  await sql`ALTER TABLE xhs_restaurants ADD COLUMN IF NOT EXISTS instagram_url TEXT`;

  // Pricing — Places New API `priceLevel` enum drives $/$$/$$$/$$$$.
  await sql`ALTER TABLE xhs_restaurants ADD COLUMN IF NOT EXISTS price_level TEXT`;

  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider  TEXT NOT NULL DEFAULT 'anonymous'`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_sub      TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub     TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email          TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false`;
  console.log('✓ users auth columns');

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_sub  ON users(apple_sub)  WHERE apple_sub  IS NOT NULL`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL`;
  console.log('✓ unique indexes on apple_sub / google_sub');

  // --- Blocked restaurants per user -------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS user_blocked_restaurants (
      user_id       TEXT NOT NULL REFERENCES users(id),
      restaurant_id TEXT NOT NULL,
      blocked_until TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, restaurant_id)
    )
  `;
  console.log('✓ user_blocked_restaurants');

  console.log('\nMigration complete.');
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
