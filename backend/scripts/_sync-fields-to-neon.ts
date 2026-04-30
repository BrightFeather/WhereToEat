/**
 * One-shot: push the new columns we added to existing Neon rows.
 * `push-data` uses ON CONFLICT DO NOTHING so it can't update rows that
 * already exist on the cloud. This script does explicit per-id UPDATEs for
 * google_rating / google_user_rating_count / instagram_url / features on
 * xhs_restaurants, and refreshes xhs_sources from SQLite.
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
process.env.VERCEL = '1';

import Database from 'better-sqlite3';

async function main() {
  const { sql } = await import('../api/_lib/db');
  const db = new Database(path.join(process.cwd(), 'data/wheretoeat.db'));

  // SQLite may be behind Neon on schema (no lat/lng columns yet); detect.
  const cols = db.prepare(`PRAGMA table_info(xhs_restaurants)`).all() as Array<{ name: string }>;
  const hasLatLng = new Set(cols.map((c) => c.name)).has('latitude');
  const latLngSelect = hasLatLng ? ', latitude, longitude' : '';

  const rows = db.prepare(`
    SELECT id, google_rating, google_user_rating_count, instagram_url, features,
           website_url${latLngSelect}
    FROM xhs_restaurants
    WHERE google_rating IS NOT NULL
       OR instagram_url IS NOT NULL
       OR features IS NOT NULL
       ${hasLatLng ? 'OR latitude IS NOT NULL OR longitude IS NOT NULL' : ''}
  `).all() as Array<{
    id: string;
    google_rating: number | null;
    google_user_rating_count: number | null;
    instagram_url: string | null;
    features: string | null;
    website_url: string | null;
    latitude?: number | null;
    longitude?: number | null;
  }>;

  console.log(`[xhs_restaurants] updating ${rows.length} rows on Neon`);
  let updated = 0;
  for (const r of rows) {
    const lat = r.latitude ?? null;
    const lng = r.longitude ?? null;
    const result = (await sql`
      UPDATE xhs_restaurants
      SET google_rating = COALESCE(${r.google_rating}, google_rating),
          google_user_rating_count = COALESCE(${r.google_user_rating_count}, google_user_rating_count),
          instagram_url = COALESCE(${r.instagram_url}, instagram_url),
          features      = COALESCE(${r.features}, features),
          website_url   = COALESCE(${r.website_url}, website_url),
          latitude      = COALESCE(${lat}, latitude),
          longitude     = COALESCE(${lng}, longitude)
      WHERE id = ${r.id}
      RETURNING id
    `) as Array<{ id: string }>;
    if (result.length > 0) updated++;
  }
  console.log(`[xhs_restaurants] updated ${updated} / ${rows.length}`);

  // Re-push xhs_sources rows that exist locally — Neon is behind on the
  // backfilled rows (and on source_type which only got added today).
  const sources = db.prepare(`
    SELECT id, restaurant_id, post_url, recommendation, likes, post_created_at, source_type
    FROM xhs_sources
  `).all() as Array<{
    id: string;
    restaurant_id: string;
    post_url: string;
    recommendation: string | null;
    likes: number;
    post_created_at: string | null;
    source_type: string | null;
  }>;

  console.log(`[xhs_sources] upserting ${sources.length} rows`);
  let sourceUpserts = 0;
  for (const s of sources) {
    const result = (await sql`
      INSERT INTO xhs_sources (id, restaurant_id, post_url, recommendation, likes, post_created_at, source_type)
      VALUES (
        ${s.id}, ${s.restaurant_id}, ${s.post_url}, ${s.recommendation},
        ${s.likes}, ${s.post_created_at}, ${s.source_type ?? 'xiaohongshu'}
      )
      ON CONFLICT (restaurant_id, post_url) DO UPDATE SET
        recommendation  = COALESCE(EXCLUDED.recommendation, xhs_sources.recommendation),
        likes           = CASE WHEN EXCLUDED.likes > xhs_sources.likes THEN EXCLUDED.likes ELSE xhs_sources.likes END,
        post_created_at = COALESCE(EXCLUDED.post_created_at, xhs_sources.post_created_at),
        source_type     = COALESCE(EXCLUDED.source_type, xhs_sources.source_type)
      RETURNING id
    `) as Array<{ id: string }>;
    if (result.length > 0) sourceUpserts++;
  }
  console.log(`[xhs_sources] upserted ${sourceUpserts} / ${sources.length}`);

  // Verify CHADA
  const chada = (await sql`
    SELECT r.restaurant_name, r.google_rating, r.instagram_url,
           (SELECT COUNT(DISTINCT post_url) FROM xhs_sources s WHERE s.restaurant_id = r.id) AS src_count
    FROM xhs_restaurants r
    WHERE r.restaurant_name = 'CHADA NYC'
  `) as any[];
  console.log('CHADA on Neon:', JSON.stringify(chada, null, 2));

  db.close();
}
main().catch(e => { console.error(e); process.exit(1); });
