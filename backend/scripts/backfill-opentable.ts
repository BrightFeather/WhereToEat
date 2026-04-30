/**
 * Backfill OpenTable restaurant IDs and booking URLs for restaurants in the DB.
 *
 *   npx ts-node scripts/backfill-opentable.ts
 *
 * OpenTable's public HTTP endpoints are Akamai-blocked. This script drives
 * opentable.com's homepage autocomplete in a real headed Chromium and
 * captures the GraphQL response to extract rid + name for each DB restaurant.
 *
 * Env:
 *   OT_HEADLESS=1          attempt headless (usually fails Akamai — don't)
 *   OT_PROFILE_DIR=<path>  persistent Chrome profile location
 *   OT_LIMIT=<n>           cap how many restaurants to process (for testing)
 *   OT_CITY=<name>         city prefix for disambiguation (default "New York")
 */
import Database from 'better-sqlite3';
import path from 'path';
import * as dotenv from 'dotenv';
import { OpenTableSearcher, pickBestMatch, type OTMatch } from '../api/_lib/opentableSearch';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const db = new Database(path.join(__dirname, '../data/wheretoeat.db'));
db.pragma('journal_mode = WAL');

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function searchForName(
  searcher: OpenTableSearcher,
  name: string,
  city: string,
): Promise<OTMatch | null> {
  // First attempt: query with city prepended — OT autocomplete takes multi-token input.
  let candidates = await searcher.search(name, { city });
  let match = pickBestMatch(candidates, name, city);
  if (match) return match;

  // Retry with bare name in case the city prefix narrowed too much.
  candidates = await searcher.search(name);
  match = pickBestMatch(candidates, name, city);
  return match;
}

async function main() {
  const limit = process.env.OT_LIMIT ? parseInt(process.env.OT_LIMIT, 10) : undefined;
  const city = process.env.OT_CITY ?? 'New York';

  // Resy is the primary booking provider. Only fall back to OpenTable for
  // restaurants without a Resy URL.
  const rows = db.prepare(`
    SELECT id, restaurant_name, google_display_name, address
    FROM xhs_restaurants
    WHERE opentable_booking_url IS NULL
      AND resy_booking_url IS NULL
      AND is_available_this_week = 1
    ${limit ? `LIMIT ${limit}` : ''}
  `).all() as {
    id: string;
    restaurant_name: string;
    google_display_name: string | null;
    address: string | null;
  }[];

  console.log(`Checking ${rows.length} restaurants against OpenTable (city="${city}")...\n`);

  const update = db.prepare(`
    UPDATE xhs_restaurants
    SET opentable_rid = ?, opentable_booking_url = ?
    WHERE id = ?
  `);

  const searcher = new OpenTableSearcher();
  await searcher.open();
  console.log('Browser ready. Starting queries...\n');

  let matched = 0;
  let skipped = 0;
  let errors = 0;

  try {
    for (const r of rows) {
      const names = [r.google_display_name, r.restaurant_name]
        .filter((s): s is string => !!s)
        .filter((s, i, arr) => arr.findIndex((x) => normalize(x) === normalize(s)) === i);

      let found: OTMatch | null = null;
      for (const name of names) {
        try {
          found = await searchForName(searcher, name, city);
        } catch (e) {
          errors++;
          console.log(`! ${r.restaurant_name} — search error: ${(e as Error).message}`);
          break;
        }
        if (found) break;
      }

      if (found) {
        const bookable = await searcher.verifyBookable(found.rid);
        if (!bookable) {
          console.log(`⊘ ${r.restaurant_name} → ${found.name} (rid=${found.rid}) listed but not bookable`);
          skipped++;
          continue;
        }
        const bookingUrl = `https://www.opentable.com/restaurant/profile/${found.rid}`;
        update.run(found.rid, bookingUrl, r.id);
        const nbh = found.neighborhood ? ` (${found.neighborhood})` : '';
        console.log(`✓ ${r.restaurant_name} → ${found.name}${nbh} rid=${found.rid}`);
        matched++;
      } else {
        console.log(`· ${r.restaurant_name} — not on OpenTable`);
        skipped++;
      }
    }
  } finally {
    await searcher.close();
  }

  console.log(`\nDone: ${matched} matched, ${skipped} not found, ${errors} errors`);
  db.close();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
