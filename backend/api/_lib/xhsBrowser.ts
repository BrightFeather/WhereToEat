/**
 * Browser-driven XHS / RedNote source (XHS-BROWSER-2).
 *
 * Replaces the reverse-engineered `xhs` CLI for local pipeline runs: a real
 * Chrome on a persistent profile does the requests, so the site's own JS
 * handles signing (x-s / x-t), cookies, and the xiaohongshu → rednote redirect.
 * We only read the JSON the page fetches (`/api/sns/web/v1/search/notes`) and
 * the SSR `__INITIAL_STATE__` on note pages.
 *
 * LOCAL ONLY — needs a desktop Chrome and a one-time QR login. Never import
 * this from a deployed `api/*` route.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright';

export const XHS_BASE_URL = (process.env.XHS_BASE_URL ?? 'https://www.rednote.com').replace(/\/$/, '');
export const XHS_PROFILE_DIR = process.env.XHS_PROFILE_DIR ?? path.join(os.homedir(), '.wheretoeat', 'xhs-browser-profile');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const jitter = (min: number, max: number) => sleep(min + Math.random() * (max - min));

export function parseCount(raw: unknown): number {
  if (raw == null) return 0;
  // rednote's English UI formats note counts with thousands separators ("6,809").
  const s = String(raw).trim().replace(/,/g, '');
  if (!s) return 0;
  const n = parseFloat(s);
  if (Number.isNaN(n)) return 0;
  if (s.includes('万') || /w$/i.test(s)) return Math.round(n * 10_000);
  if (/k$/i.test(s)) return Math.round(n * 1_000);
  return Math.round(n);
}

/**
 * Parse the search card's `corner_tag_info` publish_time text into a Date.
 * Seen formats: "刚刚", "5分钟前", "3小时前", "昨天 12:30", "3天前", "11-12" (this year), "2025-05-03".
 */
export function parsePublishTime(text: string | undefined, now = new Date()): Date | null {
  if (!text) return null;
  const t = text.trim();
  let m: RegExpMatchArray | null;
  if (/刚刚/.test(t)) return now;
  if ((m = t.match(/(\d+)\s*分钟前/))) return new Date(now.getTime() - Number(m[1]) * 60_000);
  if ((m = t.match(/(\d+)\s*小时前/))) return new Date(now.getTime() - Number(m[1]) * 3_600_000);
  if (/昨天/.test(t)) return new Date(now.getTime() - 86_400_000);
  if ((m = t.match(/(\d+)\s*天前/))) return new Date(now.getTime() - Number(m[1]) * 86_400_000);
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if ((m = t.match(/^(\d{1,2})-(\d{1,2})/))) {
    const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (d.getTime() > now.getTime() + 86_400_000) d.setFullYear(d.getFullYear() - 1);
    return d;
  }
  return null;
}

export interface SearchCard {
  id: string;
  xsecToken: string;
  title: string;
  likes: number;
  collects: number;
  comments: number;
  author: string | null;
  publishText: string | null;
  publishedAt: string | null; // ISO, estimated from publishText
  keyword: string;
}

export interface NoteDetail {
  noteId: string;
  title: string;
  desc: string;
  time: number | null; // unix ms
  ipLocation: string | null;
  tags: string[];
  likes: number;
  collects: number;
  comments: number;
  author: string | null;
  raw: Record<string, unknown>;
}

interface Captured { path: string; requestBody: Record<string, unknown> | null; json: unknown; at: number }

/**
 * Long-lived Chrome the scripts attach to (start it once, keep it open):
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 \
 *     --user-data-dir="$HOME/.wheretoeat/xhs-browser-profile" --no-first-run
 */
export const XHS_CDP_URL = process.env.XHS_CDP_URL ?? 'http://127.0.0.1:9333';

export class XhsBrowser {
  private ctx!: BrowserContext;
  private browser: Browser | null = null; // set when attached over CDP
  page!: Page;
  private captured: Captured[] = [];
  me: { guest?: boolean; nickname?: string } | null = null;

  /** Attach to the long-lived Chrome at XHS_CDP_URL; launch a persistent one only if none is running. */
  async open(): Promise<void> {
    try {
      this.browser = await chromium.connectOverCDP(XHS_CDP_URL, { timeout: 5000 });
      this.ctx = this.browser.contexts()[0];
      this.page = await this.ctx.newPage(); // our own tab; closed on detach, browser stays up
      console.log(`  attached to running Chrome at ${XHS_CDP_URL}`);
    } catch {
      console.log(`  no Chrome at ${XHS_CDP_URL} — launching one on ${XHS_PROFILE_DIR}`);
      fs.mkdirSync(XHS_PROFILE_DIR, { recursive: true });
      this.ctx = await chromium.launchPersistentContext(XHS_PROFILE_DIR, {
        headless: false,
        channel: process.env.XHS_CHANNEL === 'chromium' ? undefined : 'chrome',
        viewport: { width: 1280, height: 860 },
        locale: 'zh-CN',
        args: ['--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
      });
      this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    }
    this.ctx.on('response', (r) => { void this.onResponse(r); });
  }

  /** Detach. Over CDP this closes only our tab and leaves the browser (and login) running. */
  async close(): Promise<void> {
    if (this.browser) {
      await this.page?.close().catch(() => {});
      await this.browser.close(); // disconnects; does not kill a CDP-attached browser's default context
    } else {
      await this.ctx?.close();
    }
  }

  private async onResponse(res: Response) {
    const url = res.url();
    if (!/\/api\/sns\//.test(url)) return;
    const p = new URL(url).pathname;
    if (!/\/search\/notes$|\/user\/me$/.test(p)) return;
    let json: unknown = null;
    try { json = await res.json(); } catch { return; }
    let requestBody: Record<string, unknown> | null = null;
    try { const raw = res.request().postData(); requestBody = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
    this.captured.push({ path: p, requestBody, json, at: Date.now() });
    if (p.endsWith('/user/me')) {
      const d = (json as { data?: { guest?: boolean; nickname?: string } })?.data;
      if (d) this.me = { guest: d.guest, nickname: d.nickname };
    }
  }

  /** Lands on /explore and waits (up to timeoutMs) for a non-guest session — scan the QR in the window. */
  async ensureLoggedIn(timeoutMs = 300_000): Promise<string> {
    await this.page.goto(`${XHS_BASE_URL}/explore`, { waitUntil: 'domcontentloaded' });
    await jitter(3000, 4500);
    const deadline = Date.now() + timeoutMs;
    let announced = false;
    while (!(this.me && this.me.guest === false)) {
      if (Date.now() > deadline) throw new Error('XHS login not detected — scan the QR code in the browser window');
      if (!announced) { console.log('>>> Not logged in — scan the QR code in the Chrome window with the RedNote / Xiaohongshu app.'); announced = true; }
      await sleep(3000);
      const cookies = await this.ctx.cookies();
      if (cookies.some((c) => c.name === 'id_token' && c.value) && !(this.me && this.me.guest === false)) {
        await sleep(2000);
        await this.page.goto(`${XHS_BASE_URL}/explore`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(4000);
      }
    }
    return this.me?.nickname ?? '(unknown)';
  }

  /** Pauses while a captcha / verify page is showing, so a human can solve it in the window. */
  async waitOutCaptcha(maxMs = 600_000): Promise<void> {
    const isBlocked = () => /captcha|verify|website-login\/error/i.test(this.page.url());
    if (!isBlocked()) return;
    console.log(`\n!!! Captcha / verification page (${this.page.url()}). Solve it in the Chrome window — waiting up to ${maxMs / 60000} min…`);
    const deadline = Date.now() + maxMs;
    while (isBlocked()) {
      if (Date.now() > deadline) throw new Error('Captcha not solved in time');
      await sleep(3000);
    }
    console.log('    captcha cleared, continuing');
  }

  private searchResponsesSince(t0: number) {
    return this.captured.filter((c) => c.at >= t0 && c.path.endsWith('/search/notes'));
  }

  /**
   * The filter panel opens on HOVER of `div.filter` ("筛选" / "Filter" depending on UI
   * language). Tag labels stay Chinese in both UIs.
   *
   * HONEYPOTS: every real tag has an invisible decoy twin placed first in the DOM
   * (`button-hp-installed`, `data-hp-kind`, `aria-hidden="true"`, opacity 1e-05,
   * z-index -1). Clicking a decoy likely flags the session as a bot — never
   * select tags by text alone. Real tags carry neither attribute.
   */
  private async clickFilterTag(label: string): Promise<void> {
    const tag = this.page
      .locator('.tag-container .tags:not([button-hp-installed]):not([aria-hidden="true"])')
      .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) })
      .first();
    if (!(await tag.isVisible().catch(() => false))) {
      await this.page.locator('div.filter').first().hover();
      await sleep(1200);
    }
    await tag.click({ timeout: 5000 });
    await jitter(2500, 3500);
  }

  /**
   * Search `keyword` sorted by most likes within the last 6 months, scrolling
   * until results drop below `minLikes`, `has_more` is false, or `maxScrolls`.
   * Throws if the sort/time filters could not be verified on the request.
   */
  async searchPopularRecent(keyword: string, opts: { minLikes: number; maxScrolls: number }): Promise<SearchCard[]> {
    await this.page.goto(
      `${XHS_BASE_URL}/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes&type=51`,
      { waitUntil: 'domcontentloaded' },
    );
    await jitter(4000, 6000);
    await this.waitOutCaptcha();

    await this.clickFilterTag('最多点赞');
    await this.clickFilterTag('半年内');

    const tFilters = Date.now() - 6000; // include the response triggered by the last click
    const filtered = this.searchResponsesSince(tFilters).filter((c) => {
      const body = JSON.stringify(c.requestBody ?? {});
      return body.includes('popularity_descending') && body.includes('半年内');
    });
    if (!filtered.length) {
      const last = this.searchResponsesSince(tFilters).at(-1)?.requestBody;
      throw new Error(`filters not applied for "${keyword}" — last request body: ${JSON.stringify(last).slice(0, 300)}`);
    }
    const tStart = filtered[0].at;

    const cards = new Map<string, SearchCard>();
    let stale = 0;
    for (let i = 0; i <= opts.maxScrolls; i++) {
      const before = cards.size;
      let hasMore = true;
      let minInBatch = Infinity;
      for (const c of this.searchResponsesSince(tStart)) {
        const body = JSON.stringify(c.requestBody ?? {});
        if (!body.includes('popularity_descending')) continue;
        const data = (c.json as { data?: { items?: unknown[]; has_more?: boolean } })?.data;
        if (data?.has_more === false) hasMore = false;
        for (const raw of (data?.items ?? []) as Array<Record<string, unknown>>) {
          if ((raw.model_type ?? 'note') !== 'note' || typeof raw.id !== 'string') continue;
          const nc = (raw.note_card ?? {}) as Record<string, unknown>;
          const ii = (nc.interact_info ?? {}) as Record<string, unknown>;
          const likes = parseCount(ii.liked_count);
          minInBatch = Math.min(minInBatch, likes);
          if (cards.has(raw.id)) continue;
          const corner = (nc.corner_tag_info as Array<{ type?: string; text?: string }> | undefined)?.find((x) => x.type === 'publish_time')?.text ?? null;
          const pub = parsePublishTime(corner ?? undefined);
          cards.set(raw.id, {
            id: raw.id,
            xsecToken: String(raw.xsec_token ?? ''),
            title: String(nc.display_title ?? ''),
            likes,
            collects: parseCount(ii.collected_count),
            comments: parseCount(ii.comment_count),
            author: ((nc.user as Record<string, unknown> | undefined)?.nickname as string | undefined) ?? null,
            publishText: corner,
            publishedAt: pub ? pub.toISOString() : null,
            keyword,
          });
        }
      }
      stale = cards.size === before ? stale + 1 : 0;
      if (!hasMore || minInBatch < opts.minLikes || stale >= 3) break;
      // Park the mouse over the feed first — after the filter hover it sits on the panel.
      await this.page.mouse.move(500 + Math.random() * 300, 600 + Math.random() * 150);
      await this.page.mouse.wheel(0, 3500 + Math.random() * 1500);
      await jitter(2500, 4000);
      await this.waitOutCaptcha();
    }
    return [...cards.values()].filter((c) => c.likes >= opts.minLikes);
  }

  /** Open a note page and read the SSR note object. Returns null if it can't be read. */
  async readNote(id: string, xsecToken: string): Promise<NoteDetail | null> {
    const url = `${XHS_BASE_URL}/explore/${id}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_search`;
    await this.page.goto(url, { waitUntil: 'commit' });
    await this.waitOutCaptcha();
    let note: Record<string, unknown> | null = null;
    try {
      await this.page.waitForFunction((noteId) => {
        const st = (globalThis as unknown as { __INITIAL_STATE__?: { note?: { noteDetailMap?: Record<string, { note?: { noteId?: string } }> } } }).__INITIAL_STATE__;
        return !!st?.note?.noteDetailMap?.[noteId]?.note?.noteId;
      }, id, { timeout: 15_000 });
      note = await this.page.evaluate((noteId) => {
        const st = (globalThis as unknown as { __INITIAL_STATE__?: { note?: { noteDetailMap?: Record<string, { note?: unknown }> } } }).__INITIAL_STATE__;
        return JSON.parse(JSON.stringify(st?.note?.noteDetailMap?.[noteId]?.note ?? null));
      }, id);
    } catch {
      await this.waitOutCaptcha();
      return null;
    }
    if (!note) return null;
    const ii = (note.interactInfo ?? {}) as Record<string, unknown>;
    const tags = Array.isArray(note.tagList) ? (note.tagList as Array<{ name?: string }>).map((t) => t.name ?? '').filter(Boolean) : [];
    return {
      noteId: id,
      title: String(note.title ?? ''),
      desc: String(note.desc ?? ''),
      time: typeof note.time === 'number' ? note.time : null,
      ipLocation: (note.ipLocation as string | undefined) ?? null,
      tags,
      likes: parseCount(ii.likedCount),
      collects: parseCount(ii.collectedCount),
      comments: parseCount(ii.commentCount),
      author: ((note.user as Record<string, unknown> | undefined)?.nickname as string | undefined) ?? null,
      raw: note,
    };
  }
}
