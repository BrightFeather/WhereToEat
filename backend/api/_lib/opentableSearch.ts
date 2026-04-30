/**
 * Browser-driven OpenTable search.
 *
 * OpenTable's /dapi/* endpoints are Akamai-protected and reject plain HTTP
 * clients with 503/403. The only reliable path is driving opentable.com's
 * own homepage autocomplete in a real browser and capturing the
 * `/dapi/fe/gql?opname=Autocomplete` response the page emits.
 *
 * Recipe lifted from restaurant-cli (../restaurant-cli/src/providers/opentable/browser.ts):
 * headed Chromium + persistent profile + mouse warmup + keyboard.type.
 *
 * Use `OpenTableSearcher` for multi-query runs — one browser, one page,
 * many searches. Do NOT call fresh `searchOnce` in a loop; each launch is
 * ~5s of warmup and OT rate-limits cold starts.
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import path from 'path';
import os from 'os';

export interface OTMatch {
  rid: string;
  name: string;
  neighborhood: string | null;
  metroName: string | null;
  /** Canonical profile URL — redirects to /r/<slug> on opentable.com. */
  profileUrl: string;
  /** Raw autocomplete item (kept for debugging). */
  raw: unknown;
}

interface AutocompleteItem {
  id?: string;
  type?: string;
  name?: string;
  metroName?: string | null;
  neighborhoodName?: string | null;
}

function parseAutocomplete(raw: unknown): AutocompleteItem[] {
  const r = raw as { data?: { autocomplete?: { autocompleteResults?: AutocompleteItem[] } } };
  const all = r?.data?.autocomplete?.autocompleteResults ?? [];
  return all.filter((x) => x.type === 'Restaurant');
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Strip chain/location suffixes & generic words that create false negatives.
// Keeps core brand tokens so "Dagg Thai Restaurant" ~ "Dagg Thai" and
// "Musaafer - New York" ~ "Musaafer".
const STOP_WORDS = new Set([
  'restaurant', 'restaurants', 'the', 'and', 'nyc', 'ny',
  'newyork', 'newyorkcity', 'manhattan', 'brooklyn', 'queens',
]);

function coreTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP_WORDS.has(t));
}

function normalizedCore(name: string): string {
  return coreTokens(name).join('');
}

/**
 * Rank matches against the target name; return the best or null.
 * When `cityHint` is provided, a metroName match breaks ties in favor of
 * that city (e.g. avoid picking LA "Carbone" when we want NYC).
 *
 * Matching is done on "core" tokens — generic words like "restaurant",
 * "the", "- New York" are stripped so that "Dagg Thai Restaurant" matches
 * "Dagg Thai" and "Musaafer - New York" matches "Musaafer".
 */
export function pickBestMatch(
  candidates: OTMatch[],
  targetName: string,
  cityHint?: string,
): OTMatch | null {
  const tFull = normalize(targetName);
  const tCore = normalizedCore(targetName);
  const tTokens = new Set(coreTokens(targetName));
  if (!tCore) return null;

  const cityNorm = cityHint ? normalize(cityHint) : '';
  // Exact metro match only: cityHint="New York" accepts "New York City" but
  // NOT "New York State" (which is what OT uses for upstate entries).
  const cityMatches = (m: OTMatch) => {
    if (!cityNorm || !m.metroName) return false;
    const mn = normalize(m.metroName);
    return mn === cityNorm || mn === cityNorm + 'city';
  };

  // When a city hint is provided, hard-filter to that metro. OT autocomplete
  // includes items from nearby metros (e.g. Red Bank NJ, Wilmington DE) and
  // those are almost always wrong for a city-specific backfill.
  const pool = cityNorm ? candidates.filter(cityMatches) : candidates;

  type Scored = { m: OTMatch; score: number };
  const scored: Scored[] = [];

  for (const c of pool) {
    const cFull = normalize(c.name);
    const cCore = normalizedCore(c.name);
    const cTokens = new Set(coreTokens(c.name));
    if (!cCore) continue;

    let score = 0;

    // Exact match on full or core form.
    if (cFull === tFull || cCore === tCore) score = 100;

    // One is substring of the other (core form). Require the first core
    // token of both to match — without this, "Katz's Delicatessen" matches
    // "Delicatessen" and "Fuku Omakase" matches "U Omakase".
    else if (cCore.includes(tCore) || tCore.includes(cCore)) {
      const tFirst = coreTokens(targetName)[0];
      const cFirst = coreTokens(c.name)[0];
      const firstTokenOk = !!tFirst && !!cFirst && (tFirst === cFirst || tFirst.startsWith(cFirst) || cFirst.startsWith(tFirst));
      const shorter = Math.min(cCore.length, tCore.length);
      const longer = Math.max(cCore.length, tCore.length);
      if (firstTokenOk && shorter >= 4 && shorter >= longer * 0.5) {
        score = 80 + Math.round(40 * (shorter / longer));
      }
    }

    // Token-overlap fallback (handles "Pecking House Chinatown" vs "Pecking House").
    if (score === 0 && tTokens.size > 0 && cTokens.size > 0) {
      const inter = [...tTokens].filter((t) => cTokens.has(t)).length;
      const overlap = inter / Math.min(tTokens.size, cTokens.size);
      if (overlap >= 0.8 && inter >= Math.min(2, tTokens.size)) {
        score = 60 + Math.round(20 * overlap);
      }
    }

    if (score === 0) continue;
    if (cityMatches(c)) score += 5; // break ties toward target city
    scored.push({ m: c, score });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].m;
}

function toMatch(item: AutocompleteItem): OTMatch | null {
  if (!item.id || !item.name) return null;
  // Autocomplete ids for restaurants are like "r-12345" or "12345".
  const rid = String(item.id).replace(/^r-?/i, '');
  if (!rid) return null;
  return {
    rid,
    name: item.name,
    neighborhood: item.neighborhoodName ?? null,
    metroName: item.metroName ?? null,
    profileUrl: `https://www.opentable.com/restaurant/profile/${rid}`,
    raw: item,
  };
}

const REAL_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class OpenTableSearcher {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastResponses: unknown[] = [];

  async open(): Promise<void> {
    if (this.context) return;

    const profileDir = process.env.OT_PROFILE_DIR ??
      path.join(os.homedir(), '.cache', 'wheretoeat', 'chrome-profile-opentable');
    const forceHeadless = process.env.OT_HEADLESS === '1';

    // Per restaurant-cli: headed + persistent profile + Chrome channel defeats Akamai.
    this.context = await chromium.launchPersistentContext(profileDir, {
      headless: forceHeadless,
      channel: 'chrome',
      viewport: { width: 1400, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });

    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.page.setDefaultTimeout(30000);

    this.page.on('response', async (resp) => {
      const u = resp.url();
      if (!u.includes('opname=Autocomplete')) return;
      try {
        const ct = resp.headers()['content-type'] ?? '';
        if (!ct.includes('json')) return;
        const body = await resp.text();
        if (body.length > 200) this.lastResponses.push(JSON.parse(body));
      } catch {
        /* ignore */
      }
    });

    // One-time warmup: load homepage, let Akamai challenge pass.
    await this.page.goto('https://www.opentable.com/', { waitUntil: 'domcontentloaded' });
    await this.warmup(4500);

    // Dismiss OneTrust cookie banner — without this, focus events don't register.
    await this.page.evaluate(`(() => {
      var ids = ['onetrust-accept-btn-handler','accept-recommended-btn-handler'];
      for (var i=0; i<ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el) { el.click(); return; }
      }
    })()`);
    await this.page.waitForTimeout(800);
  }

  /**
   * Verify a restaurant is actually bookable via OpenTable.
   *
   * Many restaurants are *listed* on OpenTable (appear in autocomplete) but
   * not on the booking network — their profile page shows a sidebar reading:
   *   "Not available on OpenTable. Unfortunately, this restaurant is not on
   *    the OpenTable booking network."
   *
   * We detect that copy on `/restaurant/profile/<rid>` and return false.
   * When the page instead shows a booking widget, we return true.
   */
  async verifyBookable(rid: string): Promise<boolean> {
    if (!this.page) throw new Error('call open() first');

    const url = `https://www.opentable.com/restaurant/profile/${encodeURIComponent(rid)}`;
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch {
      return false;
    }
    // Let the React sidebar render. The "Not available" banner is server-rendered,
    // so a short wait is enough.
    await this.page.waitForTimeout(1500);

    try {
      const text = await this.page.evaluate(
        `(() => { try { return document.body && document.body.innerText || ''; } catch (e) { return ''; } })()`,
      ) as string;
      if (/not on the OpenTable booking network/i.test(text)) return false;
      if (/Not available on OpenTable/i.test(text)) return false;
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    try { await this.page?.close(); } catch { /* ignore */ }
    try { await this.context?.close(); } catch { /* ignore */ }
    this.page = null;
    this.context = null;
  }

  private async warmup(ms: number): Promise<void> {
    if (!this.page) return;
    const start = Date.now();
    let i = 0;
    while (Date.now() - start < ms) {
      await this.page.mouse.move(100 + i * 50, 200 + ((i * 37) % 400));
      await this.page.waitForTimeout(400);
      i++;
    }
  }

  /**
   * Type a query into the homepage autocomplete and return the parsed
   * restaurant items from the captured GraphQL response.
   */
  async search(query: string, opts: { city?: string } = {}): Promise<OTMatch[]> {
    if (!this.page) throw new Error('call open() first');

    this.lastResponses = [];

    // Clear and focus input. Using JS so OneTrust overlay doesn't swallow clicks.
    await this.page.evaluate(`(() => {
      var el = document.getElementById('home-page-autocomplete-input');
      if (el) { el.focus(); el.click(); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    })()`);
    await this.page.waitForTimeout(300);

    // Select-all + delete to ensure previous query is cleared even if JS reset didn't fire input handler.
    await this.page.keyboard.press('Meta+A').catch(() => {});
    await this.page.keyboard.press('Backspace').catch(() => {});
    await this.page.waitForTimeout(150);

    const typed = opts.city ? `${opts.city} ${query}` : query;
    await this.page.keyboard.type(typed, { delay: 70 });

    // Wait for debounced autocomplete (~300ms debounce + RTT).
    await this.page.waitForTimeout(2500);

    if (!this.lastResponses.length) return [];
    // Pick the largest response (usually the most-complete one after full query).
    const biggest = this.lastResponses.reduce((a: unknown, b: unknown) =>
      JSON.stringify(b).length > JSON.stringify(a).length ? b : a,
    );
    const items = parseAutocomplete(biggest);
    return items.map(toMatch).filter((m): m is OTMatch => m !== null);
  }
}
