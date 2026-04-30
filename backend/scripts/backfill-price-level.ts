/**
 * Backfill `xhs_restaurants.price_level` for every row that has a
 * `google_place_id`. Hits Google Places **Details** by id (cheaper than
 * `searchText`) and writes to both local SQLite AND Neon in the same pass.
 *
 * Run:
 *   npx ts-node scripts/backfill-price-level.ts                # all eligible rows
 *   npx ts-node scripts/backfill-price-level.ts --dry-run      # log only, no DB writes
 *   npx ts-node scripts/backfill-price-level.ts --limit 50     # cap iterations
 *   npx ts-node scripts/backfill-price-level.ts --refresh      # also refresh non-null rows
 *
 * Env: GOOGLE_PLACES_API_KEY (required), DATABASE_URL (Neon).
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import axios from 'axios';
import Database from 'better-sqlite3';
import { neon } from '@neondatabase/serverless';

const DRY_RUN = process.argv.includes('--dry-run');
const REFRESH = process.argv.includes('--refresh');
const LIMIT_FLAG = process.argv.indexOf('--limit');
const LIMIT = LIMIT_FLAG > 0 ? parseInt(process.argv[LIMIT_FLAG + 1] ?? '0', 10) : 0;
const PLACES_DELAY_MS = parseInt(process.env.PLACES_DELAY_MS ?? '150', 10);

const PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.WHERE_TO_EAT_DATABASE_URL ||
  process.env.WHERE_TO_EAT_POSTGRES_URL ||
  process.env.POSTGRES_URL;

if (!PLACES_API_KEY) {
  console.error('GOOGLE_PLACES_API_KEY not set');
  process.exit(1);
}
if (!DATABASE_URL && !DRY_RUN) {
  console.error('DATABASE_URL not set (Neon) — pass --dry-run to skip the cloud write');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPriceLevel(placeId: string): Promise<string | null> {
  const url = `https://places.googleapis.com/v1/places/${placeId}`;
  const resp = await axios.get(url, {
    headers: {
      'X-Goog-Api-Key': PLACES_API_KEY!,
      // Pull both fields. Some listings (e.g. HYUN) only return priceRange
      // — we synthesise a tier from priceRange.startPrice in that case.
      'X-Goog-FieldMask': 'priceLevel,priceRange',
    },
    validateStatus: (s) => s >= 200 && s < 500,
  });
  if (resp.status !== 200) {
    console.warn(`  · ${placeId}: HTTP ${resp.status}`);
    return null;
  }
  const place = resp.data ?? {};
  const explicit = typeof place.priceLevel === 'string' ? place.priceLevel : null;
  if (explicit && explicit !== 'PRICE_LEVEL_UNSPECIFIED') return explicit;
  const rawUnits = place.priceRange?.startPrice?.units;
  const units = typeof rawUnits === 'string'
    ? parseInt(rawUnits, 10)
    : (typeof rawUnits === 'number' ? rawUnits : NaN);
  if (!Number.isFinite(units) || units <= 0) return null;
  if (units < 11) return 'PRICE_LEVEL_INEXPENSIVE';
  if (units < 26) return 'PRICE_LEVEL_MODERATE';
  if (units < 51) return 'PRICE_LEVEL_EXPENSIVE';
  return 'PRICE_LEVEL_VERY_EXPENSIVE';
}

async function main() {
  const db = new Database(path.join(process.cwd(), 'data/wheretoeat.db'));
  db.pragma('journal_mode = WAL');

  const where = REFRESH
    ? `google_place_id IS NOT NULL`
    : `google_place_id IS NOT NULL AND price_level IS NULL`;
  const sqlSelect = `
    SELECT id, restaurant_name, google_place_id, price_level
    FROM xhs_restaurants
    WHERE ${where}
    ORDER BY total_likes DESC
    ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
  `;
  const rows = db.prepare(sqlSelect).all() as Array<{
    id: string;
    restaurant_name: string;
    google_place_id: string;
    price_level: string | null;
  }>;

  console.log(`Found ${rows.length} rows to backfill (refresh=${REFRESH}, dry-run=${DRY_RUN}, limit=${LIMIT || '∞'})`);

  const neonSql = !DRY_RUN && DATABASE_URL ? neon(DATABASE_URL) : null;

  const localUpdate = db.prepare(
    `UPDATE xhs_restaurants SET price_level = ? WHERE id = ?`
  );

  let updated = 0;
  let unchanged = 0;
  let unsetByGoogle = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    process.stdout.write(`[${i + 1}/${rows.length}] ${r.restaurant_name.padEnd(40).slice(0, 40)} `);

    let level: string | null = null;
    try {
      level = await fetchPriceLevel(r.google_place_id);
    } catch (e) {
      errors++;
      console.log(`× error: ${(e as Error).message}`);
      await sleep(PLACES_DELAY_MS);
      continue;
    }

    if (!level) {
      unsetByGoogle++;
      console.log('— no priceLevel from Places');
    } else if (level === r.price_level) {
      unchanged++;
      console.log(`= ${level} (unchanged)`);
    } else {
      console.log(`✓ ${r.price_level ?? '<null>'} → ${level}`);
      if (!DRY_RUN) {
        localUpdate.run(level, r.id);
        if (neonSql) {
          await neonSql`
            UPDATE xhs_restaurants SET price_level = ${level} WHERE id = ${r.id}
          `;
        }
      }
      updated++;
    }

    await sleep(PLACES_DELAY_MS);
  }

  console.log('\n=== Summary ===');
  console.log(`Updated:           ${updated}`);
  console.log(`Unchanged:         ${unchanged}`);
  console.log(`No level (Google): ${unsetByGoogle}`);
  console.log(`Errors:            ${errors}`);
  console.log(DRY_RUN ? '(dry-run — no writes)' : `Wrote to: SQLite${neonSql ? ' + Neon' : ''}`);

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
