import { execFile } from 'child_process';
import { promisify } from 'util';
import * as yaml from 'js-yaml';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface RawXhsPost {
  noteId: string;
  title: string;
  body: string;
  likes: number;
  postUrl: string;
  createdAt: string; // ISO date string
}

interface XhsSearchItem {
  id: string;
  xsec_token?: string;
  note_card?: {
    display_title?: string;
    interact_info?: {
      liked_count?: string;
    };
  };
  // corner_tag_info may contain publish_time
  corner_tag_info?: Array<{ type?: string; text?: string }>;
}

interface XhsReadItem {
  id: string;
  note_card?: {
    title?: string;
    desc?: string;
    time?: number; // Unix ms
    interact_info?: {
      liked_count?: string;
    };
  };
}

// CLI v0.6+ returns a flat structure instead of items[].note_card
interface XhsReadFlat {
  title?: string;
  desc?: string;
  time?: number;
  noteId?: string;
  interactInfo?: {
    likedCount?: string | number;
    liked_count?: string;
  };
}

function parseLikeCount(raw: string | undefined): number {
  if (!raw) return 0;
  const s = raw.trim();
  if (s.includes('万')) return Math.round(parseFloat(s) * 10000);
  return parseInt(s, 10) || 0;
}

async function runXhs(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('xhs', args, {
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024, // 10MB
  });
  return stdout;
}

async function searchPage(hashtag: string, page: number): Promise<XhsSearchItem[]> {
  // Env-branched, mirroring readNote: HTTP-first on Vercel where the CLI is
  // absent, CLI-first locally where it's the more reliable path.
  const onVercel = process.env.VERCEL === '1';

  if (onVercel) {
    const http = await searchViaHttp(hashtag, page);
    if (http.length) return http;
    // Fallback — if HTTP returned nothing, try the CLI (it'll ENOENT on
    // Vercel but we keep the shape for parity with local behavior).
    return await searchViaCli(hashtag, page);
  }

  const cli = await searchViaCli(hashtag, page);
  if (cli.length) return cli;
  return await searchViaHttp(hashtag, page);
}

async function searchViaCli(hashtag: string, page: number): Promise<XhsSearchItem[]> {
  try {
    const raw = await runXhs(['search', hashtag, '--sort', 'popular', '--page', String(page)]);
    const parsed = yaml.load(raw) as { data?: { items?: XhsSearchItem[] } };
    return parsed?.data?.items ?? [];
  } catch (e) {
    const msg = String(e);
    if (!msg.includes('ENOENT') && !msg.includes('not found')) {
      logger.warn('xhs.search.cli.failed', { hashtag, page, error: msg });
    }
    return [];
  }
}

const XHS_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Compose the `Cookie` header from env vars holding a signed-in browser's
 * XHS session. Returns '' when no cookies are set — the caller should send
 * anonymous in that case (which works for share-link URLs that already
 * carry an `xsec_token` but generally fails for broad search).
 *
 * Extraction:
 *   DevTools → Application → Cookies → https://www.xiaohongshu.com
 *   XHS_WEB_SESSION  ← `web_session`   (mandatory)
 *   XHS_A1           ← `a1`            (device fingerprint; XHS gates some
 *                                       endpoints on its presence)
 *   XHS_WEBID        ← `webId`         (same)
 *
 * Put these in Vercel env vars (`vercel env add XHS_WEB_SESSION`, etc.) so
 * the deployed pipeline can run without the local `xhs` CLI.
 */
export function buildXhsCookieHeader(): string {
  const parts: string[] = [];
  const webSession = process.env.XHS_WEB_SESSION;
  const a1 = process.env.XHS_A1;
  const webId = process.env.XHS_WEBID;
  if (webSession) parts.push(`web_session=${webSession}`);
  if (a1) parts.push(`a1=${a1}`);
  if (webId) parts.push(`webId=${webId}`);
  return parts.join('; ');
}

/**
 * Server-side reader that does NOT rely on the `xhs` CLI.
 *
 * XHS's `/explore/<noteId>` page is SSR'd and embeds the full post object
 * inside a `window.__INITIAL_STATE__ = {...}` script tag. Fetching the page
 * with a browser-ish User-Agent + the note's `xsec_token` is enough to get
 * the state JSON — no login, no captcha, no CLI required. This works from
 * Vercel functions where the CLI isn't installed.
 *
 * Returns null if the page doesn't render the expected state (e.g. XHS
 * gates the post behind a sign-in wall, or the HTML shape changes). The
 * caller should then fall back to the CLI path when running locally.
 */
export async function readNoteViaHttp(noteId: string, xsecToken?: string): Promise<XhsReadItem | null> {
  const url = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);
  if (xsecToken) {
    url.searchParams.set('xsec_token', xsecToken);
    url.searchParams.set('xsec_source', 'pc_feed');
  }

  const cookie = buildXhsCookieHeader();
  const baseHeaders: Record<string, string> = {
    'User-Agent': XHS_BROWSER_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
  };
  if (cookie) baseHeaders['Cookie'] = cookie;

  let html: string;
  try {
    const response = await fetch(url.toString(), {
      redirect: 'follow',
      headers: baseHeaders,
    });
    if (!response.ok) {
      logger.warn('xhs.http.read.http_error', { noteId, status: response.status });
      return null;
    }
    html = await response.text();
  } catch (e) {
    logger.warn('xhs.http.read.fetch_failed', { noteId, error: String(e) });
    return null;
  }

  // Extract window.__INITIAL_STATE__ = {...}; — XHS ends the assignment with
  // `</script>` closing the surrounding tag, so match up to that.
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]+?)<\/script>/);
  if (!stateMatch) {
    logger.warn('xhs.http.read.no_state', { noteId, htmlLen: html.length });
    return null;
  }

  let state: Record<string, unknown>;
  try {
    // Trim trailing `;` / whitespace. XHS sometimes emits `undefined` literals
    // which break strict JSON.parse — swap them for null first.
    const rawJson = stateMatch[1].trim().replace(/;$/, '');
    const sanitized = rawJson.replace(/:\s*undefined\b/g, ': null');
    state = JSON.parse(sanitized);
  } catch (e) {
    logger.warn('xhs.http.read.parse_failed', { noteId, error: String(e) });
    return null;
  }

  // The note lives at state.note.noteDetailMap[noteId].note — defensive walk
  // in case XHS shuffles the path.
  const noteData = findNote(state, noteId);
  if (!noteData) {
    logger.warn('xhs.http.read.note_not_found_in_state', { noteId });
    return null;
  }

  const rec = noteData as Record<string, unknown>;
  const title = typeof rec.title === 'string' ? rec.title : '';
  const desc = typeof rec.desc === 'string' ? rec.desc : '';
  const time = typeof rec.time === 'number' ? rec.time : undefined;

  // Likes live at interactInfo.likedCount (camelCase in SSR payload).
  const interact = rec.interactInfo as { likedCount?: string | number } | undefined;
  const likedRaw = interact?.likedCount;

  if (!title && !desc) return null;

  return {
    id: noteId,
    note_card: {
      title,
      desc,
      time,
      interact_info: {
        liked_count: String(likedRaw ?? '0'),
      },
    },
  };
}

/** Walk the SSR state looking for the noteDetailMap entry for this note. */
function findNote(state: Record<string, unknown>, noteId: string): Record<string, unknown> | null {
  // Common path first.
  const noteSection = state.note as Record<string, unknown> | undefined;
  const detailMap = noteSection?.noteDetailMap as Record<string, unknown> | undefined;
  const entry = detailMap?.[noteId] as Record<string, unknown> | undefined;
  const inner = entry?.note as Record<string, unknown> | undefined;
  if (inner && (inner.title || inner.desc)) return inner;

  // Fallback: breadth-first walk, capped to avoid pathological payloads.
  const queue: unknown[] = [state];
  const seen = new Set<unknown>();
  let steps = 0;
  while (queue.length && steps++ < 10000) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    if (typeof rec.noteId === 'string' && rec.noteId === noteId && (rec.title || rec.desc)) {
      return rec;
    }
    for (const v of Object.values(rec)) {
      if (v && typeof v === 'object') queue.push(v);
    }
  }
  return null;
}

/**
 * HTTP replacement for `xhs search <hashtag> --page N`. Fetches XHS's own
 * search-result page and parses the SSR `__INITIAL_STATE__` blob the
 * front-end hydrates from. Works on Vercel where the CLI can't run.
 *
 * Auth: anonymous requests are heavily gated by XHS; populate the
 * XHS_WEB_SESSION / XHS_A1 / XHS_WEBID env vars with a signed-in browser's
 * cookies (see `buildXhsCookieHeader` for the extraction recipe). Without
 * them this reliably returns an empty list.
 *
 * Returns items in the same `XhsSearchItem` shape the CLI produces so
 * downstream `searchXhsPosts` doesn't need to branch.
 */
export async function searchViaHttp(hashtag: string, page: number): Promise<XhsSearchItem[]> {
  // `type=51` restricts to the notes tab (vs users/boards). `sort=popularity`
  // mirrors the CLI's `--sort popular`.
  const url = new URL('https://www.xiaohongshu.com/search_result');
  url.searchParams.set('keyword', hashtag);
  url.searchParams.set('type', '51');
  url.searchParams.set('sort', 'popularity_descending');
  url.searchParams.set('page', String(page));

  const cookie = buildXhsCookieHeader();
  const headers: Record<string, string> = {
    'User-Agent': XHS_BROWSER_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.xiaohongshu.com/',
    'Cache-Control': 'no-cache',
  };
  if (cookie) headers['Cookie'] = cookie;

  let html: string;
  try {
    const response = await fetch(url.toString(), { redirect: 'follow', headers });
    if (!response.ok) {
      logger.warn('xhs.http.search.http_error', { hashtag, page, status: response.status });
      return [];
    }
    html = await response.text();
  } catch (e) {
    logger.warn('xhs.http.search.fetch_failed', { hashtag, page, error: String(e) });
    return [];
  }

  const state = extractInitialState(html);
  if (!state) {
    logger.warn('xhs.http.search.no_state', { hashtag, page, htmlLen: html.length, hasCookie: !!cookie });
    return fallbackNoteIdsFromHtml(html);
  }

  return parseSearchNotesFromState(state);
}

/** Extract + sanitize the `window.__INITIAL_STATE__` JSON blob from SSR HTML. */
function extractInitialState(html: string): Record<string, unknown> | null {
  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]+?)<\/script>/);
  if (!m) return null;
  try {
    const raw = m[1].trim().replace(/;$/, '');
    // XHS SSR emits bare `undefined` literals and occasionally `NaN` — both
    // break JSON.parse.
    const sanitized = raw.replace(/:\s*undefined\b/g, ': null').replace(/:\s*NaN\b/g, ': null');
    return JSON.parse(sanitized) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Walk the SSR state looking for search-result note items. XHS shuffles the
 * exact path between releases, so we do a BFS and collect anything that
 * looks like a note (has a 24-hex id + either display_title or note_card).
 */
function parseSearchNotesFromState(state: Record<string, unknown>): XhsSearchItem[] {
  const found: XhsSearchItem[] = [];
  const seen = new Set<string>();
  const queue: unknown[] = [state];
  const visited = new Set<unknown>();
  let steps = 0;

  while (queue.length && steps++ < 20000) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || visited.has(node)) continue;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const v of node) queue.push(v);
      continue;
    }

    const rec = node as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : (typeof rec.noteId === 'string' ? rec.noteId : null);
    const noteCard = rec.note_card as Record<string, unknown> | undefined
                  ?? rec.noteCard as Record<string, unknown> | undefined;

    const looksLikeNote =
      id &&
      /^[a-f0-9]{24}$/.test(id) &&
      (noteCard || typeof rec.display_title === 'string' || typeof rec.displayTitle === 'string');

    if (looksLikeNote && !seen.has(id!)) {
      seen.add(id!);
      const xsecToken = typeof rec.xsec_token === 'string' ? rec.xsec_token
                      : typeof rec.xsecToken === 'string' ? rec.xsecToken : undefined;
      const interact = (noteCard?.interact_info ?? noteCard?.interactInfo) as Record<string, unknown> | undefined;
      const likedRaw = interact?.liked_count ?? interact?.likedCount;
      const displayTitle =
        (noteCard?.display_title as string | undefined) ??
        (noteCard?.displayTitle as string | undefined) ??
        (rec.display_title as string | undefined) ??
        (rec.displayTitle as string | undefined);

      found.push({
        id: id!,
        xsec_token: xsecToken,
        note_card: {
          display_title: displayTitle,
          interact_info: { liked_count: likedRaw != null ? String(likedRaw) : undefined },
        },
      });
    }

    for (const v of Object.values(rec)) {
      if (v && typeof v === 'object') queue.push(v);
    }
  }

  return found;
}

/**
 * Last-resort fallback when SSR state is missing (page rendered as login
 * wall, for instance). Pulls bare 24-hex note IDs out of the HTML so we at
 * least have IDs to feed into `readNote`. No xsec_token available here —
 * those notes will only read successfully if cookie auth is configured.
 */
function fallbackNoteIdsFromHtml(html: string): XhsSearchItem[] {
  const ids = new Set<string>();
  const re = /"(?:noteId|id)":"([a-f0-9]{24})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return Array.from(ids).map((id) => ({ id }));
}

/** Local CLI path — requires `xhs` installed + authenticated on the host. */
async function readNoteViaCli(noteId: string, xsecToken?: string): Promise<XhsReadItem | null> {
  try {
    const args = ['read', noteId];
    if (xsecToken) args.push('--xsec-token', xsecToken);
    const raw = await runXhs(args);
    const parsed = yaml.load(raw) as { ok?: boolean; data?: Record<string, unknown> };
    const data = parsed?.data;
    if (!data) return null;

    // Old format: data.items[0].note_card.{title, desc, time, interact_info}
    const items = data.items as XhsReadItem[] | undefined;
    if (items?.[0]?.note_card) {
      return items[0];
    }

    // New format (CLI v0.6+): data.{title, desc, time, interactInfo} — flat structure
    const flat = data as unknown as XhsReadFlat;
    if (flat.title || flat.desc) {
      const likedRaw = flat.interactInfo?.likedCount ?? flat.interactInfo?.liked_count;
      return {
        id: flat.noteId ?? noteId,
        note_card: {
          title: flat.title,
          desc: flat.desc,
          time: flat.time,
          interact_info: {
            liked_count: String(likedRaw ?? '0'),
          },
        },
      };
    }

    return null;
  } catch (e) {
    const msg = String(e);
    // ENOENT = CLI not installed. On Vercel this would spam every request;
    // the caller picks the HTTP path there so we shouldn't be here anyway.
    if (!msg.includes('ENOENT') && !msg.includes('not found')) {
      logger.warn('xhs.read.cli.failed', { noteId, error: msg });
    }
    return null;
  }
}

const ON_VERCEL = process.env.VERCEL === '1';

/**
 * Read an XHS post. Two backends:
 *
 *   - CLI (`xhs read <noteId>`) — used locally. Authenticated, reliable,
 *     survives XHS anti-bot changes.
 *   - HTTP (`GET xiaohongshu.com/explore/<noteId>`) — used on Vercel where
 *     the CLI can't be installed. Scrapes the SSR `__INITIAL_STATE__` blob.
 *
 * Per-env preference, with a single cross-env fallback so a transient
 * failure on one path still has a shot at the other.
 */
export async function readNote(noteId: string, xsecToken?: string): Promise<XhsReadItem | null> {
  if (ON_VERCEL) {
    const viaHttp = await readNoteViaHttp(noteId, xsecToken);
    if (viaHttp) return viaHttp;
    return await readNoteViaCli(noteId, xsecToken);
  }
  const viaCli = await readNoteViaCli(noteId, xsecToken);
  if (viaCli) return viaCli;
  return await readNoteViaHttp(noteId, xsecToken);
}

export async function searchXhsPosts(
  hashtag: string,
  maxPages = 10,
  maxAgeMs: number = ONE_YEAR_MS
): Promise<RawXhsPost[]> {
  const now = Date.now();
  const cutoff = now - maxAgeMs;

  // Step 1: collect note IDs + xsec_tokens + search metadata from search pages
  const searchItems: Array<{ id: string; xsecToken?: string; item: XhsSearchItem }> = [];
  const seenIds = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    try {
      const items = await searchPage(hashtag, page);
      if (!items.length) break;
      for (const item of items) {
        if (item.id && !seenIds.has(item.id)) {
          seenIds.add(item.id);
          searchItems.push({ id: item.id, xsecToken: item.xsec_token, item });
        }
      }
      logger.success('xhs.search.page', { page, found: items.length, total: searchItems.length });
      // Small delay between pages to be polite
      await sleep(500);
    } catch (e) {
      logger.warn('xhs.search.page.failed', { page, error: String(e) });
      break;
    }
  }

  logger.success('xhs.search.collected', { hashtag, totalIds: searchItems.length });

  // Step 2: read each note for full body + timestamp; fall back to search data if read fails
  const results: RawXhsPost[] = [];
  for (const { id: noteId, xsecToken, item: searchItem } of searchItems) {
    const note = await readNote(noteId, xsecToken);
    const postUrl = `https://www.xiaohongshu.com/explore/${noteId}`;

    if (note?.note_card) {
      const { title = '', desc = '', time, interact_info } = note.note_card;

      // Filter by age
      if (time && time < cutoff) {
        logger.success('xhs.note.skipped.old', { noteId, time });
        await sleep(300);
        continue;
      }

      const createdAt = time
        ? new Date(time).toISOString()
        : new Date().toISOString();

      results.push({
        noteId,
        title,
        body: desc,
        likes: parseLikeCount(interact_info?.liked_count),
        postUrl,
        createdAt,
      });
    } else if (searchItem.note_card?.display_title) {
      // Fallback: use search metadata (no body text, but title + likes are available)
      logger.success('xhs.note.fallback.search', { noteId });
      results.push({
        noteId,
        title: searchItem.note_card.display_title,
        body: '',
        likes: parseLikeCount(searchItem.note_card.interact_info?.liked_count),
        postUrl,
        createdAt: new Date().toISOString(),
      });
    }

    await sleep(300);
  }

  logger.success('xhs.search.complete', { hashtag, posts: results.length });
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
