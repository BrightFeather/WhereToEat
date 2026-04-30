/**
 * Verify the weekly endpoint query logic directly against the DB:
 *   npx ts-node scripts/test-weekly.ts
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { db } from '../api/_lib/db';

const FRESHNESS_DAYS = 7;

const latestCompleted = db.prepare(`
  SELECT id, completed_at
  FROM pipeline_runs
  WHERE city = 'nyc' AND status = 'completed'
  ORDER BY completed_at DESC
  LIMIT 1
`).get() as { id: string; completed_at: string } | undefined;

if (!latestCompleted) {
  console.log('No completed pipeline run found. Run test-pipeline.ts first.');
  process.exit(1);
}

const ageMs = Date.now() - new Date(latestCompleted.completed_at).getTime();
const isFresh = ageMs < FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
console.log(`Latest run: ${latestCompleted.id}`);
console.log(`Completed: ${latestCompleted.completed_at}`);
console.log(`Status: ${isFresh ? 'ready' : 'stale'}\n`);

const rows = db.prepare(`
  SELECT
    id,
    restaurant_name      AS restaurantName,
    address,
    borough,
    neighborhood,
    cuisine_type         AS cuisineType,
    recommendation,
    post_url             AS postUrl,
    post_created_at      AS postCreatedAt,
    mention_count        AS mentionCount,
    total_likes          AS totalLikes,
    google_place_id      AS googlePlaceId,
    google_maps_url      AS googleMapsUrl,
    google_display_name  AS googleDisplayName,
    website_url          AS websiteUrl
  FROM xhs_restaurants
  WHERE pipeline_run_id = ?
    AND is_available_this_week = 1
    AND google_maps_url IS NOT NULL
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
`).all(latestCompleted.id) as Array<Record<string, unknown>>;

console.log(`Weekly endpoint would return ${rows.length} restaurants:\n`);
console.log(JSON.stringify({ status: isFresh ? 'ready' : 'stale', restaurants: rows }, null, 2));

db.close();
