/**
 * XHS-BROWSER-1 probe — can a real, logged-in browser give us the posts the
 * pipeline needs, without the reverse-engineered `xhs` CLI?
 *
 *   npx ts-node -T scripts/xhs-browser-probe.ts
 *
 * What it does:
 *   1. Opens a visible Chrome window on a dedicated, persistent profile
 *      (~/.wheretoeat/xhs-browser-profile). First run: scan the QR code with
 *      the Xiaohongshu / RedNote app. Later runs reuse the saved login.
 *   2. Searches each keyword and records the JSON the page itself fetches
 *      (`/api/sns/web/v1/search/notes`). The page signs its own requests, so
 *      no x-s / x-t signing is needed on our side.
 *   3. Tries to switch the search sort to "latest", scrolls once for page 2.
 *   4. Opens the first few notes and reads the note detail (feed API response
 *      or SSR `__INITIAL_STATE__`).
 *   5. Prints a summary and writes every raw payload to data/xhs-raw/probe-<ts>/.
 *
 * Env knobs:
 *   XHS_BASE_URL   default https://www.rednote.com (try https://www.xiaohongshu.com)
 *   KEYWORDS       comma-separated, default "纽约美食,纽约新店"
 *   READ_NOTES     notes to open per keyword, default 3
 *   CHANNEL        'chrome' (installed Google Chrome, default) or 'chromium'
 *   LOGIN_TIMEOUT_S default 300
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, type BrowserContext, type Page, type Response } from 'playwright';

const BASE = (process.env.XHS_BASE_URL ?? 'https://www.rednote.com').replace(/\/$/, '');
const KEYWORDS = (process.env.KEYWORDS ?? '纽约美食,纽约新店').split(',').map((s) => s.trim()).filter(Boolean);
const READ_NOTES = Number(process.env.READ_NOTES ?? 3);
const CHANNEL = process.env.CHANNEL ?? 'chrome';
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_S ?? 300) * 1000;
const PROFILE_DIR = path.join(os.homedir(), '.wheretoeat', 'xhs-browser-profile');
const OUT_DIR = path.resolve(__dirname, '../data/xhs-raw', `probe-${new Date().toISOString().replace(/[:.]/g, '-')}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => sleep(min + Math.random() * (max - min));

// ─── response capture ────────────────────────────────────────────────────

interface Captured { url: string; path: string; status: number; requestBody: unknown; json: unknown; at: number }
const captured: Captured[] = [];
const apiPathsSeen = new Map<string, number>();
let me: { guest?: boolean; nickname?: string; user_id?: string } | null = null;
let meRaw: unknown = null;

function save(name: string, data: unknown) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(data, null, 2));
}

async function onResponse(res: Response) {
  const url = res.url();
  if (!/\/api\/sns\//.test(url)) return;
  const p = new URL(url).pathname;
  apiPathsSeen.set(p, (apiPathsSeen.get(p) ?? 0) + 1);
  let json: unknown = null;
  try { json = await res.json(); } catch { return; }
  let requestBody: unknown = null;
  try { const raw = res.request().postData(); requestBody = raw ? JSON.parse(raw) : null; } catch { /* non-JSON body */ }
  captured.push({ url, path: p, status: res.status(), requestBody, json, at: Date.now() });

  if (/\/user\/me$/.test(p)) {
    meRaw = json;
    const d = (json as { data?: Record<string, unknown> })?.data ?? {};
    me = { guest: d.guest as boolean | undefined, nickname: d.nickname as string | undefined, user_id: d.user_id as string | undefined };
  }
}

const isLoggedIn = () => !!me && me.guest === false;

// ─── steps ───────────────────────────────────────────────────────────────

async function launch(): Promise<BrowserContext> {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const opts = {
    headless: false,
    viewport: { width: 1280, height: 860 },
    locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, ...(CHANNEL === 'chrome' ? { channel: 'chrome' } : {}) });
  } catch (e) {
    if (CHANNEL !== 'chrome') throw e;
    console.warn(`! Could not launch installed Chrome (${String(e).split('\n')[0]}); falling back to bundled Chromium`);
    return await chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
}

async function ensureLogin(page: Page) {
  await page.goto(`${BASE}/explore`, { waitUntil: 'domcontentloaded' });
  await jitter(3000, 4500);
  console.log(`  landed on: ${page.url()}`);
  if (isLoggedIn()) { console.log(`✓ Already logged in as ${me?.nickname ?? me?.user_id}`); return; }

  console.log('\n>>> Not logged in. Scan the QR code in the browser window with the Xiaohongshu / RedNote app.');
  console.log(`>>> Waiting up to ${LOGIN_TIMEOUT_MS / 1000}s… (the page is NOT reloaded while you scan)\n`);
  console.log(`  /user/me shape (guest): ${JSON.stringify(meRaw).slice(0, 300)}`);
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  // A logged-in rednote profile carries an `id_token` cookie; guests don't.
  const hasIdToken = async () => (await page.context().cookies()).some((c) => c.name === 'id_token' && !!c.value);
  while (Date.now() < deadline) {
    await sleep(3000);
    if (isLoggedIn()) break;
    if (await hasIdToken()) {
      console.log('  id_token cookie appeared — reloading once to confirm via /user/me');
      await sleep(2000);
      await page.goto(`${BASE}/explore`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(4000);
      break;
    }
  }
  console.log(`  /user/me shape (after): ${JSON.stringify(meRaw).slice(0, 300)}`);
  if (!isLoggedIn() && !(await hasIdToken())) throw new Error('Login not detected before timeout (no non-guest /user/me and no id_token cookie).');
  console.log(`✓ Logged in as ${me?.nickname ?? me?.user_id ?? '(id_token present; /user/me shape unknown)'}`);
}

interface SearchItem { id?: string; xsec_token?: string; model_type?: string; note_card?: Record<string, unknown> }

function searchItemsSince(t0: number): { items: SearchItem[]; sorts: string[] } {
  const items: SearchItem[] = [];
  const sorts: string[] = [];
  for (const c of captured) {
    if (c.at < t0 || !/\/search\/notes$/.test(c.path)) continue;
    const body = c.requestBody as { sort?: string } | null;
    if (body?.sort) sorts.push(body.sort);
    const arr = (c.json as { data?: { items?: SearchItem[] } })?.data?.items ?? [];
    items.push(...arr);
  }
  return { items, sorts };
}

async function trySortLatest(page: Page): Promise<boolean> {
  // The filter panel opens on hover/click of "筛选"; "最新" sets sort=time_descending.
  try {
    const filter = page.getByText('筛选', { exact: true }).first();
    if (await filter.isVisible({ timeout: 3000 })) { await filter.hover(); await sleep(800); await filter.click().catch(() => {}); await sleep(800); }
    const latest = page.getByText('最新', { exact: true }).first();
    if (await latest.isVisible({ timeout: 3000 })) { await latest.click(); await jitter(2500, 4000); return true; }
  } catch { /* fall through */ }
  return false;
}

interface NoteSummary {
  id: string; title: string; descLen: number; descPreview: string; time: string | null;
  ipLocation: string | null; tags: number; images: number; liked: unknown; collected: unknown; comments: unknown; via: string;
}

const arrLen = (v: unknown) => (Array.isArray(v) ? v.length : 0);

function summarizeNote(id: string, n: Record<string, unknown>, via: string): NoteSummary {
  const ii = (n.interact_info ?? n.interactInfo ?? {}) as Record<string, unknown>;
  const desc = String(n.desc ?? '');
  const time = typeof n.time === 'number' ? new Date(n.time).toISOString() : null;
  return {
    id, via,
    title: String(n.title ?? n.display_title ?? ''),
    descLen: desc.length,
    descPreview: desc.replace(/\s+/g, ' ').slice(0, 80),
    time,
    ipLocation: (n.ip_location ?? n.ipLocation ?? null) as string | null,
    tags: arrLen(n.tag_list ?? n.tagList),
    images: arrLen(n.image_list ?? n.imageList),
    liked: ii.liked_count ?? ii.likedCount,
    collected: ii.collected_count ?? ii.collectedCount,
    comments: ii.comment_count ?? ii.commentCount,
  };
}

async function readNote(page: Page, item: SearchItem): Promise<NoteSummary | null> {
  const id = item.id!;
  const t0 = Date.now();
  const url = `${BASE}/explore/${id}?xsec_token=${encodeURIComponent(item.xsec_token ?? '')}&xsec_source=pc_search`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await jitter(3000, 5000);

  // 1) feed API response (client-side fetch)
  for (const c of captured) {
    if (c.at < t0 || !/\/feed$/.test(c.path)) continue;
    const card = (c.json as { data?: { items?: Array<{ id?: string; note_card?: Record<string, unknown> }> } })?.data?.items?.find((x) => x.id === id)?.note_card;
    if (card) { save(`note-${id}.json`, card); return summarizeNote(id, card, 'feed-api'); }
  }
  // 2) SSR state
  const ssr = await page.evaluate((noteId) => {
    try {
      const st = (globalThis as unknown as { __INITIAL_STATE__?: { note?: { noteDetailMap?: Record<string, { note?: unknown }> } } }).__INITIAL_STATE__;
      const entry = st?.note?.noteDetailMap?.[noteId];
      return entry?.note ? JSON.parse(JSON.stringify(entry.note)) : null;
    } catch { return null; }
  }, id);
  if (ssr) { save(`note-${id}.json`, ssr); return summarizeNote(id, ssr as Record<string, unknown>, 'ssr-state'); }
  console.log(`    ! note ${id}: no detail (landed on ${page.url()})`);
  return null;
}

async function main() {
  console.log(`=== XHS browser probe ===\nbase=${BASE} keywords=${KEYWORDS.join(' | ')} profile=${PROFILE_DIR}\n`);
  const ctx = await launch();
  ctx.on('response', (r) => { void onResponse(r); });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  const report: Record<string, unknown> = { base: BASE, startedAt: new Date().toISOString() };

  try {
    await ensureLogin(page);
    report.user = me;

    for (const kw of KEYWORDS) {
      console.log(`\n── keyword: ${kw}`);
      const t0 = Date.now();
      await page.goto(`${BASE}/search_result?keyword=${encodeURIComponent(kw)}&source=web_search_result_notes&type=51`, { waitUntil: 'domcontentloaded' });
      await jitter(4000, 6000);
      const def = searchItemsSince(t0);
      console.log(`  default sort: ${def.items.length} items, request sort=${def.sorts.join(',') || '(none seen)'}`);

      const t1 = Date.now();
      const switched = await trySortLatest(page);
      const latest = searchItemsSince(t1);
      console.log(`  "最新" switch ${switched ? 'clicked' : 'NOT found'}: ${latest.items.length} items, request sort=${latest.sorts.join(',') || '(none seen)'}`);

      const t2 = Date.now();
      await page.mouse.wheel(0, 4000); await jitter(3000, 4500);
      const more = searchItemsSince(t2);
      console.log(`  after scroll: +${more.items.length} items (pagination ${more.items.length ? 'works' : 'not triggered'})`);

      const pool = (latest.items.length ? [...latest.items, ...more.items] : [...def.items, ...more.items])
        .filter((i) => i.id && (i.model_type ?? 'note') === 'note' && i.note_card);
      save(`search-${kw}.json`, { default: def, latest, more });

      console.log('  sample titles:');
      for (const i of pool.slice(0, 12)) {
        const nc = i.note_card as { display_title?: string; interact_info?: { liked_count?: string } };
        console.log(`    · ${(nc.display_title ?? '').slice(0, 50)}  ❤${nc.interact_info?.liked_count ?? '?'}  token=${i.xsec_token ? 'y' : 'n'}`);
      }

      const notes: NoteSummary[] = [];
      for (const item of pool.slice(0, READ_NOTES)) {
        const s = await readNote(page, item);
        if (s) {
          notes.push(s);
          console.log(`    ▸ [${s.via}] ${s.title.slice(0, 40)} | ${s.time?.slice(0, 10) ?? 'no-time'} | ip=${s.ipLocation ?? '-'} | desc=${s.descLen}ch | tags=${s.tags} imgs=${s.images} | ❤${s.liked} ★${s.collected} 💬${s.comments}`);
          console.log(`      "${s.descPreview}"`);
        }
        await jitter(2500, 4500);
      }
      report[kw] = { defaultCount: def.items.length, defaultSorts: def.sorts, latestSwitched: switched, latestCount: latest.items.length, latestSorts: latest.sorts, scrollCount: more.items.length, notesRead: notes };
    }
  } catch (e) {
    console.error(`\n✗ ${String(e)}`);
    report.error = String(e);
  } finally {
    report.apiPathsSeen = Object.fromEntries(apiPathsSeen);
    save('report.json', report);
    console.log(`\nAPI paths seen: ${[...apiPathsSeen.keys()].join(', ') || '(none)'}`);
    console.log(`Raw captures → ${OUT_DIR}`);
    await ctx.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
