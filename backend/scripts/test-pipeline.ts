/**
 * Direct end-to-end pipeline test (no HTTP server needed):
 *   npx ts-node scripts/test-pipeline.ts
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { sql } from '../api/_lib/db';

// Pipeline writes to local SQLite directly (the Neon-side `sql` is used only
// for `pipeline_runs` + restaurant insert path, which routes through `sql`
// when ON_VERCEL=true; locally both go to the same SQLite file).
const db = new Database(path.resolve(__dirname, '../data/wheretoeat.db'));
db.pragma('journal_mode = WAL');
import { searchXhsPosts, type RawXhsPost } from '../api/_lib/xhsScraper';
import { extractRestaurantData } from '../api/_lib/llmExtractor';
import { enrichWithPlaces } from '../api/_lib/placesEnricher';
import { deduplicateAndRank, sourceScore, MAX_XHS_SOURCES_PER_RESTAURANT, type EnrichedRestaurant } from '../api/_lib/restaurantMerger';

const CITY = process.env.CITY ?? 'nyc';
const HASHTAGS = ['#纽约美食', '#NewYorkRestaurant', '#NYCEats'];
const MAX_PAGES = 10;
const PLACES_DELAY_MS = 200;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function main() {
  console.log('=== Pipeline Test ===\n');

  // Step 1: Posts — either a pre-scraped file from the browser ingest
  // (POSTS_FILE=data/xhs-raw/posts.json, see scripts/xhs-browser-ingest.ts)
  // or the legacy `xhs` CLI scrape.
  const rawPosts: RawXhsPost[] = [];
  if (process.env.POSTS_FILE) {
    const file = path.resolve(process.cwd(), process.env.POSTS_FILE);
    rawPosts.push(...(JSON.parse(fs.readFileSync(file, 'utf8')) as RawXhsPost[]));
    console.log(`Step 1: Loaded ${rawPosts.length} posts from ${file}\n`);
  } else {
    console.log(`Step 1: Scraping XHS posts for tags: ${HASHTAGS.join(', ')} (past 30 days)…`);
    const seen = new Set<string>();
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
  }

  // Step 2: LLM extraction
  console.log('Step 2: LLM extraction…');
  // Concurrent extraction (EXTRACT_CONCURRENCY, default 5) with a per-note
  // cache in data/xhs-raw/extract/<city>-v1/ so a rerun or crash doesn't
  // repeat finished DeepSeek calls. Bump the `-v1` suffix whenever the
  // extractor prompt changes. Empty results aren't cached: the extractor
  // returns [] both for "no restaurants / complaint" and on API errors.
  const concurrency = Number(process.env.EXTRACT_CONCURRENCY ?? 5);
  const cacheDir = path.resolve(__dirname, `../data/xhs-raw/extract/${CITY}-v1`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const perPost: Awaited<ReturnType<typeof extractRestaurantData>>[] = new Array(rawPosts.length);
  let next = 0, done = 0, cachedHits = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, rawPosts.length) }, async () => {
    while (next < rawPosts.length) {
      const i = next++;
      const p = rawPosts[i];
      const file = path.join(cacheDir, `${p.noteId}.json`);
      if (fs.existsSync(file)) {
        perPost[i] = JSON.parse(fs.readFileSync(file, 'utf8'));
        cachedHits++;
      } else {
        perPost[i] = await extractRestaurantData(p, CITY);
        if (perPost[i].length) fs.writeFileSync(file, JSON.stringify(perPost[i]));
      }
      if (++done % 10 === 0 || done === rawPosts.length) {
        console.log(`  extracted ${done}/${rawPosts.length} posts (cache hits ${cachedHits})`);
      }
    }
  }));
  const extracted = perPost.flat();
  console.log(`  → ${extracted.length} restaurants extracted\n`);

  // Step 3b: Places enrichment
  console.log('Step 3b: Google Places enrichment…');
  const enriched: EnrichedRestaurant[] = [];
  for (let i = 0; i < extracted.length; i++) {
    const r = extracted[i];
    const places = await enrichWithPlaces(r, CITY);
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

  // Up to MAX_XHS_SOURCES_PER_RESTAURANT (10) XHS posts per restaurant, ranked
  // by popularity × freshness (sourceScore). A restaurant that already has 10
  // still accepts a new post when it would rank in its top 10, so fresh posts
  // aren't locked out. Nothing is deleted: the weekly API serves the top 10 by
  // score, so a displaced post stays stored but stops being shown.
  const MAX_SOURCES = Number(process.env.MAX_SOURCES_PER_RESTAURANT ?? MAX_XHS_SOURCES_PER_RESTAURANT);

  const insertSource = db.prepare(
    `INSERT INTO xhs_sources (id, restaurant_id, post_url, recommendation, likes, post_created_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const nowIso = new Date().toISOString();

  // Insert per-post sources (own likes + date) that make the restaurant's
  // top MAX_SOURCES by score, skipping URLs already stored. Returns what was
  // actually added so re-runs don't inflate mention_count / total_likes.
  function addSources(restaurantId: string, sources: typeof restaurants[number]['sources']) {
    const scores = (db.prepare(
      `SELECT likes, post_created_at AS postCreatedAt FROM xhs_sources WHERE restaurant_id = ? AND source_type = 'xiaohongshu'`
    ).all(restaurantId) as Array<{ likes: number; postCreatedAt: string | null }>).map(sourceScore);
    let added = 0, likes = 0;
    for (const s of [...sources].sort((a, b) => sourceScore(b) - sourceScore(a))) {
      if (db.prepare(`SELECT 1 FROM xhs_sources WHERE restaurant_id = ? AND post_url = ?`).get(restaurantId, s.postUrl)) continue;
      const score = sourceScore(s);
      if (scores.length >= MAX_SOURCES) {
        const cutoff = [...scores].sort((a, b) => b - a)[MAX_SOURCES - 1];
        if (score <= cutoff) continue; // wouldn't make this restaurant's top N
      }
      insertSource.run(randomUUID(), restaurantId, s.postUrl, s.recommendation, s.likes, s.postCreatedAt ?? null);
      scores.push(score); added++; likes += s.likes;
    }
    return { added, likes, count: scores.length };
  }

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

    const featuresJson = r.features.length ? JSON.stringify(r.features) : null;

    if (existing) {
      const { added, likes, count } = addSources(existing.id, r.sources);
      // Bump counts only by what was newly added; refresh recency to the
      // newest post; fill any enrichment fields that are still empty.
      db.prepare(`
        UPDATE xhs_restaurants
        SET mention_count = mention_count + ?,
            total_likes = total_likes + ?,
            post_created_at = CASE WHEN post_created_at IS NULL OR post_created_at < ? THEN ? ELSE post_created_at END,
            borough = COALESCE(borough, ?),
            neighborhood = COALESCE(neighborhood, ?),
            cuisine_type = COALESCE(cuisine_type, ?),
            features = CASE WHEN features IS NULL OR features = '[]' THEN ? ELSE features END,
            google_rating = COALESCE(?, google_rating),
            google_user_rating_count = COALESCE(?, google_user_rating_count),
            instagram_url = COALESCE(instagram_url, ?),
            latitude = COALESCE(latitude, ?),
            longitude = COALESCE(longitude, ?),
            price_level = COALESCE(price_level, ?),
            website_url = COALESCE(website_url, ?),
            photo_url = COALESCE(photo_url, ?),
            updated_at = ?,
            pipeline_run_id = ?
        WHERE id = ?
      `).run(
        added, likes,
        r.postCreatedAt, r.postCreatedAt,
        r.borough, r.neighborhood, r.cuisineKey, featuresJson,
        r.googleRating, r.googleUserRatingCount, r.instagramUrl,
        r.latitude, r.longitude, r.priceLevel, r.websiteUrl, r.photoUrl,
        nowIso, runId, existing.id,
      );
      console.log(`  ↻ Updated existing: ${r.restaurantName} (+${added} sources, ${count} XHS stored, top ${MAX_SOURCES} served)`);
    } else {
      // Insert new restaurant with every field the pipeline produced
      const newId = randomUUID();
      const kept = r.sources.slice(0, MAX_SOURCES);
      await sql`
        INSERT INTO xhs_restaurants (
          id, city, restaurant_name, address, borough, neighborhood, cuisine_type,
          recommendation, post_url, post_created_at,
          mention_count, total_likes,
          google_place_id, google_maps_url, google_display_name, website_url,
          photo_url, photo_urls,
          features, google_rating, google_user_rating_count, instagram_url,
          latitude, longitude, price_level, updated_at,
          pipeline_run_id
        ) VALUES (
          ${newId}, ${CITY},
          ${r.restaurantName}, ${r.address}, ${r.borough}, ${r.neighborhood}, ${r.cuisineKey},
          ${r.recommendation}, ${r.postUrl}, ${r.postCreatedAt ?? null},
          ${kept.length}, ${kept.reduce((n, s) => n + s.likes, 0)},
          ${r.googlePlaceId}, ${r.googleMapsUrl}, ${r.googleDisplayName}, ${r.websiteUrl},
          ${r.photoUrl}, ${r.photoUrls.length ? JSON.stringify(r.photoUrls) : null},
          ${featuresJson}, ${r.googleRating}, ${r.googleUserRatingCount}, ${r.instagramUrl},
          ${r.latitude}, ${r.longitude}, ${r.priceLevel}, ${nowIso},
          ${runId}
        )
      `;
      addSources(newId, kept);
      console.log(`  ✚ New: ${r.restaurantName} (${kept.length} sources)`);
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
