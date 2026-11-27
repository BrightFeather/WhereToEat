/**
 * Mirror every Google Places photo URL on `xhs_restaurants` into Vercel Blob.
 *
 *   npm run mirror-photos                      # Neon (prod)
 *   TARGET=sqlite npm run mirror-photos        # local SQLite
 *   DRY_RUN=1 CITY=nyc LIMIT=20 npm run mirror-photos
 *
 * Why: a raw `places.googleapis.com/.../media?key=…` URL costs a billed
 * Places call plus a 302 on every load, exposes the API key in the public
 * `/weekly` response, and stops working once Google expires the photo name
 * (400 → a permanently gray card in the app).
 *
 * Per row: each Places URL is downloaded and uploaded to
 * `photos/<place_id>_<i>.jpg`. If any of them has expired, the row's photo
 * names are re-read from Place Details and the whole list is rebuilt from
 * those. Photos that still can't be fetched are dropped, so the app shows
 * its no-photo placeholder instead of a gray card.
 *
 * Idempotent: Blob URLs are skipped, so re-running only touches rows that
 * still have Places URLs. `sync-runs-to-neon.ts` keeps prod's existing
 * photo_url, so run this against Neon after every sync.
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { put } from '@vercel/blob';

const TARGET = (process.env.TARGET ?? 'neon') as 'neon' | 'sqlite';
const DRY_RUN = process.env.DRY_RUN === '1';
const CITY = process.env.CITY ?? null;
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 3);
const MAX_PHOTOS = 5;

const PLACES_PREFIX = 'https://places.googleapis.com/';
const placesKey = process.env.GOOGLE_PLACES_API_KEY;
const blobToken =
  process.env.RESTAURANT_PHOTOS_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
if (!placesKey) throw new Error('GOOGLE_PLACES_API_KEY missing from env');
if (!blobToken) throw new Error('No Blob token in env (RESTAURANT_PHOTOS_READ_WRITE_TOKEN / BLOB_READ_WRITE_TOKEN)');

interface Row {
  id: string;
  city: string;
  google_place_id: string | null;
  photo_url: string | null;
  photo_urls: string | null;
}

interface Db {
  load(): Promise<Row[]>;
  save(id: string, photoUrl: string | null, photoUrls: string | null): Promise<void>;
}

function neonDb(): Db {
  const { neon } = require('@neondatabase/serverless') as typeof import('@neondatabase/serverless');
  const url =
    process.env.DATABASE_URL || process.env.WHERE_TO_EAT_DATABASE_URL || process.env.WHERE_TO_EAT_POSTGRES_URL;
  if (!url) throw new Error('No Neon connection string in env');
  const sql = neon(url);
  return {
    load: async () =>
      (await sql`
        SELECT id, city, google_place_id, photo_url, photo_urls FROM xhs_restaurants
        WHERE (photo_url LIKE ${PLACES_PREFIX + '%'} OR photo_urls LIKE ${'%' + PLACES_PREFIX + '%'})
        ORDER BY is_available_this_week DESC, total_likes DESC
      `) as Row[],
    save: async (id, photoUrl, photoUrls) => {
      await sql`UPDATE xhs_restaurants SET photo_url = ${photoUrl}, photo_urls = ${photoUrls} WHERE id = ${id}`;
    },
  };
}

function sqliteDb(): Db {
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(path.resolve(__dirname, '../data/wheretoeat.db'));
  return {
    load: async () =>
      db.prepare(`
        SELECT id, city, google_place_id, photo_url, photo_urls FROM xhs_restaurants
        WHERE (photo_url LIKE ? OR photo_urls LIKE ?)
        ORDER BY is_available_this_week DESC, total_likes DESC
      `).all(PLACES_PREFIX + '%', '%' + PLACES_PREFIX + '%') as Row[],
    save: async (id, photoUrl, photoUrls) => {
      db.prepare('UPDATE xhs_restaurants SET photo_url = ?, photo_urls = ? WHERE id = ?').run(photoUrl, photoUrls, id);
    },
  };
}

const isPlaces = (u: string) => u.startsWith(PLACES_PREFIX);

/** Retries 429 / 5xx with backoff. The first full run treated Places rate
 *  limiting as "photo expired" and wiped 286 rows' photos. */
async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if ((res.status !== 429 && res.status < 500) || attempt === 4) return res;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

/** null = the photo name is gone (400/404). Anything else non-OK throws, so
 *  the row is left untouched rather than losing photos. */
async function download(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const res = await fetchWithRetry(url);
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error(`photo HTTP ${res.status}`);
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'image/jpeg',
  };
}

async function upload(key: string, img: { bytes: Buffer; contentType: string }): Promise<string> {
  if (DRY_RUN) return `dry-run://photos/${key}.jpg`;
  const blob = await put(`photos/${key}.jpg`, img.bytes, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: img.contentType,
    token: blobToken,
  });
  return blob.url;
}

async function freshPhotoUrls(placeId: string): Promise<string[]> {
  const res = await fetchWithRetry(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { 'X-Goog-Api-Key': placesKey!, 'X-Goog-FieldMask': 'photos' },
  });
  if (!res.ok) throw new Error(`Place Details HTTP ${res.status}`);
  const body = (await res.json()) as { photos?: Array<{ name: string }> };
  return (body.photos ?? [])
    .slice(0, MAX_PHOTOS)
    .map((p) => `${PLACES_PREFIX}v1/${p.name}/media?maxWidthPx=800&key=${placesKey}`);
}

/** Uploads each Places URL; returns null if any of them has expired. */
async function mirrorList(urls: string[], baseKey: string): Promise<string[] | null> {
  const out: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    if (!isPlaces(urls[i])) { out.push(urls[i]); continue; }
    const img = await download(urls[i]);
    if (!img) return null;
    out.push(await upload(`${baseKey}_${i}`, img));
  }
  return out;
}

/** Best effort: keeps whatever downloads, drops the rest. */
async function mirrorSurvivors(urls: string[], baseKey: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    if (!isPlaces(urls[i])) { out.push(urls[i]); continue; }
    const img = await download(urls[i]);
    if (img) out.push(await upload(`${baseKey}_${i}`, img));
  }
  return out;
}

type Outcome = 'mirrored' | 'refreshed' | 'dropped_some' | 'no_photos' | 'error';

async function processRow(db: Db, row: Row): Promise<Outcome> {
  let urls: string[] = [];
  try { urls = row.photo_urls ? (JSON.parse(row.photo_urls) as string[]) : []; } catch { urls = []; }
  if (urls.length === 0 && row.photo_url) urls = [row.photo_url];
  const baseKey = row.google_place_id ?? row.id;

  let result = await mirrorList(urls, baseKey);
  let outcome: Outcome = 'mirrored';
  if (!result && row.google_place_id) {
    result = await mirrorList(await freshPhotoUrls(row.google_place_id), baseKey);
    outcome = 'refreshed';
  }
  if (!result) {
    result = await mirrorSurvivors(urls, baseKey);
    outcome = 'dropped_some';
  }
  if (result.length === 0) outcome = 'no_photos';

  await (DRY_RUN
    ? Promise.resolve()
    : db.save(row.id, result[0] ?? null, result.length > 0 ? JSON.stringify(result) : null));
  return outcome;
}

async function main() {
  const db = TARGET === 'sqlite' ? sqliteDb() : neonDb();
  const rows = (await db.load()).filter((r) => !CITY || r.city === CITY).slice(0, LIMIT);
  console.log(`[mirror-photos] target=${TARGET}${DRY_RUN ? ' (dry run)' : ''} rows=${rows.length}`);

  const counts: Record<Outcome, number> = { mirrored: 0, refreshed: 0, dropped_some: 0, no_photos: 0, error: 0 };
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < rows.length) {
      const row = rows[next++];
      try {
        counts[await processRow(db, row)]++;
      } catch (e) {
        counts.error++;
        console.warn(`\n  ✗ ${row.id}: ${e instanceof Error ? e.message : e}`);
      }
      done++;
      if (done % 10 === 0 || done === rows.length) {
        process.stdout.write(`\r  ${done}/${rows.length}  ${JSON.stringify(counts)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');
  console.log('[mirror-photos] done', counts);
}

main().catch((e) => {
  console.error('[mirror-photos] failed:', e);
  process.exit(1);
});
