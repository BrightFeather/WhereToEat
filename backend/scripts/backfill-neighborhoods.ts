/**
 * Backfill missing `neighborhood` for existing restaurants via Google Places API.
 *   npx ts-node scripts/backfill-neighborhoods.ts
 *
 * Preference: addressComponents[type=neighborhood]
 *   → addressComponents[type=sublocality_level_1]
 *   → addressComponents[type=sublocality]
 */
import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import Database from 'better-sqlite3';
import axios from 'axios';
import { extractNeighborhood } from '../api/_lib/placesEnricher';

const db = new Database(path.resolve(__dirname, '../data/wheretoeat.db'));
const apiKey = process.env.GOOGLE_PLACES_API_KEY;
if (!apiKey) {
  console.error('GOOGLE_PLACES_API_KEY is not set');
  process.exit(1);
}

interface Row {
  id: string;
  restaurant_name: string;
  google_place_id: string | null;
  address: string | null;
  borough: string | null;
}

async function placeById(placeId: string): Promise<unknown> {
  const res = await axios.get(
    `https://places.googleapis.com/v1/places/${placeId}`,
    {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'addressComponents',
      },
    }
  );
  return res.data;
}

async function placeBySearch(name: string, locHint: string | null): Promise<unknown | null> {
  const textQuery = locHint ? `${name} ${locHint} New York` : `${name} New York City`;
  const res = await axios.post(
    'https://places.googleapis.com/v1/places:searchText',
    { textQuery, languageCode: 'en' },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.addressComponents,places.id',
      },
    }
  );
  const places = res.data?.places;
  return places?.[0] ?? null;
}

async function main() {
  const rows = db.prepare(
    `SELECT id, restaurant_name, google_place_id, address, borough
     FROM xhs_restaurants
     WHERE neighborhood IS NULL OR neighborhood = ''`
  ).all() as Row[];

  console.log(`Restaurants missing neighborhood: ${rows.length}`);

  const update = db.prepare('UPDATE xhs_restaurants SET neighborhood = ? WHERE id = ?');

  let filled = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let neighborhood: string | null = null;

    try {
      type PlaceLike = { addressComponents?: Array<{ longText: string; shortText: string; types: string[] }> };
      let place: PlaceLike | null = null;

      if (r.google_place_id) {
        place = (await placeById(r.google_place_id)) as PlaceLike;
      } else {
        place = (await placeBySearch(r.restaurant_name, r.borough)) as PlaceLike | null;
      }

      neighborhood = extractNeighborhood(place?.addressComponents);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ! ${r.restaurant_name}: ${msg.substring(0, 80)}`);
    }

    if (neighborhood) {
      update.run(neighborhood, r.id);
      filled++;
      console.log(`  [${i + 1}/${rows.length}] ${r.restaurant_name} → ${neighborhood}`);
    } else {
      skipped++;
      console.log(`  [${i + 1}/${rows.length}] ${r.restaurant_name} → (none)`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(`\nDone. Filled: ${filled}, skipped: ${skipped}`);
  db.close();
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
