/**
 * Backfill `google_rating`, `google_user_rating_count`, `instagram_url` for
 * every existing `xhs_restaurants` row that has a `google_place_id`. Single
 * Places (New) Place Details call per row + a lightweight website fetch for
 * the IG handle. Idempotent — safe to re-run.
 *
 *   npx ts-node scripts/backfill-rating-ig.ts
 *
 * Skips rows that already have all three fields filled in. Logs every row's
 * before/after on a single line. Sleeps 200 ms between rows to be polite.
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import Database from 'better-sqlite3';
import axios from 'axios';

const PLACES_DETAIL_BASE = 'https://places.googleapis.com/v1/places/';
const FIELD_MASK = 'rating,userRatingCount,websiteUri';
const INSTAGRAM_HANDLE_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{1,30})/i;
const RATE_LIMIT_MS = 200;

const apiKey = process.env.GOOGLE_PLACES_API_KEY;
if (!apiKey) {
  console.error('GOOGLE_PLACES_API_KEY missing in .env.local');
  process.exit(1);
}

const db = new Database(path.join(__dirname, '../data/wheretoeat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

interface Row {
  id: string;
  restaurant_name: string;
  google_place_id: string | null;
  google_rating: number | null;
  google_user_rating_count: number | null;
  instagram_url: string | null;
  website_url: string | null;
}

const rows = db
  .prepare(
    `SELECT id, restaurant_name, google_place_id,
            google_rating, google_user_rating_count, instagram_url,
            website_url
     FROM xhs_restaurants
     WHERE google_place_id IS NOT NULL`,
  )
  .all() as Row[];

console.log(`[backfill] ${rows.length} rows with google_place_id\n`);

const update = db.prepare(`
  UPDATE xhs_restaurants
  SET google_rating = COALESCE(?, google_rating),
      google_user_rating_count = COALESCE(?, google_user_rating_count),
      instagram_url = COALESCE(?, instagram_url),
      website_url   = COALESCE(?, website_url)
  WHERE id = ?
`);

async function fetchPlaceDetails(
  placeId: string,
): Promise<{ rating: number | null; count: number | null; websiteUri: string | null }> {
  try {
    const res = await axios.get(`${PLACES_DETAIL_BASE}${encodeURIComponent(placeId)}`, {
      headers: {
        'X-Goog-Api-Key': apiKey!,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const data = res.data ?? {};
    return {
      rating: typeof data.rating === 'number' ? data.rating : null,
      count: typeof data.userRatingCount === 'number' ? data.userRatingCount : null,
      websiteUri: typeof data.websiteUri === 'string' ? data.websiteUri : null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { rating: null, count: null, websiteUri: null };
  }
}

async function fetchInstagramFromSite(websiteUrl: string): Promise<string | null> {
  try {
    const res = await axios.get(websiteUrl, {
      timeout: 8000,
      maxContentLength: 1_500_000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = typeof res.data === 'string' ? res.data : '';
    if (!html) return null;
    const m = html.match(INSTAGRAM_HANDLE_RE);
    if (!m) return null;
    const handle = m[1];
    if (['p', 'reel', 'explore', 'accounts', 'tv', 'stories'].includes(handle.toLowerCase())) {
      return null;
    }
    return `https://www.instagram.com/${handle}`;
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const fullyPopulated =
      r.google_rating !== null &&
      r.google_user_rating_count !== null &&
      (r.instagram_url !== null || r.website_url === null);
    if (fullyPopulated) {
      skipped++;
      continue;
    }

    const { rating, count, websiteUri } = await fetchPlaceDetails(r.google_place_id!);
    let igUrl: string | null = null;
    const siteToScrape = websiteUri ?? r.website_url;
    if (siteToScrape && r.instagram_url === null) {
      igUrl = await fetchInstagramFromSite(siteToScrape);
    }

    if (rating === null && count === null && igUrl === null && !websiteUri) {
      errors++;
      console.log(`[${i + 1}/${rows.length}] ✗ ${r.restaurant_name} (no signals)`);
    } else {
      update.run(rating, count, igUrl, websiteUri, r.id);
      updated++;
      const parts: string[] = [];
      if (rating !== null) parts.push(`★${rating} (${count ?? '?'})`);
      if (igUrl) parts.push('IG');
      if (websiteUri && r.website_url === null) parts.push('site');
      console.log(`[${i + 1}/${rows.length}] ✓ ${r.restaurant_name} — ${parts.join(' · ') || 'noop'}`);
    }

    if (i < rows.length - 1) await sleep(RATE_LIMIT_MS);
  }

  console.log(`\nDone: ${updated} updated, ${skipped} already complete, ${errors} no-signal`);
  db.close();
})();
