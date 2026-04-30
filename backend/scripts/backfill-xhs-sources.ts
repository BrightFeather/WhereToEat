/**
 * Backfill `xhs_sources` from the denormalised post_url / recommendation /
 * total_likes / post_created_at columns on `xhs_restaurants`.
 *
 *   npx ts-node scripts/backfill-xhs-sources.ts
 *
 * One row per restaurant — the "best post" the merger picked at ingest time.
 * Idempotent via the (restaurant_id, post_url) unique index — re-runs are
 * no-ops. Doesn't recover historical posts beyond the one we kept; rows that
 * had `mention_count >= 2` will still show 1 source until the next pipeline
 * run rewrites them with the full per-post evidence.
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

const db = new Database(path.join(__dirname, '../data/wheretoeat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

interface Row {
  id: string;
  post_url: string | null;
  recommendation: string | null;
  post_created_at: string | null;
  total_likes: number | null;
}

const rows = db
  .prepare(
    `SELECT id, post_url, recommendation, post_created_at, total_likes
     FROM xhs_restaurants
     WHERE post_url IS NOT NULL`,
  )
  .all() as Row[];

console.log(`[backfill] candidate rows: ${rows.length}`);

const before = (
  db
    .prepare(
      `SELECT COUNT(DISTINCT restaurant_id) AS with_any
       FROM xhs_sources
       WHERE source_type IS NULL OR source_type = 'xiaohongshu'`,
    )
    .get() as { with_any: number }
).with_any;

const insert = db.prepare(`
  INSERT INTO xhs_sources (id, restaurant_id, post_url, recommendation, likes, post_created_at, source_type)
  VALUES (?, ?, ?, ?, ?, ?, 'xiaohongshu')
  ON CONFLICT (restaurant_id, post_url) DO NOTHING
`);

let inserted = 0;
let skipped = 0;
const tx = db.transaction(() => {
  for (const r of rows) {
    if (!r.post_url) {
      skipped++;
      continue;
    }
    const result = insert.run(
      randomUUID(),
      r.id,
      r.post_url,
      r.recommendation,
      r.total_likes ?? 0,
      r.post_created_at,
    );
    if (result.changes > 0) inserted++;
    else skipped++;
  }
});
tx();

const after = (
  db
    .prepare(
      `SELECT COUNT(DISTINCT restaurant_id) AS with_any
       FROM xhs_sources
       WHERE source_type IS NULL OR source_type = 'xiaohongshu'`,
    )
    .get() as { with_any: number }
).with_any;

const multi = (
  db
    .prepare(
      `WITH per AS (
         SELECT restaurant_id, COUNT(DISTINCT post_url) AS n
         FROM xhs_sources
         WHERE source_type IS NULL OR source_type = 'xiaohongshu'
         GROUP BY restaurant_id
       )
       SELECT COUNT(*) AS multi FROM per WHERE n >= 2`,
    )
    .get() as { multi: number }
).multi;

console.log(`\nDone. inserted: ${inserted}, skipped: ${skipped} (already present / no post_url)`);
console.log(`xhs_sources distinct restaurant_id  before: ${before}  →  after: ${after}`);
console.log(`restaurants with ≥2 distinct XHS posts (post-backfill): ${multi}`);
db.close();
