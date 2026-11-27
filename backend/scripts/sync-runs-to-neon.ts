/**
 * Sync specific pipeline runs from local SQLite → Neon (prod).
 *
 *   SINCE=2026-11-26 DRY_RUN=1 npx ts-node -T scripts/sync-runs-to-neon.ts
 *   SINCE=2026-11-26 npx ts-node -T scripts/sync-runs-to-neon.ts
 *   RUN_IDS=<id>,<id> npx ts-node -T scripts/sync-runs-to-neon.ts
 *
 * Use this instead of `npm run push-data` after a pipeline run. push-data
 * also copies local users / reservations / favorites into prod, can't
 * update existing rows, and its INSERT omits features / rating / IG /
 * coords / price / source_type.
 *
 * Per run, in FK order:
 *   1. pipeline_runs row: upsert.
 *   2. xhs_restaurants with that pipeline_run_id. New rows are inserted with
 *      every column. Existing rows get the pipeline-owned fields from local
 *      (mention_count, total_likes, post_created_at, pipeline_run_id,
 *      updated_at, fresh Google rating). Everything else keeps Neon's value
 *      and is filled from local only when empty. Never touched on existing
 *      rows: is_available_this_week, resy / opentable fields, photo_url /
 *      photo_urls (prod-owned; run `npm run mirror-photos` after syncing new rows).
 *   3. xhs_sources for those restaurants: insert, skip existing.
 * Idempotent — safe to re-run.
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local'), quiet: true } as dotenv.DotenvConfigOptions);
import Database from 'better-sqlite3';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL || process.env.WHERE_TO_EAT_DATABASE_URL || process.env.WHERE_TO_EAT_POSTGRES_URL || process.env.POSTGRES_URL;
if (!url) throw new Error('No Neon connection string in env — run `vercel env pull` first');
const sql = neon(url);
const DRY = process.env.DRY_RUN === '1';
type Row = Record<string, any>;

const lite = new Database(path.resolve(__dirname, '../data/wheretoeat.db'), { readonly: true });

function pickRuns(): Row[] {
  if (process.env.RUN_IDS) {
    const ids = process.env.RUN_IDS.split(',').map((s) => s.trim());
    return lite.prepare(`SELECT * FROM pipeline_runs WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Row[];
  }
  if (!process.env.SINCE) throw new Error('Set SINCE=<date> or RUN_IDS=<ids>');
  return lite.prepare(`SELECT * FROM pipeline_runs WHERE started_at >= ? AND status = 'completed' ORDER BY started_at`).all(process.env.SINCE) as Row[];
}

async function main() {
  const runs = pickRuns();
  console.log(`${DRY ? '[DRY RUN] ' : ''}Syncing ${runs.length} run(s): ${runs.map((r) => `${r.city}:${r.id.slice(0, 8)} (${r.restaurant_count} restos)`).join(', ')}`);

  for (const run of runs) {
    const restos = lite.prepare(`SELECT * FROM xhs_restaurants WHERE pipeline_run_id = ?`).all(run.id) as Row[];
    const ids = restos.map((r) => r.id);
    const sources = ids.length
      ? lite.prepare(`SELECT * FROM xhs_sources WHERE restaurant_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Row[]
      : [];
    const existing = new Set((await sql`SELECT id FROM xhs_restaurants WHERE id = ANY(${ids})`).map((r: Row) => r.id));
    console.log(`\n[${run.city}] run ${run.id}: ${restos.length} restaurants (${restos.length - existing.size} new, ${existing.size} existing on Neon), ${sources.length} sources`);
    if (DRY) continue;

    await sql`
      INSERT INTO pipeline_runs (id, city, status, started_at, completed_at, post_count, restaurant_count, error_message)
      VALUES (${run.id}, ${run.city}, ${run.status}, ${run.started_at}::timestamptz, ${run.completed_at ?? null}::timestamptz,
              ${run.post_count ?? null}, ${run.restaurant_count ?? null}, ${run.error_message ?? null})
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, completed_at = EXCLUDED.completed_at,
        post_count = EXCLUDED.post_count, restaurant_count = EXCLUDED.restaurant_count`;

    let n = 0;
    for (const r of restos) {
      await sql`
        INSERT INTO xhs_restaurants (
          id, city, restaurant_name, address, borough, neighborhood, cuisine_type,
          recommendation, post_url, post_created_at, mention_count, total_likes,
          google_place_id, google_maps_url, google_display_name, website_url,
          photo_url, photo_urls, resy_venue_id, resy_booking_url, opentable_rid, opentable_booking_url,
          is_available_this_week, pipeline_run_id, created_at,
          features, google_rating, google_user_rating_count, instagram_url,
          latitude, longitude, price_level, updated_at
        ) VALUES (
          ${r.id}, ${r.city}, ${r.restaurant_name}, ${r.address}, ${r.borough}, ${r.neighborhood}, ${r.cuisine_type},
          ${r.recommendation}, ${r.post_url}, ${r.post_created_at}, ${r.mention_count}, ${r.total_likes},
          ${r.google_place_id}, ${r.google_maps_url}, ${r.google_display_name}, ${r.website_url},
          ${r.photo_url}, ${r.photo_urls}, ${r.resy_venue_id}, ${r.resy_booking_url}, ${r.opentable_rid}, ${r.opentable_booking_url},
          ${r.is_available_this_week ?? 1}, ${r.pipeline_run_id}, ${r.created_at}::timestamptz,
          ${r.features}, ${r.google_rating}, ${r.google_user_rating_count}, ${r.instagram_url},
          ${r.latitude}, ${r.longitude}, ${r.price_level}, ${r.updated_at ?? null}::timestamptz
        )
        ON CONFLICT (id) DO UPDATE SET
          mention_count   = EXCLUDED.mention_count,
          total_likes     = EXCLUDED.total_likes,
          post_created_at = EXCLUDED.post_created_at,
          pipeline_run_id = EXCLUDED.pipeline_run_id,
          updated_at      = EXCLUDED.updated_at,
          google_rating            = COALESCE(EXCLUDED.google_rating, xhs_restaurants.google_rating),
          google_user_rating_count = COALESCE(EXCLUDED.google_user_rating_count, xhs_restaurants.google_user_rating_count),
          borough      = COALESCE(xhs_restaurants.borough, EXCLUDED.borough),
          neighborhood = COALESCE(xhs_restaurants.neighborhood, EXCLUDED.neighborhood),
          cuisine_type = COALESCE(xhs_restaurants.cuisine_type, EXCLUDED.cuisine_type),
          features = CASE WHEN xhs_restaurants.features IS NULL OR xhs_restaurants.features = '[]'
                          THEN EXCLUDED.features ELSE xhs_restaurants.features END,
          instagram_url = COALESCE(xhs_restaurants.instagram_url, EXCLUDED.instagram_url),
          latitude      = COALESCE(xhs_restaurants.latitude, EXCLUDED.latitude),
          longitude     = COALESCE(xhs_restaurants.longitude, EXCLUDED.longitude),
          price_level   = COALESCE(xhs_restaurants.price_level, EXCLUDED.price_level),
          website_url   = COALESCE(xhs_restaurants.website_url, EXCLUDED.website_url)`;
      // photo_url / photo_urls deliberately absent: prod owns photos. mirror-photos
      // moves them to Blob and NULLs dead ones on purpose; filling them from local
      // would bring back expired Places URLs (with the API key) for those rows.
      if (++n % 50 === 0) console.log(`  restaurants ${n}/${restos.length}`);
    }

    let added = 0;
    for (const s of sources) {
      const res = await sql`
        INSERT INTO xhs_sources (id, restaurant_id, post_url, recommendation, likes, post_created_at, created_at, source_type, source_title, author)
        VALUES (${s.id}, ${s.restaurant_id}, ${s.post_url}, ${s.recommendation}, ${s.likes ?? 0}, ${s.post_created_at},
                ${s.created_at}::timestamptz, ${s.source_type ?? 'xiaohongshu'}, ${s.source_title ?? null}, ${s.author ?? null})
        ON CONFLICT DO NOTHING
        RETURNING id`;
      added += res.length;
    }
    console.log(`  done: ${restos.length} restaurants upserted, ${added} new sources (${sources.length - added} already present)`);
  }

  const counts = await sql`SELECT city, COUNT(*)::int n FROM xhs_restaurants GROUP BY city ORDER BY city`;
  const latest = await sql`SELECT DISTINCT ON (city) city, id, completed_at FROM pipeline_runs WHERE status = 'completed' ORDER BY city, completed_at DESC`;
  console.log('\nNeon now:', JSON.stringify(counts), '\nLatest completed run per city:', JSON.stringify(latest));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => lite.close());
