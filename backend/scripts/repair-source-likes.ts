/**
 * One-off repair for the comma-likes bug (2026-11-27): rednote formats note
 * counts as "6,809", and parseCount used to stop at the comma (→ 6). Posts
 * files regenerated after the fix carry the right likes; this copies them onto
 * existing local xhs_sources rows and shifts each restaurant's total_likes by
 * the same delta. Local SQLite only.
 *
 *   CITY=la [POSTS_FILE=…] [DRY_RUN=1] npx ts-node -T scripts/repair-source-likes.ts
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const CITY = process.env.CITY ?? 'nyc';
const POSTS_FILE = process.env.POSTS_FILE ?? path.resolve(__dirname, `../data/xhs-raw/posts-${CITY}.json`);
const DRY_RUN = process.env.DRY_RUN === '1';

const db = new Database(path.resolve(__dirname, '../data/wheretoeat.db'));
const posts = JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8')) as Array<{ postUrl: string; likes: number }>;
const likesByUrl = new Map(posts.map((p) => [p.postUrl, p.likes]));

const rows = db.prepare(`
  SELECT s.id, s.restaurant_id AS restaurantId, s.post_url AS postUrl, s.likes
  FROM xhs_sources s JOIN xhs_restaurants r ON r.id = s.restaurant_id
  WHERE r.city = ? AND s.source_type = 'xiaohongshu'
`).all(CITY) as Array<{ id: string; restaurantId: string; postUrl: string; likes: number }>;

const updSource = db.prepare(`UPDATE xhs_sources SET likes = ? WHERE id = ?`);
const updTotal = db.prepare(`UPDATE xhs_restaurants SET total_likes = total_likes + ? WHERE id = ?`);

let fixed = 0;
const restaurants = new Set<string>();
db.transaction(() => {
  for (const r of rows) {
    const correct = likesByUrl.get(r.postUrl);
    if (correct == null || correct === r.likes) continue;
    console.log(`  ${r.postUrl.split('/').pop()}  ${r.likes} → ${correct}`);
    fixed++;
    restaurants.add(r.restaurantId);
    if (DRY_RUN) continue;
    updSource.run(correct, r.id);
    updTotal.run(correct - r.likes, r.restaurantId);
  }
})();
console.log(`${DRY_RUN ? '[dry run] ' : ''}city=${CITY}: ${fixed} source rows fixed across ${restaurants.size} restaurants (${rows.length} XHS sources checked)`);
