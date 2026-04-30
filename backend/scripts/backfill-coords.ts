#!/usr/bin/env npx tsx
/**
 * Backfill `latitude` / `longitude` on `xhs_restaurants` rows that have a
 * `google_place_id` but no coordinates. Calls the Places "Place Details"
 * endpoint per row (1.2s delay) and writes only the location fields. Idempotent.
 *
 *   npm run backfill-coords          # runs against Neon (reads .env.local)
 *
 * Notes:
 *   - Pulls only `id` + `google_place_id` to keep the SELECT cheap.
 *   - Skips rows whose Place Details response has no `location` (rare).
 *   - Logs a one-line per row summary so you can see progress.
 *   - Requires `GOOGLE_PLACES_API_KEY` in env.
 *   - Inlines `neon(url)` (rather than importing `sql` from `_lib/db`) so
 *     dotenv loads BEFORE the connection is opened — the previous import
 *     order let `db.ts` evaluate its env lookup before `dotenv.config` ran.
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import axios from 'axios';
import { neon } from '@neondatabase/serverless';

const url =
  process.env.DATABASE_URL ||
  process.env.WHERE_TO_EAT_DATABASE_URL ||
  process.env.WHERE_TO_EAT_POSTGRES_URL ||
  process.env.POSTGRES_URL;
if (!url) throw new Error('No Neon connection string in env — run `vercel env pull` first');
const sql = neon(url);

const PLACES_DETAILS_BASE = 'https://places.googleapis.com/v1/places';
const FIELDS = 'location';
const DELAY_MS = 1200;

interface Row {
  id: string;
  google_place_id: string;
}

async function fetchLocation(
  placeId: string,
  apiKey: string
): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const res = await axios.get(`${PLACES_DETAILS_BASE}/${placeId}`, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELDS,
      },
      timeout: 10_000,
    });
    const loc = res.data?.location;
    if (typeof loc?.latitude === 'number' && typeof loc?.longitude === 'number') {
      return { latitude: loc.latitude, longitude: loc.longitude };
    }
    return null;
  } catch (err) {
    console.error(`  ✗ Places error for ${placeId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function main() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error('GOOGLE_PLACES_API_KEY not set');
    process.exit(1);
  }

  const rows = (await sql`
    SELECT id, google_place_id
    FROM xhs_restaurants
    WHERE google_place_id IS NOT NULL
      AND (latitude IS NULL OR longitude IS NULL)
  `) as unknown as Row[];

  console.log(`[backfill-coords] ${rows.length} rows need lat/lng`);

  let written = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const loc = await fetchLocation(r.google_place_id, apiKey);
    if (!loc) {
      console.log(`  ${i + 1}/${rows.length}  · skipped ${r.id} (no location)`);
    } else {
      await sql`
        UPDATE xhs_restaurants
        SET latitude  = ${loc.latitude},
            longitude = ${loc.longitude}
        WHERE id = ${r.id}
      `;
      written++;
      console.log(`  ${i + 1}/${rows.length}  ✓ ${r.id}  (${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)})`);
    }
    if (i < rows.length - 1) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }
  console.log(`[backfill-coords] wrote coords for ${written} / ${rows.length} rows`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
