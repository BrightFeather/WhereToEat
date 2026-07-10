/**
 * Direct end-to-end pipeline test (no HTTP server needed):
 *   npx ts-node scripts/test-pipeline.ts
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { sql } from '../api/_lib/db';

// Pipeline writes to local SQLite directly (the Neon-side `sql` is used only
// for `pipeline_runs` + restaurant insert path, which routes through `sql`
// when ON_VERCEL=true; locally both go to the same SQLite file).
const db = new Database(path.resolve(__dirname, '../data/wheretoeat.db'));
db.pragma('journal_mode = WAL');
import { searchXhsPosts } from '../api/_lib/xhsScraper';
import { extractBatch } from '../api/_lib/llmExtractor';
import { enrichWithPlaces } from '../api/_lib/placesEnricher';
import { deduplicateAndRank, type EnrichedRestaurant } from '../api/_lib/restaurantMerger';

const CITY = 'nyc';
const HASHTAGS = ['#纽约美食', '#NewYorkRestaurant', '#NYCEats'];
const MAX_PAGES = 10;
const PLACES_DELAY_MS = 200;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function main() {
  console.log('=== Pipeline Test ===\n');

  // Step 1: Scrape — past-month popular posts across multiple hashtags, deduped by noteId
  console.log(`Step 1: Scraping XHS posts for tags: ${HASHTAGS.join(', ')} (past 30 days)…`);
  const seen = new Set<string>();
  const rawPosts = [];
  for (const tag of HASHTAGS) {
    const posts = await searchXhsPosts(tag, MAX_PAGES, THIRTY_DAYS_MS);
    for (const p of posts) {
      if (seen.has(p.noteId)) continue;
      seen.add(p.noteId);
      rawPosts.push(p);
    }
    console.log(`  · ${tag}: +${posts.length} (total deduped: ${rawPosts.length})`);
  }
  console.log(`  → ${rawPosts.length} unique posts scraped\n`);

  // Step 2: LLM extraction
  console.log('Step 2: LLM extraction…');
  const extracted = await extractBatch(rawPosts);
  console.log(`  → ${extracted.length} restaurants extracted\n`);

  // Step 3b: Places enrichment
  console.log('Step 3b: Google Places enrichment…');
  const enriched: EnrichedRestaurant[] = [];
  for (let i = 0; i < extracted.length; i++) {
    const r = extracted[i];
    const places = await enrichWithPlaces(r);
    enriched.push({ ...r, places });
    console.log(`  [${i + 1}/${extracted.length}] ${r.restaurantName} → ${places ? places.googleMapsUrl : 'not found'}`);
    if (i < extracted.length - 1) {
      await new Promise((res) => setTimeout(res, PLACES_DELAY_MS));
    }
  }

  // Step 4: Dedup + rank
  console.log('\nStep 4: Dedup + rank…');
  const restaurants = deduplicateAndRank(enriched);
  console.log(`  → ${restaurants.length} unique restaurants after dedup\n`);

  // Step 5: Upsert into DB (deduplicate across runs)
  console.log('Step 5: Upserting into DB…');
  const runId = randomUUID();
  await sql`INSERT INTO pipeline_runs (id, city, status) VALUES (${runId}, ${CITY}, 'running')`;

  // Ensure xhs_sources table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS xhs_sources (
      id              TEXT PRIMARY KEY,
      restaurant_id   TEXT NOT NULL REFERENCES xhs_restaurants(id),
      post_url        TEXT NOT NULL,
      recommendation  TEXT,
      likes           INTEGER NOT NULL DEFAULT 0,
      post_created_at TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const MAX_SOURCES = 5;

  for (const r of restaurants) {
    // Check for existing restaurant by google_place_id or normalized name
    const normalizedName = r.restaurantName.toLowerCase().replace(/[\s\-_·•]+/g, '').replace(/[^\p{L}\p{N}]/gu, '');
    const existing = db.prepare(`
      SELECT id, mention_count, total_likes FROM xhs_restaurants
      WHERE city = ? AND (
        (google_place_id IS NOT NULL AND google_place_id = ?)
        OR LOWER(REPLACE(REPLACE(REPLACE(restaurant_name, ' ', ''), '-', ''), '_', '')) = ?
      )
      LIMIT 1
    `).get(CITY, r.googlePlaceId, normalizedName) as { id: string; mention_count: number; total_likes: number } | undefined;

    if (existing) {
      // Update existing: bump mention_count/total_likes, fill borough/neighborhood if missing
      db.prepare(`
        UPDATE xhs_restaurants
        SET mention_count = mention_count + ?,
            total_likes = total_likes + ?,
            borough = COALESCE(borough, ?),
            neighborhood = COALESCE(neighborhood, ?),
            pipeline_run_id = ?
        WHERE id = ?
      `).run(r.mentionCount, r.totalLikes, r.borough, r.neighborhood, runId, existing.id);

      // Add source if under limit and URL not already present
      const sourceCount = (db.prepare(`SELECT COUNT(*) as c FROM xhs_sources WHERE restaurant_id = ?`).get(existing.id) as { c: number }).c;
      const urlExists = db.prepare(`SELECT 1 FROM xhs_sources WHERE restaurant_id = ? AND post_url = ?`).get(existing.id, r.postUrl);

      if (!urlExists && sourceCount < MAX_SOURCES) {
        db.prepare(`INSERT INTO xhs_sources (id, restaurant_id, post_url, recommendation, likes, post_created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), existing.id, r.postUrl, r.recommendation, r.totalLikes, r.postCreatedAt ?? null);
      }

      console.log(`  ↻ Updated existing: ${r.restaurantName} (sources: ${Math.min(sourceCount + 1, MAX_SOURCES)}/${MAX_SOURCES})`);
    } else {
      // Insert new restaurant
      const newId = randomUUID();
      await sql`
        INSERT INTO xhs_restaurants (
          id, city, restaurant_name, address, borough, neighborhood, cuisine_type,
          recommendation, post_url, post_created_at,
          mention_count, total_likes,
          google_place_id, google_maps_url, google_display_name, website_url,
          photo_url, photo_urls,
          pipeline_run_id
        ) VALUES (
          ${newId}, ${CITY},
          ${r.restaurantName}, ${r.address}, ${r.borough}, ${r.neighborhood}, ${r.cuisineKey},
          ${r.recommendation}, ${r.postUrl}, ${r.postCreatedAt ?? null},
          ${r.mentionCount}, ${r.totalLikes},
          ${r.googlePlaceId}, ${r.googleMapsUrl}, ${r.googleDisplayName}, ${r.websiteUrl},
          ${r.photoUrl}, ${r.photoUrls.length ? JSON.stringify(r.photoUrls) : null},
          ${runId}
        )
      `;

      // Also add the first source entry
      db.prepare(`INSERT INTO xhs_sources (id, restaurant_id, post_url, recommendation, likes, post_created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), newId, r.postUrl, r.recommendation, r.totalLikes, r.postCreatedAt ?? null);

      console.log(`  ✚ New: ${r.restaurantName}`);
    }
  }

  await sql`
    UPDATE pipeline_runs
    SET status = 'completed', completed_at = ${new Date().toISOString()},
        post_count = ${rawPosts.length}, restaurant_count = ${restaurants.length}
    WHERE id = ${runId}
  `;

  // Step 6: Verify DB rows
  console.log('\n=== DB Results ===');
  const rows = db.prepare(`
    SELECT restaurant_name, google_maps_url, google_place_id, mention_count, total_likes
    FROM xhs_restaurants
    WHERE pipeline_run_id = ?
    ORDER BY (
      mention_count * 10 +
      total_likes * (
        CASE
          WHEN post_created_at IS NULL THEN 0.4
          WHEN julianday('now') - julianday(post_created_at) <= 7 THEN 1.0
          WHEN julianday('now') - julianday(post_created_at) >= 60 THEN 0.2
          ELSE 1.0 - ((julianday('now') - julianday(post_created_at)) - 7) / 53.0 * 0.8
        END
      )
    ) DESC
  `).all(runId) as Array<Record<string, unknown>>;

  console.log(`\n${rows.length} restaurants in DB:\n`);
  for (const row of rows) {
    console.log(`  ${row.restaurant_name}`);
    console.log(`    Maps: ${row.google_maps_url ?? '(none)'}`);
    console.log(`    mentions=${row.mention_count} likes=${row.total_likes}\n`);
  }

  const withMaps = rows.filter((r) => r.google_maps_url).length;
  console.log(`Google Maps URL: ${withMaps}/${rows.length} restaurants enriched`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
