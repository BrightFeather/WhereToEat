/**
 * Migrate every restaurant photo URL pointing at Google Places
 * (https://places.googleapis.com/...) to Vercel Blob.
 *
 *   npm run migrate-places-photos
 *
 * For each row in `xhs_restaurants`:
 *   1. Walks `photo_url` (single) and `photo_urls` (JSON array)
 *   2. For every Places URL, fetches the bytes (the URL embeds the API key)
 *   3. Uploads to Blob at a deterministic key derived from google_place_id
 *   4. Rewrites the row to point at the Blob URL
 *
 * Idempotent. Skips URLs that are already on Blob. Safe to re-run.
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { neon } from '@neondatabase/serverless';
import { put } from '@vercel/blob';

const dbUrl =
  process.env.DATABASE_URL ||
  process.env.WHERE_TO_EAT_DATABASE_URL ||
  process.env.WHERE_TO_EAT_POSTGRES_URL;
if (!dbUrl) throw new Error('No Neon connection string in env');

const blobToken =
  process.env.RESTAURANT_PHOTOS_READ_WRITE_TOKEN ||
  process.env.BLOB_READ_WRITE_TOKEN;
if (!blobToken) throw new Error('No Blob token in env');

const sql = neon(dbUrl);

const PLACES_PREFIX = 'https://places.googleapis.com/';
const BLOB_HOST_FRAGMENT = 'blob.vercel-storage.com';
const FETCH_DELAY_MS = 100;

function isPlacesUrl(u: string | null | undefined): u is string {
  return !!u && u.startsWith(PLACES_PREFIX);
}

function isBlobUrl(u: string | null | undefined): u is string {
  return !!u && u.includes(BLOB_HOST_FRAGMENT);
}

async function migrateOne(url: string, blobKey: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  ✗ fetch ${res.status} for ${blobKey}`);
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const blob = await put(`photos/${blobKey}.jpg`, buffer, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      token: blobToken,
    });
    return blob.url;
  } catch (e) {
    console.warn(`  ✗ failed ${blobKey}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

async function main() {
  const rows = (await sql`
    SELECT id, google_place_id, photo_url, photo_urls
    FROM xhs_restaurants
    WHERE photo_url LIKE ${PLACES_PREFIX + '%'}
       OR photo_urls LIKE ${'%' + PLACES_PREFIX + '%'}
  `) as Array<{
    id: string;
    google_place_id: string | null;
    photo_url: string | null;
    photo_urls: string | null;
  }>;

  console.log(`Found ${rows.length} rows with Places URLs`);

  let totalUploaded = 0;
  let totalSkipped = 0;
  let rowsUpdated = 0;
  let rowIdx = 0;

  for (const row of rows) {
    rowIdx++;
    // Use google_place_id as the filename root; fall back to row id if missing
    const baseKey = row.google_place_id ?? row.id;

    let newPhotoUrl = row.photo_url;
    let newPhotosArr: string[] | null = null;
    let dirty = false;

    // Build the array we'll iterate, preserving original order
    let originalArr: string[] = [];
    if (row.photo_urls) {
      try {
        originalArr = JSON.parse(row.photo_urls) as string[];
      } catch {
        originalArr = [];
      }
    } else if (row.photo_url) {
      originalArr = [row.photo_url];
    }

    const rewrittenArr: string[] = [];
    for (let i = 0; i < originalArr.length; i++) {
      const url = originalArr[i];
      if (isBlobUrl(url)) {
        rewrittenArr.push(url); // already migrated
        continue;
      }
      if (!isPlacesUrl(url)) {
        rewrittenArr.push(url); // some other source — leave as-is
        continue;
      }
      const blobUrl = await migrateOne(url, `${baseKey}_${i}`);
      if (blobUrl) {
        rewrittenArr.push(blobUrl);
        totalUploaded++;
        dirty = true;
      } else {
        rewrittenArr.push(url); // keep original on failure
        totalSkipped++;
      }
      await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
    }

    // Single photo_url: rewrite if it's the same as the first slot we just migrated
    if (isPlacesUrl(row.photo_url)) {
      // Find a Blob URL for the same base key in the rewritten array
      const matchingBlob = rewrittenArr.find((u) => isBlobUrl(u));
      if (matchingBlob) {
        newPhotoUrl = matchingBlob;
        dirty = true;
      } else {
        // photo_url wasn't part of photo_urls — migrate it standalone
        const blobUrl = await migrateOne(row.photo_url, `${baseKey}_single`);
        if (blobUrl) {
          newPhotoUrl = blobUrl;
          totalUploaded++;
          dirty = true;
        }
      }
    } else {
      newPhotoUrl = row.photo_url;
    }

    newPhotosArr = rewrittenArr.length > 0 ? rewrittenArr : null;

    if (!dirty) continue;

    const newPhotosJson = newPhotosArr ? JSON.stringify(newPhotosArr) : null;
    await sql`
      UPDATE xhs_restaurants
      SET photo_url = ${newPhotoUrl},
          photo_urls = ${newPhotosJson}
      WHERE id = ${row.id}
    `;
    rowsUpdated++;
    process.stdout.write(`\r  row ${rowIdx}/${rows.length}  uploaded=${totalUploaded}  failed=${totalSkipped}  rows_updated=${rowsUpdated}`);
  }

  process.stdout.write('\n\n');
  console.log(`Uploaded: ${totalUploaded}`);
  console.log(`Failed:   ${totalSkipped}`);
  console.log(`Rows updated: ${rowsUpdated}`);
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
