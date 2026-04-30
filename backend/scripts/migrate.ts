/**
 * Run once to create local SQLite tables:
 *   npm run migrate
 *
 * For Neon Postgres (cloud) use:
 *   npm run migrate:cloud
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'wheretoeat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('Running SQLite migrations…');

db.exec(`
  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id               TEXT PRIMARY KEY,
    city             TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'running',
    started_at       TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at     TEXT,
    post_count       INTEGER,
    restaurant_count INTEGER,
    error_message    TEXT
  )
`);
console.log('✓ pipeline_runs');

db.exec(`
  CREATE TABLE IF NOT EXISTS xhs_restaurants (
    id                   TEXT PRIMARY KEY,
    city                 TEXT NOT NULL,
    restaurant_name      TEXT NOT NULL,
    address              TEXT,
    borough              TEXT,
    cuisine_type         TEXT,
    recommendation       TEXT,
    post_url             TEXT,
    post_created_at      TEXT,
    mention_count        INTEGER NOT NULL DEFAULT 1,
    total_likes          INTEGER NOT NULL DEFAULT 0,
    google_place_id      TEXT,
    google_maps_url      TEXT,
    google_display_name  TEXT,
    website_url          TEXT,
    photo_url            TEXT,
    is_available_this_week INTEGER NOT NULL DEFAULT 1,
    pipeline_run_id      TEXT REFERENCES pipeline_runs(id),
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
console.log('✓ xhs_restaurants');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_xhs_restaurants_city_run
    ON xhs_restaurants(city, pipeline_run_id)
`);
console.log('✓ index on xhs_restaurants(city, pipeline_run_id)');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_pipeline_runs_city_status
    ON pipeline_runs(city, status, started_at)
`);
console.log('✓ index on pipeline_runs(city, status)');

db.exec(`
  CREATE TABLE IF NOT EXISTS xhs_sources (
    id              TEXT PRIMARY KEY,
    restaurant_id   TEXT NOT NULL REFERENCES xhs_restaurants(id),
    post_url        TEXT NOT NULL,
    recommendation  TEXT,
    likes           INTEGER NOT NULL DEFAULT 0,
    post_created_at TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
console.log('✓ xhs_sources');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_xhs_sources_restaurant
    ON xhs_sources(restaurant_id)
`);
console.log('✓ index on xhs_sources(restaurant_id)');

// Per-post dedupe key — lets pipeline use ON CONFLICT upsert when it re-sees
// the same post in a later weekly run (likes/recommendation get refreshed).
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_xhs_sources_restaurant_post
    ON xhs_sources(restaurant_id, post_url)
`);
console.log('✓ unique index xhs_sources(restaurant_id, post_url)');

// Stable restaurant key across weekly pipeline runs. Without this every
// Monday mints a fresh UUID for the same restaurant and user-state tables
// (user_blocks, user_reservations) stop matching. Partial-index style for
// portability: SQLite can't do WHERE-clause unique indexes cleanly, so the
// pipeline treats the index as authoritative and falls back to INSERT for
// rows that lack google_place_id.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_xhs_restaurants_city_placeid
    ON xhs_restaurants(city, google_place_id)
    WHERE google_place_id IS NOT NULL
`);
console.log('✓ unique index xhs_restaurants(city, google_place_id)');

// Idempotent ALTER TABLE for columns added over time
const addCol = (col: string, type: string) => {
  try {
    db.exec(`ALTER TABLE xhs_restaurants ADD COLUMN ${col} ${type}`);
    console.log(`✓ added ${col}`);
  } catch {
    console.log(`· ${col} already exists`);
  }
};
addCol('photo_urls', 'TEXT');
addCol('resy_venue_id', 'TEXT');
addCol('resy_booking_url', 'TEXT');
addCol('opentable_rid', 'TEXT');
addCol('opentable_booking_url', 'TEXT');
addCol('neighborhood', 'TEXT');
addCol('features', 'TEXT');
addCol('google_rating', 'REAL');
addCol('google_user_rating_count', 'INTEGER');
addCol('instagram_url', 'TEXT');
addCol('latitude', 'REAL');
addCol('longitude', 'REAL');
// Pricing — Google Places New API `priceLevel` enum (PRICE_LEVEL_INEXPENSIVE
// / MODERATE / EXPENSIVE / VERY_EXPENSIVE); maps to $ / $$ / $$$ / $$$$ on
// cards. Null when Places didn't classify the listing.
addCol('price_level', 'TEXT');
// `updated_at` drives the etag the iOS client uses for `If-None-Match`
// requests on /api/restaurants/weekly. The trigger below makes sure every
// UPDATE bumps it without having to touch each writer (pipeline, backfill
// scripts, sqlite-to-neon push, etc.).
//
// IMPORTANT: SQLite rejects `ALTER TABLE ADD COLUMN ... DEFAULT (datetime('now'))`
// — non-constant defaults are not allowed on ADD COLUMN (CREATE TABLE is fine).
// We add the column with no default, then backfill existing rows in a
// follow-up UPDATE so the column ends up non-null everywhere.
addCol('updated_at', 'TEXT');
db.exec(`UPDATE xhs_restaurants SET updated_at = datetime('now') WHERE updated_at IS NULL`);

db.exec(`
  CREATE TRIGGER IF NOT EXISTS trg_xhs_restaurants_set_updated_at
  AFTER UPDATE ON xhs_restaurants
  FOR EACH ROW
  WHEN NEW.updated_at IS OLD.updated_at
  BEGIN
    UPDATE xhs_restaurants SET updated_at = datetime('now') WHERE id = NEW.id;
  END;
`);
console.log('✓ trigger trg_xhs_restaurants_set_updated_at');

// Multi-source attribution on xhs_sources. Lets the same canonical
// restaurant hold N rows in xhs_sources — one per XHS / Resy blog / Eater
// mention — each with its own verbatim author_quote in `recommendation`.
// All additive + defaulted so existing writers stay correct without changes.
const addSourceCol = (col: string, type: string) => {
  try {
    db.exec(`ALTER TABLE xhs_sources ADD COLUMN ${col} ${type}`);
    console.log(`✓ added xhs_sources.${col}`);
  } catch {
    console.log(`· xhs_sources.${col} already exists`);
  }
};
addSourceCol('source_type',  `TEXT NOT NULL DEFAULT 'xiaohongshu'`);
addSourceCol('source_title', 'TEXT');
addSourceCol('author',       'TEXT');

// --- User tables ---------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    display_name TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
console.log('✓ users');

db.exec(`
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
    created_at                TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
console.log('✓ user_reservations');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_user_reservations_user_datetime
    ON user_reservations(user_id, datetime)
`);
console.log('✓ index on user_reservations(user_id, datetime)');

db.exec(`
  CREATE TABLE IF NOT EXISTS user_favorites (
    user_id       TEXT NOT NULL REFERENCES users(id),
    restaurant_id TEXT NOT NULL,
    saved_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, restaurant_id)
  )
`);
// Snapshot the full iOS Restaurant JSON for custom-list imports (paste-link
// / share-sheet) that don't exist in xhs_restaurants. Mirrors the Neon
// migration. `try/catch` around ALTER so re-runs are idempotent.
try {
  db.exec(`ALTER TABLE user_favorites ADD COLUMN snapshot_json TEXT`);
} catch { /* column already exists */ }
console.log('✓ user_favorites (+ snapshot_json)');

// --- Auth columns on users (idempotent) ----------------------------------
// `auth_provider` is 'anonymous' for Keychain-only users, 'apple' or 'google'
// once they sign in. `apple_sub` / `google_sub` are the verified subject ids
// from the respective identity tokens — UNIQUE so a provider can't bind to
// two WhereToEat users. `email_verified` stored as 0/1 INTEGER for SQLite.
const addUserCol = (col: string, type: string) => {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
    console.log(`✓ users.${col} added`);
  } catch {
    console.log(`· users.${col} already exists`);
  }
};
addUserCol('auth_provider', `TEXT NOT NULL DEFAULT 'anonymous'`);
addUserCol('apple_sub',     'TEXT');
addUserCol('google_sub',    'TEXT');
addUserCol('email',         'TEXT');
addUserCol('email_verified','INTEGER NOT NULL DEFAULT 0');

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_sub  ON users(apple_sub)  WHERE apple_sub  IS NOT NULL`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL`);
console.log('✓ unique indexes on apple_sub / google_sub');

// --- Blocked restaurants per user ---------------------------------------
// Used by Discovery to drop cards the user has explicitly blocked or booked.
// `blocked_until` is nullable — null = block forever. The Discovery filter
// treats null as "still blocked".
db.exec(`
  CREATE TABLE IF NOT EXISTS user_blocked_restaurants (
    user_id       TEXT NOT NULL REFERENCES users(id),
    restaurant_id TEXT NOT NULL,
    blocked_until TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, restaurant_id)
  )
`);
console.log('✓ user_blocked_restaurants');

db.close();
console.log('\nMigration complete.');
