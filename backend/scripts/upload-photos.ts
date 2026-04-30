/**
 * Upload local restaurant photos to Vercel Blob, then rewrite the Neon
 * `photo_url` / `photo_urls` columns from `http://localhost:3000/photos/{file}`
 * to the new public Blob URLs.
 *
 *   npm run push-photos
 *
 * Idempotent: re-uploads with allowOverwrite so URLs stay stable across runs.
 * Reads BLOB_READ_WRITE_TOKEN and DATABASE_URL from .env.local.
 */
import path from 'path';
import fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { neon } from '@neondatabase/serverless';
import { put } from '@vercel/blob';

const dbUrl =
  process.env.DATABASE_URL ||
  process.env.WHERE_TO_EAT_DATABASE_URL ||
  process.env.WHERE_TO_EAT_POSTGRES_URL;
if (!dbUrl) throw new Error('No Neon connection string in env');
// Prefer the named public store; the default BLOB_READ_WRITE_TOKEN is the
// leftover private store from the first attempt and will reject public uploads.
const blobToken =
  process.env.RESTAURANT_PHOTOS_READ_WRITE_TOKEN ||
  process.env.BLOB_READ_WRITE_TOKEN;
if (!blobToken) {
  throw new Error('No Blob token in env — tried BLOB_READ_WRITE_TOKEN, RESTAURANT_PHOTOS_READ_WRITE_TOKEN');
}
const sql = neon(dbUrl);

const PHOTOS_DIR = path.resolve(__dirname, '../data/photos');
const LOCAL_PREFIX = 'http://localhost:3000/photos/';

async function uploadAll(): Promise<Map<string, string>> {
  const files = fs.readdirSync(PHOTOS_DIR).filter((f) => f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png'));
  console.log(`Found ${files.length} photos in ${PHOTOS_DIR}`);

  const map = new Map<string, string>(); // filename → public blob URL
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const buffer = fs.readFileSync(path.join(PHOTOS_DIR, file));
    const blob = await put(`photos/${file}`, buffer, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      token: blobToken,
    });
    map.set(file, blob.url);
    process.stdout.write(`\r  uploaded ${i + 1}/${files.length}`);
  }
  process.stdout.write('\n');
  return map;
}

function rewriteUrl(localUrl: string | null, map: Map<string, string>): string | null {
  if (!localUrl) return localUrl;
  if (!localUrl.startsWith(LOCAL_PREFIX)) return localUrl; // already migrated or external
  const filename = localUrl.slice(LOCAL_PREFIX.length);
  return map.get(filename) ?? localUrl; // leave as-is if no matching upload
}

async function rewriteDbColumns(map: Map<string, string>): Promise<void> {
  const rows = (await sql`
    SELECT id, photo_url, photo_urls FROM xhs_restaurants
  `) as Array<{ id: string; photo_url: string | null; photo_urls: string | null }>;

  console.log(`\nRewriting URLs for ${rows.length} restaurants…`);
  let updated = 0;
  let unchanged = 0;
  let missing = 0;

  for (const row of rows) {
    const newPhoto = rewriteUrl(row.photo_url, map);

    let newPhotosJson: string | null = row.photo_urls;
    if (row.photo_urls) {
      try {
        const arr = JSON.parse(row.photo_urls) as string[];
        const rewritten = arr.map((u) => rewriteUrl(u, map) ?? u);
        newPhotosJson = JSON.stringify(rewritten);
      } catch {
        // leave malformed JSON alone
      }
    }

    if (newPhoto === row.photo_url && newPhotosJson === row.photo_urls) {
      unchanged++;
      continue;
    }

    // Track if we couldn't find a matching upload for any localhost URL
    if (row.photo_url?.startsWith(LOCAL_PREFIX) && newPhoto === row.photo_url) {
      missing++;
    }

    await sql`
      UPDATE xhs_restaurants
      SET photo_url = ${newPhoto}, photo_urls = ${newPhotosJson}
      WHERE id = ${row.id}
    `;
    updated++;
  }

  console.log(`  updated: ${updated}`);
  console.log(`  unchanged: ${unchanged}`);
  if (missing > 0) console.log(`  rows with localhost URL but no matching local file: ${missing}`);
}

async function main() {
  const map = await uploadAll();
  await rewriteDbColumns(map);
  console.log('\nDone.');
}

main().catch((e) => {
  console.error('Upload failed:', e);
  process.exit(1);
});
