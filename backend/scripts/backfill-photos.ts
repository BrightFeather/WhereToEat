/**
 * Backfill photos for restaurants in the DB that are missing photos.
 * Fetches up to 5 photos per restaurant from Google Places API,
 * downloads them locally, and updates the DB.
 *
 * Usage: npx ts-node scripts/backfill-photos.ts
 */
import path from 'path';
import fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import axios from 'axios';
import { sql } from '../api/_lib/db';

const PHOTOS_DIR = path.resolve(__dirname, '../data/photos');
const PLACES_API_BASE = 'https://places.googleapis.com/v1';
const MAX_PHOTOS = 5;
const DELAY_MS = 300;

async function downloadPhoto(remoteUrl: string, filename: string): Promise<string | null> {
  try {
    if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
    const dest = path.join(PHOTOS_DIR, filename);
    if (fs.existsSync(dest)) {
      console.log(`  ↩ already exists: ${filename}`);
      return dest;
    }
    const response = await axios.get(remoteUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(dest, Buffer.from(response.data));
    return dest;
  } catch (e) {
    console.warn(`  ✗ download failed: ${filename} — ${(e as Error).message}`);
    return null;
  }
}

async function fetchPhotoUrls(placeId: string): Promise<string[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY not set');

  // Get place details including photos
  const url = `${PLACES_API_BASE}/places/${placeId}`;
  const response = await axios.get(url, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'photos',
    },
  });

  const photos: Array<{ name: string }> = response.data?.photos ?? [];
  return photos
    .slice(0, MAX_PHOTOS)
    .map((p) => `${PLACES_API_BASE}/${p.name}/media?maxWidthPx=800&key=${apiKey}`);
}

async function backfillPhotosForRestaurant(row: Record<string, unknown>): Promise<void> {
  const id = row.id as string;
  const name = (row.google_display_name ?? row.restaurant_name) as string;
  const placeId = row.google_place_id as string;

  console.log(`\n→ ${name} (placeId: ${placeId})`);

  let remoteUrls: string[];
  try {
    remoteUrls = await fetchPhotoUrls(placeId);
    console.log(`  Found ${remoteUrls.length} photos from Google Places`);
  } catch (e) {
    console.warn(`  ✗ Places API failed: ${(e as Error).message}`);
    return;
  }

  if (remoteUrls.length === 0) {
    console.log(`  ✗ No photos available`);
    return;
  }

  const localUrls: string[] = [];
  for (let i = 0; i < remoteUrls.length; i++) {
    const filename = `${placeId}_${i}.jpg`;
    const localPath = await downloadPhoto(remoteUrls[i], filename);
    if (localPath) {
      localUrls.push(`http://localhost:3000/photos/${filename}`);
      console.log(`  ✓ saved: ${filename}`);
    }
  }

  if (localUrls.length === 0) {
    console.log(`  ✗ No photos downloaded`);
    return;
  }

  // Update the DB row
  await sql`
    UPDATE xhs_restaurants
    SET photo_url = ${localUrls[0]},
        photo_urls = ${JSON.stringify(localUrls)}
    WHERE id = ${id}
  `;
  console.log(`  ✓ DB updated: ${localUrls.length} photos`);
}

async function main() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error('GOOGLE_PLACES_API_KEY not set in .env.local');
    process.exit(1);
  }

  // Find restaurants that are missing photos and have a google_place_id
  const rows = await sql`
    SELECT id, restaurant_name, google_display_name, google_place_id
    FROM xhs_restaurants
    WHERE google_place_id IS NOT NULL
      AND (photo_url IS NULL OR photo_url = '')
      AND is_available_this_week = 1
      AND google_maps_url IS NOT NULL
    ORDER BY (mention_count * 10 + total_likes) DESC
  `;

  console.log(`Found ${rows.length} restaurants missing photos`);

  for (let i = 0; i < rows.length; i++) {
    await backfillPhotosForRestaurant(rows[i]);
    if (i < rows.length - 1) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  console.log('\nDone!');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
