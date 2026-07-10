/**
 * Walk every xhs_sources row, classify with DeepSeek-V4-Pro, and DELETE any
 * post that contains a complaint. Mirrors deletes to Neon when DATABASE_URL
 * is configured.
 *
 *   npx ts-node scripts/scrub-negative-sources.ts
 *
 * Env knobs:
 *   LIMIT          (cap rows scanned; default unlimited)
 *   ONLY_CUISINES  (comma-list; default unscoped)
 *   DRY_RUN=1      (classify only, no deletes)
 *   DELAY_MS       (default 200)
 *   SKIP_NEON=1    (skip cloud sync — local only)
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import Database from 'better-sqlite3';
import { neon } from '@neondatabase/serverless';
import { classifyComplaint } from '../api/_lib/llmExtractor';

const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;
const ONLY_CUISINES = (process.env.ONLY_CUISINES ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const DRY_RUN = process.env.DRY_RUN === '1';
const DELAY_MS = parseInt(process.env.DELAY_MS ?? '200', 10);
const SKIP_NEON = process.env.SKIP_NEON === '1';

const db = new Database(path.join(process.cwd(), 'data/wheretoeat.db'));
db.pragma('journal_mode = WAL');

const neonUrl =
  process.env.DATABASE_URL ||
  process.env.WHERE_TO_EAT_DATABASE_URL ||
  process.env.WHERE_TO_EAT_POSTGRES_URL ||
  process.env.POSTGRES_URL;
const sql = !SKIP_NEON && neonUrl ? neon(neonUrl) : null;

interface SourceRow {
  id: string;
  restaurant_id: string;
  post_url: string;
  recommendation: string | null;
  cuisine_type: string | null;
  restaurant_name: string;
}

const baseSql = `
  SELECT s.id, s.restaurant_id, s.post_url, s.recommendation,
         r.cuisine_type, r.restaurant_name
  FROM xhs_sources s
  JOIN xhs_restaurants r ON r.id = s.restaurant_id
  WHERE (s.source_type IS NULL OR s.source_type = 'xiaohongshu')
    AND s.recommendation IS NOT NULL AND LENGTH(s.recommendation) >= 30
`;
const filtered = ONLY_CUISINES.length
  ? `${baseSql} AND r.cuisine_type IN (${ONLY_CUISINES.map(() => '?').join(',')})`
  : baseSql;
const allRows = db.prepare(filtered).all(...ONLY_CUISINES) as SourceRow[];
const rows = isFinite(LIMIT) ? allRows.slice(0, LIMIT) : allRows;

console.log(`[scrub] scanning ${rows.length} sources (cuisines=${ONLY_CUISINES.length ? ONLY_CUISINES.join(',') : 'all'}) DRY_RUN=${DRY_RUN}`);
if (sql) console.log('[scrub] neon sync ON');
else console.log('[scrub] neon sync OFF');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const delLocal = db.prepare(`DELETE FROM xhs_sources WHERE id = ?`);

(async () => {
  let scanned = 0, dropped = 0, kept = 0, errors = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    scanned++;
    try {
      const verdict = await classifyComplaint({
        title: '',
        body: r.recommendation ?? '',
        restaurantName: r.restaurant_name,
      });
      if (verdict.hasComplaint) {
        dropped++;
        console.log(`  [${i + 1}/${rows.length}] × ${r.restaurant_name} (${r.cuisine_type ?? '-'}) — ${verdict.reason}`);
        if (!DRY_RUN) {
          delLocal.run(r.id);
          if (sql) {
            await sql`DELETE FROM xhs_sources WHERE id = ${r.id}`;
          }
        }
      } else {
        kept++;
      }
    } catch (e) {
      errors++;
      console.warn(`  [${i + 1}] error ${r.id}: ${String(e).slice(0, 120)}`);
    }
    if (i < rows.length - 1) await sleep(DELAY_MS);
  }
  console.log(`\n[scrub] done — scanned=${scanned} dropped=${dropped} kept=${kept} errors=${errors}`);
  db.close();
})();
