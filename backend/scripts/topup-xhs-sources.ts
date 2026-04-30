/**
 * Top up `xhs_sources` so every restaurant has up to N XHS posts ≤365 days
 * old. For each restaurant currently in `xhs_restaurants` with fewer than N
 * sources, run `xhs search "<restaurant_name>"`, score by (name-in-title) +
 * likes, fetch the top candidates, and insert posts that pass a relevance
 * check.
 *
 *   npx ts-node scripts/topup-xhs-sources.ts
 *
 * Env knobs:
 *   TARGET_PER_RESTAURANT (default 3)
 *   LIMIT                 (cap on # of restaurants to process — for smoke tests)
 *   MAX_SEARCH_PAGES      (default 2 — ~40 search hits per restaurant)
 *   READNOTE_DELAY_MS     (default 400)
 *   DRY_RUN=1             (do everything except DB writes)
 *
 * Idempotent — `(restaurant_id, post_url)` is unique, ON CONFLICT DO NOTHING.
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { readNote } from '../api/_lib/xhsScraper';

const TARGET = parseInt(process.env.TARGET_PER_RESTAURANT ?? '3', 10);
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;
const MAX_SEARCH_PAGES = parseInt(process.env.MAX_SEARCH_PAGES ?? '2', 10);
const READNOTE_DELAY_MS = parseInt(process.env.READNOTE_DELAY_MS ?? '400', 10);
const DRY_RUN = process.env.DRY_RUN === '1';
/** When set, only operate on restaurants that currently have 0 XHS sources.
 *  Useful for prioritising the "absolutely no posts yet" cohort first. */
const ZERO_ONLY = process.env.ZERO_ONLY === '1';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const db = new Database(path.join(process.cwd(), 'data/wheretoeat.db'));
db.pragma('journal_mode = WAL');

interface RestoRow {
  id: string;
  restaurant_name: string;
  google_display_name: string | null;
  borough: string | null;
  neighborhood: string | null;
  existing_count: number;
}

const candidates = db.prepare(`
  SELECT r.id, r.restaurant_name, r.google_display_name, r.borough, r.neighborhood,
         (SELECT COUNT(DISTINCT s.post_url)
            FROM xhs_sources s
            WHERE s.restaurant_id = r.id
              AND (s.source_type IS NULL OR s.source_type = 'xiaohongshu')) AS existing_count
  FROM xhs_restaurants r
  ORDER BY r.total_likes DESC
`).all() as RestoRow[];

const eligible = candidates
  .filter((r) => r.existing_count < TARGET)
  .filter((r) => (ZERO_ONLY ? r.existing_count === 0 : true))
  .slice(0, LIMIT);

console.log(`[topup] ${candidates.length} total restaurants; ${eligible.length} have <${TARGET} XHS sources`);
if (DRY_RUN) console.log('[topup] DRY_RUN=1 — no DB writes');

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/\s+/g, '');
}

function nyclike(text: string, restaurant: RestoRow): boolean {
  const t = text.toLowerCase();
  const tokens = [
    '纽约', 'nyc', 'new york', '曼哈顿', 'manhattan',
    'brooklyn', '布鲁克林', 'queens', '皇后', '法拉盛', 'flushing',
    'staten', 'bronx',
    restaurant.borough?.toLowerCase(),
    restaurant.neighborhood?.toLowerCase(),
  ].filter((s): s is string => !!s);
  return tokens.some((tok) => t.includes(tok));
}

function isRelevant(args: {
  title: string;
  body: string;
  resto: RestoRow;
  ageDays: number;
}): { ok: boolean; reason: string } {
  const { title, body, resto, ageDays } = args;
  if (ageDays > 365) return { ok: false, reason: 'too_old' };
  if (body.length < 30) return { ok: false, reason: 'too_short' };

  const haystack = normalize(title + ' ' + body);
  const names = [resto.restaurant_name, resto.google_display_name].filter(
    (n): n is string => !!n,
  );
  const matched = names.some((n) => {
    const nn = normalize(n);
    return nn.length >= 3 && haystack.includes(nn);
  });
  if (!matched) return { ok: false, reason: 'name_not_found' };

  if (!nyclike(title + ' ' + body, resto)) return { ok: false, reason: 'not_nyc' };

  return { ok: true, reason: 'ok' };
}

function parseLikes(raw: string | number | undefined | null): number {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (s.includes('万')) return Math.round(parseFloat(s) * 10000);
  return parseInt(s, 10) || 0;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── XHS CLI search wrapper ────────────────────────────────────────────────
//
// Uses the same path the scraper does (CLI locally, HTTP on Vercel) but the
// public `searchPage` isn't exported, so we shell out to the CLI directly
// here. Falls back gracefully when the CLI is missing.
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as yaml from 'js-yaml';
const execFileAsync = promisify(execFile);

interface SearchHit {
  noteId: string;
  xsecToken?: string;
  displayTitle?: string;
  likes: number;
}

async function xhsSearch(query: string, page: number): Promise<SearchHit[]> {
  try {
    const { stdout } = await execFileAsync(
      'xhs',
      ['search', query, '--sort', 'popular', '--page', String(page)],
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
    );
    const parsed = yaml.load(stdout) as {
      data?: { items?: Array<{
        id?: string;
        xsec_token?: string;
        note_card?: { display_title?: string; interact_info?: { liked_count?: string } };
      }> };
    };
    const items = parsed?.data?.items ?? [];
    return items
      .filter((it) => typeof it.id === 'string' && /^[a-f0-9]{24}$/.test(it.id))
      .map((it) => ({
        noteId: it.id!,
        xsecToken: it.xsec_token,
        displayTitle: it.note_card?.display_title,
        likes: parseLikes(it.note_card?.interact_info?.liked_count),
      }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('ENOENT')) {
      console.warn(`  [search-fail] ${query} p${page}: ${msg.slice(0, 120)}`);
    }
    return [];
  }
}

// ─── Insert ────────────────────────────────────────────────────────────────

const insert = db.prepare(`
  INSERT INTO xhs_sources (id, restaurant_id, post_url, recommendation, likes, post_created_at, source_type)
  VALUES (?, ?, ?, ?, ?, ?, 'xiaohongshu')
  ON CONFLICT (restaurant_id, post_url) DO NOTHING
`);

// ─── Main loop ─────────────────────────────────────────────────────────────

(async () => {
  let totalAdded = 0;
  let totalSearched = 0;
  let totalSkipped = 0;
  const reasons = new Map<string, number>();

  for (let i = 0; i < eligible.length; i++) {
    const resto = eligible[i];
    const need = TARGET - resto.existing_count;
    const queryName = resto.google_display_name?.trim() || resto.restaurant_name;

    console.log(`[${i + 1}/${eligible.length}] ${resto.restaurant_name} — has ${resto.existing_count}, need ${need}`);

    // Collect candidates from MAX_SEARCH_PAGES.
    const seenNoteIds = new Set(
      (db.prepare(
        `SELECT post_url FROM xhs_sources WHERE restaurant_id = ?`,
      ).all(resto.id) as Array<{ post_url: string }>)
        .map((r) => {
          const m = r.post_url.match(/\/(?:explore|discovery\/item)\/([a-f0-9]{24})/);
          return m?.[1];
        })
        .filter((s): s is string => !!s),
    );

    const candidatesForResto: SearchHit[] = [];
    for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
      const hits = await xhsSearch(queryName, page);
      totalSearched += hits.length;
      for (const hit of hits) {
        if (seenNoteIds.has(hit.noteId)) continue;
        seenNoteIds.add(hit.noteId);
        candidatesForResto.push(hit);
      }
      if (hits.length === 0) break;
    }
    // Score: name-in-title = 2x, otherwise 1x; multiply by likes.
    const scored = candidatesForResto.map((hit) => {
      const titleHas = hit.displayTitle
        ? normalize(hit.displayTitle).includes(normalize(queryName))
        : false;
      const score = (titleHas ? 2 : 1) * Math.max(hit.likes, 1);
      return { ...hit, score };
    }).sort((a, b) => b.score - a.score);

    let added = 0;
    for (const hit of scored) {
      if (added >= need) break;

      // Read full note for body + age + dedupe-able post URL.
      const note = await readNote(hit.noteId, hit.xsecToken);
      await sleep(READNOTE_DELAY_MS);

      const card = note?.note_card;
      if (!card) {
        reasons.set('read_fail', (reasons.get('read_fail') ?? 0) + 1);
        totalSkipped++;
        continue;
      }
      const time = card.time ?? 0;
      const ageDays = time ? (Date.now() - time) / (1000 * 60 * 60 * 24) : 9999;
      const verdict = isRelevant({
        title: card.title ?? '',
        body: card.desc ?? '',
        resto,
        ageDays,
      });
      if (!verdict.ok) {
        reasons.set(verdict.reason, (reasons.get(verdict.reason) ?? 0) + 1);
        totalSkipped++;
        continue;
      }

      const postUrl = `https://www.xiaohongshu.com/explore/${hit.noteId}`;
      const likes = parseLikes(card.interact_info?.liked_count) || hit.likes;
      const createdAt = time ? new Date(time).toISOString() : null;

      if (!DRY_RUN) {
        insert.run(
          randomUUID(),
          resto.id,
          postUrl,
          card.desc ?? null,
          likes,
          createdAt,
        );
      }
      added++;
      totalAdded++;
      console.log(`    ✓ added ${hit.noteId} likes=${likes} age=${Math.round(ageDays)}d`);
    }
    if (added < need) {
      console.log(`    · ${added}/${need} added (search returned ${candidatesForResto.length} candidates)`);
    }
  }

  console.log(`\n[topup] done — searched ${totalSearched} hits, added ${totalAdded}, skipped ${totalSkipped}`);
  if (reasons.size) {
    console.log('\nskip reasons:');
    [...reasons.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
      console.log(`  ${String(v).padStart(4)}  ${k}`);
    });
  }
  db.close();
})();
