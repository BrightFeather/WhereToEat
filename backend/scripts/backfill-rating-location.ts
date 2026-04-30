/**
 * Backfill `google_rating`, `google_user_rating_count`, `latitude`, `longitude`
 * for every `xhs_restaurants` row that has a `google_place_id` but is missing
 * any of those four fields. One Places (New) "Place Details" call per row,
 * field-masked so we only pay for what we need. Idempotent — safe to re-run.
 *
 *   npx ts-node scripts/backfill-rating-location.ts
 *
 * Notes:
 *   - Editorial sources (eater / resy_blog) skipped these fields when we
 *     imported them, so most rows missing rating are also missing location.
 *     Doing both in one Place Details call halves the API spend.
 *   - Adds `latitude` / `longitude` columns to local SQLite if missing
 *     (schema drift between SQLite and Neon — Neon already has the columns).
 *   - Sleeps 250 ms between rows to stay polite. Bump RATE_LIMIT_MS via env.
 *
 * After running, push the new fields to Neon with:
 *   npx ts-node scripts/_sync-fields-to-neon.ts
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import Database from 'better-sqlite3';
import axios from 'axios';

const PLACES_DETAIL_BASE = 'https://places.googleapis.com/v1/places/';
const FIELD_MASK = 'rating,userRatingCount,location';
const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS ?? '250', 10);
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;
const DRY_RUN = process.env.DRY_RUN === '1';

const apiKey = process.env.GOOGLE_PLACES_API_KEY;
if (!apiKey) {
  console.error('GOOGLE_PLACES_API_KEY missing in .env.local');
  process.exit(1);
}

const db = new Database(path.join(__dirname, '../data/wheretoeat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema drift: SQLite is missing latitude/longitude columns ────────────
const cols = db
  .prepare(`PRAGMA table_info(xhs_restaurants)`)
  .all() as Array<{ name: string }>;
const colNames = new Set(cols.map((c) => c.name));
if (!colNames.has('latitude')) {
  console.log('[schema] adding latitude column to xhs_restaurants');
  db.exec(`ALTER TABLE xhs_restaurants ADD COLUMN latitude REAL`);
}
if (!colNames.has('longitude')) {
  console.log('[schema] adding longitude column to xhs_restaurants');
  db.exec(`ALTER TABLE xhs_restaurants ADD COLUMN longitude REAL`);
}

interface Row {
  id: string;
  restaurant_name: string;
  google_place_id: string;
  google_rating: number | null;
  google_user_rating_count: number | null;
  latitude: number | null;
  longitude: number | null;
}

const rows = db
  .prepare(
    `SELECT id, restaurant_name, google_place_id,
            google_rating, google_user_rating_count, latitude, longitude
     FROM xhs_restaurants
     WHERE google_place_id IS NOT NULL
       AND (google_rating IS NULL
         OR google_user_rating_count IS NULL
         OR latitude IS NULL
         OR longitude IS NULL)
     ORDER BY restaurant_name`,
  )
  .all() as Row[];

const eligible = rows.slice(0, LIMIT);
console.log(
  `[backfill] ${rows.length} rows missing rating/location; processing ${eligible.length}` +
    (DRY_RUN ? ' (DRY_RUN=1, no DB writes)' : ''),
);

const update = db.prepare(`
  UPDATE xhs_restaurants
  SET google_rating = COALESCE(?, google_rating),
      google_user_rating_count = COALESCE(?, google_user_rating_count),
      latitude  = COALESCE(?, latitude),
      longitude = COALESCE(?, longitude)
  WHERE id = ?
`);

interface PlaceDetails {
  rating: number | null;
  count: number | null;
  latitude: number | null;
  longitude: number | null;
}

async function fetchPlaceDetails(placeId: string): Promise<PlaceDetails> {
  try {
    const res = await axios.get(`${PLACES_DETAIL_BASE}${encodeURIComponent(placeId)}`, {
      headers: {
        'X-Goog-Api-Key': apiKey!,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      timeout: 15_000,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const d = res.data ?? {};
    const loc = d.location ?? {};
    return {
      rating: typeof d.rating === 'number' ? d.rating : null,
      count: typeof d.userRatingCount === 'number' ? d.userRatingCount : null,
      latitude: typeof loc.latitude === 'number' ? loc.latitude : null,
      longitude: typeof loc.longitude === 'number' ? loc.longitude : null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  ! Place Details error for ${placeId}: ${msg.slice(0, 140)}`);
    return { rating: null, count: null, latitude: null, longitude: null };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  let updated = 0;
  let noSignal = 0;

  for (let i = 0; i < eligible.length; i++) {
    const r = eligible[i];
    const d = await fetchPlaceDetails(r.google_place_id);

    const anySignal =
      d.rating !== null || d.count !== null || d.latitude !== null || d.longitude !== null;
    if (!anySignal) {
      noSignal++;
      console.log(`[${i + 1}/${eligible.length}] ✗ ${r.restaurant_name} (no signals)`);
    } else {
      if (!DRY_RUN) {
        update.run(d.rating, d.count, d.latitude, d.longitude, r.id);
      }
      updated++;
      const parts: string[] = [];
      if (d.rating !== null) parts.push(`★${d.rating} (${d.count ?? '?'})`);
      if (d.latitude !== null && d.longitude !== null) {
        parts.push(`📍${d.latitude.toFixed(4)},${d.longitude.toFixed(4)}`);
      }
      console.log(`[${i + 1}/${eligible.length}] ✓ ${r.restaurant_name} — ${parts.join(' · ')}`);
    }

    if (i < eligible.length - 1) await sleep(RATE_LIMIT_MS);
  }

  console.log(`\nDone: ${updated} updated, ${noSignal} no-signal`);
  db.close();
})();
