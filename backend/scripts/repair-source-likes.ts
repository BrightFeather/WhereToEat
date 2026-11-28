/**
 * One-off repair for the comma-likes bug (2026-11-27): rednote formats note
 * counts as "6,809", and parseCount used to stop at the comma (→ 6).
 *
 * The correct count comes from each note's cached raw state
 * (data/xhs-raw/notes/<id>.json → raw.interactInfo.likedCount), so nothing is
 * re-read from RedNote. Then:
 *   1. posts-<city>.json: likes corrected in place.
 *   2. Local SQLite: xhs_sources.likes set, restaurant total_likes += delta.
 *   3. With NEON=1: the same on Neon, matched by (restaurant_id, post_url),
 *      delta computed against Neon's own stored likes.
 *
 *   CITY=nyc [DRY_RUN=1] [NEON=1] npx ts-node -T scripts/repair-source-likes.ts
 */
import path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local'), quiet: true } as dotenv.DotenvConfigOptions);
import Database from 'better-sqlite3';
import { neon } from '@neondatabase/serverless';
import { parseCount } from '../api/_lib/xhsBrowser';

const CITY = process.env.CITY ?? 'nyc';
const POSTS_FILE = process.env.POSTS_FILE ?? path.resolve(__dirname, `../data/xhs-raw/posts-${CITY}.json`);
const NOTES_DIR = path.resolve(__dirname, '../data/xhs-raw/notes');
const DRY_RUN = process.env.DRY_RUN === '1';
const NEON = process.env.NEON === '1';
const tag = DRY_RUN ? '[dry run] ' : '';

type Post = { noteId: string; postUrl: string; likes: number };

function correctLikes(posts: Post[]): Map<string, number> {
  const byUrl = new Map<string, number>();
  let changed = 0;
  for (const p of posts) {
    const file = path.join(NOTES_DIR, `${p.noteId}.json`);
    const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).raw?.interactInfo?.likedCount : undefined;
    const likes = raw != null ? parseCount(raw) : p.likes;
    if (likes !== p.likes) { changed++; p.likes = likes; }
    byUrl.set(p.postUrl, likes);
  }
  console.log(`${tag}posts file: ${changed}/${posts.length} posts had wrong likes`);
  if (changed && !DRY_RUN) fs.writeFileSync(POSTS_FILE, JSON.stringify(posts, null, 2));
  return byUrl;
}

function repairLocal(likesByUrl: Map<string, number>) {
  const db = new Database(path.resolve(__dirname, '../data/wheretoeat.db'));
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
      fixed++;
      restaurants.add(r.restaurantId);
      if (DRY_RUN) continue;
      updSource.run(correct, r.id);
      updTotal.run(correct - r.likes, r.restaurantId);
    }
  })();
  console.log(`${tag}local: ${fixed} source rows fixed across ${restaurants.size} restaurants (${rows.length} XHS sources checked)`);
}

async function repairNeon(likesByUrl: Map<string, number>) {
  const url = process.env.DATABASE_URL || process.env.WHERE_TO_EAT_DATABASE_URL || process.env.WHERE_TO_EAT_POSTGRES_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('No Neon connection string in env — run `vercel env pull` first');
  const sql = neon(url);
  const urls = [...likesByUrl.keys()];
  const rows = await sql`
    SELECT s.restaurant_id, s.post_url, s.likes, r.restaurant_name
    FROM xhs_sources s JOIN xhs_restaurants r ON r.id = s.restaurant_id
    WHERE r.city = ${CITY} AND s.post_url = ANY(${urls})
  ` as Array<{ restaurant_id: string; post_url: string; likes: number; restaurant_name: string }>;
  let fixed = 0;
  const restaurants = new Set<string>();
  for (const r of rows) {
    const correct = likesByUrl.get(r.post_url)!;
    if (correct === Number(r.likes)) continue;
    fixed++;
    restaurants.add(r.restaurant_id);
    console.log(`  neon ${r.restaurant_name}: ${r.post_url.split('/').pop()} ${r.likes} → ${correct}`);
    if (DRY_RUN) continue;
    await sql`UPDATE xhs_sources SET likes = ${correct} WHERE restaurant_id = ${r.restaurant_id} AND post_url = ${r.post_url}`;
    await sql`UPDATE xhs_restaurants SET total_likes = total_likes + ${correct - Number(r.likes)} WHERE id = ${r.restaurant_id}`;
  }
  console.log(`${tag}neon: ${fixed} source rows fixed across ${restaurants.size} restaurants (${rows.length} matching sources)`);
}

async function main() {
  const posts = JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8')) as Post[];
  const likesByUrl = correctLikes(posts);
  repairLocal(likesByUrl);
  if (NEON) await repairNeon(likesByUrl);
}

main().catch((e) => { console.error(e); process.exit(1); });
