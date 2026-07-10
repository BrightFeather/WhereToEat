/**
 * Top up `xhs_sources` for Chinese / Japanese / Korean restaurants so each has
 * ≥ TARGET XHS posts. Prefers NEW posts (--sort time) over old. Each candidate
 * post is classified by DeepSeek-V4-Pro; any post with a complaint is dropped.
 *
 *   npx ts-node scripts/topup-asian-xhs.ts
 *
 * Env knobs:
 *   TARGET_PER_RESTAURANT (default 5)
 *   LIMIT                 (cap on # of restaurants to process)
 *   MAX_SEARCH_PAGES      (default 3)
 *   READNOTE_DELAY_MS     (default 400)
 *   CUISINES              (default "chinese,japanese,korean")
 *   DRY_RUN=1             (no DB writes)
 *
 * Idempotent — `(restaurant_id, post_url)` is unique.
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as yaml from 'js-yaml';
import { classifyComplaint } from '../api/_lib/llmExtractor';

const execFileAsync = promisify(execFile);

const TARGET = parseInt(process.env.TARGET_PER_RESTAURANT ?? '5', 10);
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;
const MAX_SEARCH_PAGES = parseInt(process.env.MAX_SEARCH_PAGES ?? '3', 10);
const READNOTE_DELAY_MS = parseInt(process.env.READNOTE_DELAY_MS ?? '250', 10);
const READNOTE_TIMEOUT_MS = parseInt(process.env.READNOTE_TIMEOUT_MS ?? '6000', 10);
const CUISINES = (process.env.CUISINES ?? 'chinese,japanese,korean')
  .split(',').map((s) => s.trim()).filter(Boolean);
const DRY_RUN = process.env.DRY_RUN === '1';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const db = new Database(path.join(process.cwd(), 'data/wheretoeat.db'));
db.pragma('journal_mode = WAL');

interface RestoRow {
  id: string;
  restaurant_name: string;
  google_display_name: string | null;
  borough: string | null;
  neighborhood: string | null;
  cuisine_type: string | null;
  existing_count: number;
}

const placeholders = CUISINES.map(() => '?').join(',');
const rows = db.prepare(`
  SELECT r.id, r.restaurant_name, r.google_display_name, r.borough, r.neighborhood, r.cuisine_type,
         (SELECT COUNT(DISTINCT s.post_url)
            FROM xhs_sources s
            WHERE s.restaurant_id = r.id
              AND (s.source_type IS NULL OR s.source_type = 'xiaohongshu')) AS existing_count
  FROM xhs_restaurants r
  WHERE r.cuisine_type IN (${placeholders})
  ORDER BY existing_count ASC, r.total_likes DESC
`).all(...CUISINES) as RestoRow[];

const eligible = rows.filter((r) => r.existing_count < TARGET).slice(0, LIMIT);

console.log(`[topup-asian] cuisines=${CUISINES.join(',')}  total=${rows.length}  need_topup=${eligible.length}  target=${TARGET}`);
if (DRY_RUN) console.log('[topup-asian] DRY_RUN=1 — no DB writes');

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

function parseLikes(raw: string | number | undefined | null): number {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (s.includes('万')) return Math.round(parseFloat(s) * 10000);
  return parseInt(s, 10) || 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SearchHit {
  noteId: string;
  xsecToken?: string;
  displayTitle?: string;
  likes: number;
}

interface FastNote {
  title: string;
  desc: string;
  time: number;
  likes: number;
}

/** Fast CLI-only note read with a tight timeout. We skip the HTTP fallback
 *  here on purpose — when the CLI fails fast, we want to move on, not pay a
 *  multi-second SSR fetch for a candidate that's likely irrelevant anyway. */
async function readNoteFast(noteId: string, xsecToken: string | undefined, timeoutMs: number): Promise<FastNote | null> {
  try {
    const args = ['read', noteId];
    if (xsecToken) args.push('--xsec-token', xsecToken);
    const { stdout } = await execFileAsync('xhs', args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    const parsed = yaml.load(stdout) as { ok?: boolean; data?: Record<string, unknown> };
    const data = parsed?.data as Record<string, unknown> | undefined;
    if (!data) return null;

    // CLI v0.6+ flat shape.
    const flat = data as { title?: string; desc?: string; time?: number; interactInfo?: { likedCount?: string | number; liked_count?: string } };
    if (flat.title || flat.desc) {
      return {
        title: flat.title ?? '',
        desc: flat.desc ?? '',
        time: flat.time ?? 0,
        likes: parseLikes(flat.interactInfo?.likedCount ?? flat.interactInfo?.liked_count),
      };
    }
    // Older nested shape.
    const items = data.items as Array<{ note_card?: { title?: string; desc?: string; time?: number; interact_info?: { liked_count?: string } } }> | undefined;
    const card = items?.[0]?.note_card;
    if (card) {
      return {
        title: card.title ?? '',
        desc: card.desc ?? '',
        time: card.time ?? 0,
        likes: parseLikes(card.interact_info?.liked_count),
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function xhsSearch(query: string, page: number, sort: 'latest' | 'popular'): Promise<SearchHit[]> {
  try {
    const { stdout } = await execFileAsync(
      'xhs',
      ['search', query, '--sort', sort, '--page', String(page)],
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
      console.warn(`  [search-fail] ${query} p${page} (${sort}): ${msg.slice(0, 120)}`);
    }
    return [];
  }
}

const insert = db.prepare(`
  INSERT INTO xhs_sources (id, restaurant_id, post_url, recommendation, likes, post_created_at, source_type)
  VALUES (?, ?, ?, ?, ?, ?, 'xiaohongshu')
  ON CONFLICT (restaurant_id, post_url) DO NOTHING
`);

(async () => {
  let totalAdded = 0;
  let totalDroppedNeg = 0;
  const reasons = new Map<string, number>();
  const bump = (k: string) => reasons.set(k, (reasons.get(k) ?? 0) + 1);

  for (let i = 0; i < eligible.length; i++) {
    const resto = eligible[i];
    const need = TARGET - resto.existing_count;
    const queryName = resto.google_display_name?.trim() || resto.restaurant_name;
    console.log(`\n[${i + 1}/${eligible.length}] ${resto.restaurant_name} (${resto.cuisine_type}) — has ${resto.existing_count}, need ${need}`);

    const seenNoteIds = new Set(
      (db.prepare(`SELECT post_url FROM xhs_sources WHERE restaurant_id = ?`).all(resto.id) as Array<{ post_url: string }>)
        .map((r) => r.post_url.match(/\/(?:explore|discovery\/item)\/([a-f0-9]{24})/)?.[1])
        .filter((s): s is string => !!s),
    );

    // Sort=latest first (newest), then sort=popular to fill remainder.
    const rawCandidates: SearchHit[] = [];
    for (const sort of ['latest', 'popular'] as const) {
      for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
        const hits = await xhsSearch(queryName, page, sort);
        for (const hit of hits) {
          if (seenNoteIds.has(hit.noteId)) continue;
          if (rawCandidates.find((c) => c.noteId === hit.noteId)) continue;
          rawCandidates.push(hit);
        }
        if (hits.length === 0) break;
      }
      if (rawCandidates.length >= need * 4) break;
    }

    // Pre-filter on displayTitle: prefer hits whose title contains the
    // restaurant name. Cuts the expensive readNote + LLM cost on irrelevant
    // search noise. If no hits pass the strict filter, fall back to
    // likes-sorted (better than scanning random Japanese-name noise).
    const queryNorm = normalize(queryName);
    const strict = rawCandidates.filter((h) =>
      h.displayTitle && normalize(h.displayTitle).includes(queryNorm)
    );
    const candidates = (strict.length >= need ? strict : rawCandidates)
      .sort((a, b) => b.likes - a.likes)
      .slice(0, Math.max(need * 4, 12)); // hard cap per restaurant
    console.log(`  · ${rawCandidates.length} raw → ${candidates.length} candidates (strict=${strict.length})`);

    let added = 0;
    let consecutiveReadFails = 0;
    for (const hit of candidates) {
      if (added >= need) break;
      // Bail early on long failure runs (XHS likely throttling this query).
      if (consecutiveReadFails >= 8) { bump('bailed_after_consecutive_fails'); break; }
      const note = await readNoteFast(hit.noteId, hit.xsecToken, READNOTE_TIMEOUT_MS);
      await sleep(READNOTE_DELAY_MS);
      if (!note) { bump('read_fail'); consecutiveReadFails++; continue; }
      consecutiveReadFails = 0;

      const time = note.time ?? 0;
      const ageDays = time ? (Date.now() - time) / (1000 * 60 * 60 * 24) : 9999;
      if (ageDays > 365) { bump('too_old'); continue; }
      const body = note.desc ?? '';
      const title = note.title ?? '';
      if (body.length < 30) { bump('too_short'); continue; }

      const haystack = normalize(title + ' ' + body);
      const names = [resto.restaurant_name, resto.google_display_name].filter((n): n is string => !!n);
      const matched = names.some((n) => normalize(n).length >= 3 && haystack.includes(normalize(n)));
      if (!matched) { bump('name_not_found'); continue; }
      if (!nyclike(title + ' ' + body, resto)) { bump('not_nyc'); continue; }

      // Sentiment gate — drop on any complaint.
      const verdict = await classifyComplaint({ title, body, restaurantName: resto.restaurant_name });
      if (verdict.hasComplaint) {
        bump('negative_dropped');
        totalDroppedNeg++;
        console.log(`    × negative ${hit.noteId} (${verdict.reason})`);
        continue;
      }

      const postUrl = `https://www.xiaohongshu.com/explore/${hit.noteId}`;
      const likes = note.likes || hit.likes;
      const createdAt = time ? new Date(time).toISOString() : null;

      if (!DRY_RUN) {
        insert.run(randomUUID(), resto.id, postUrl, body, likes, createdAt);
      }
      added++;
      totalAdded++;
      console.log(`    ✓ added ${hit.noteId} likes=${likes} age=${Math.round(ageDays)}d`);
    }
    if (added < need) {
      console.log(`    · ${added}/${need} added`);
    }
  }

  console.log(`\n[topup-asian] done — added ${totalAdded}, dropped ${totalDroppedNeg} negative posts`);
  if (reasons.size) {
    console.log('\nskip reasons:');
    [...reasons.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
      console.log(`  ${String(v).padStart(4)}  ${k}`);
    });
  }
  db.close();
})();
