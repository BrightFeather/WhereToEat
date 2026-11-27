/**
 * Fill resy_booking_url / opentable_booking_url / tock_booking_url for one
 * city's available restaurants, on Neon and local SQLite.
 *
 *   CITY=bay DRY_RUN=1 npx ts-node -T scripts/backfill-booking-links.ts
 *   CITY=bay npx ts-node -T scripts/backfill-booking-links.ts
 *
 * Sources, best first:
 *   1. The restaurant's own website (Places `website_url`) and its
 *      reservations page, rendered in headless Chromium. Every link, iframe
 *      and network request is checked, so JS-loaded booking widgets count
 *      (OpenTable `rid=`, Resy widget venue ids, Tock iframes).
 *   2. Resy's public venue search (no login) by name near the restaurant's
 *      coordinates; accepted only on a name match within MAX_RESY_METERS.
 * Resy links whose city slug isn't in this city are rejected (sites often
 * link a sister restaurant in another city).
 *
 * Only fills empty columns, never overwrites. OpenTable is mostly found via
 * the website; `backfill-opentable.ts` (headed browser) is the fallback.
 */
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import Database from 'better-sqlite3';
import { neon } from '@neondatabase/serverless';
import { chromium, type Browser } from 'playwright';

const CITY = process.env.CITY ?? 'bay';
const DRY_RUN = process.env.DRY_RUN === '1';
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);
const MAX_RESY_METERS = 400;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const RESY_API_KEY = 'VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5';
const RESY_HEADERS = {
  Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
  Origin: 'https://resy.com',
  Referer: 'https://resy.com/',
  'User-Agent': UA,
};
const RESY_CITY_OK: Record<string, (slug: string) => boolean> = {
  bay: (slug) => slug === 'sf' || slug.endsWith('-ca'),
  nyc: (slug) => slug === 'ny' || slug === 'nyc' || slug.endsWith('-ny'),
};
const resyCityOk = (slug: string) => (RESY_CITY_OK[CITY] ?? (() => true))(slug);

const neonUrl =
  process.env.DATABASE_URL || process.env.WHERE_TO_EAT_DATABASE_URL || process.env.WHERE_TO_EAT_POSTGRES_URL;
if (!neonUrl) throw new Error('No Neon connection string in env');
const sql = neon(neonUrl);
const sqlite = new Database(path.resolve(__dirname, '../data/wheretoeat.db'));

interface Row {
  id: string;
  restaurant_name: string;
  google_display_name: string | null;
  website_url: string | null;
  latitude: number | null;
  longitude: number | null;
  resy_booking_url: string | null;
  opentable_booking_url: string | null;
  tock_booking_url: string | null;
}

interface Links { resy?: string; resyVenueId?: string; opentable?: string; opentableRid?: string; tock?: string }

// ---------- URL classification ----------

const TOCK_RESERVED = new Set([
  '', 'api', 'join', 'about', 'blog', 'help', 'careers', 'city', 'cities', 'search', 'login', 'signup',
  'static', 'assets', 'images', 'business', 'partners', 'privacy', 'terms', 'explore', 'giftcards',
]);
const RESY_RESERVED = new Set(['search', 'venues', 'collections', 'list']);

function classify(raw: string): Links {
  let u: URL;
  try { u = new URL(raw.replace(/&amp;/g, '&')); } catch { return {}; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const segs = u.pathname.split('/').filter(Boolean);

  if (host === 'resy.com' && segs[0] === 'cities' && segs.length >= 3) {
    const slug = segs[2] === 'venues' ? segs[3] : segs[2];
    if (slug && !RESY_RESERVED.has(slug) && resyCityOk(segs[1])) {
      return { resy: `https://resy.com/cities/${segs[1]}/venues/${slug}` };
    }
  }
  if (host.endsWith('resy.com')) {
    const id = u.searchParams.get('venueId') ?? u.searchParams.get('venue_id')
      ?? u.hash.match(/venues\/(\d+)/)?.[1];
    if (id && /^\d+$/.test(id)) return { resyVenueId: id };
  }
  if (host === 'opentable.com' || host.endsWith('.opentable.com')) {
    const rid = u.searchParams.get('rid') ?? u.searchParams.get('restref');
    if (rid && /^\d+$/.test(rid)) {
      return { opentable: `https://www.opentable.com/restaurant/profile/${rid}`, opentableRid: rid };
    }
    if (segs[0] === 'restaurant' && segs[1] === 'profile' && /^\d+$/.test(segs[2] ?? '')) {
      return { opentable: `https://www.opentable.com/restaurant/profile/${segs[2]}`, opentableRid: segs[2] };
    }
    if (segs[0] === 'r' && segs[1]) return { opentable: `https://www.opentable.com/r/${segs[1]}` };
  }
  if (host === 'exploretock.com') {
    const slug = (segs[0] ?? '').toLowerCase();
    if (!TOCK_RESERVED.has(slug) && /^[a-z0-9-]+$/.test(slug)) return { tock: `https://www.exploretock.com/${slug}` };
  }
  return {};
}

/** Most-linked candidate per platform; a site often links its own page several times. */
function pickLinks(urls: string[]): Links {
  const tally: Record<'resy' | 'opentable' | 'tock', Map<string, number>> = {
    resy: new Map(), opentable: new Map(), tock: new Map(),
  };
  const rids = new Map<string, string>();
  let resyVenueId: string | undefined;
  for (const u of urls) {
    const c = classify(u);
    resyVenueId ??= c.resyVenueId;
    for (const k of ['resy', 'opentable', 'tock'] as const) {
      const v = c[k];
      if (v) tally[k].set(v, (tally[k].get(v) ?? 0) + 1);
    }
    if (c.opentable && c.opentableRid) rids.set(c.opentable, c.opentableRid);
  }
  const best = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const links: Links = { resy: best(tally.resy), opentable: best(tally.opentable), tock: best(tally.tock) };
  if (links.opentable && rids.has(links.opentable)) links.opentableRid = rids.get(links.opentable);
  if (!links.resy && resyVenueId) links.resyVenueId = resyVenueId;
  return links;
}

// ---------- Website scan (headless browser) ----------

async function collectUrls(browser: Browser, url: string): Promise<{ urls: string[]; finalUrl: string } | null> {
  const context = await browser.newContext({ userAgent: UA });
  const urls = new Set<string>();
  const page = await context.newPage();
  page.on('request', (r) => urls.add(r.url()));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
    const hrefs = await page.evaluate(() => [
      ...Array.from(document.querySelectorAll('a[href]'), (a) => (a as HTMLAnchorElement).href),
      ...Array.from(document.querySelectorAll('iframe[src]'), (f) => (f as HTMLIFrameElement).src),
    ]);
    for (const h of hrefs) urls.add(h);
    for (const f of page.frames()) urls.add(f.url());
    return { urls: [...urls], finalUrl: page.url() };
  } catch {
    return urls.size > 0 ? { urls: [...urls], finalUrl: page.url() } : null;
  } finally {
    await context.close();
  }
}

async function scanWebsite(browser: Browser, website: string): Promise<Links> {
  const home = await collectUrls(browser, website);
  if (!home) return strip(classify(website));
  let links: Links = { ...strip(pickLinks(home.urls)), ...strip(classify(home.finalUrl)), ...strip(classify(website)) };

  if ((!links.resy && !links.resyVenueId) || !links.opentable || !links.tock) {
    // One hop to the site's own reservations page, where widgets usually live.
    let host = '';
    try { host = new URL(home.finalUrl).hostname; } catch { /* ignore */ }
    const resPage = home.urls.find((u) => {
      try {
        const p = new URL(u);
        return p.hostname === host && /reserv|book|table/i.test(p.pathname);
      } catch { return false; }
    });
    if (resPage) {
      const sub = await collectUrls(browser, resPage);
      if (sub) links = { ...strip(pickLinks(sub.urls)), ...strip(classify(sub.finalUrl)), ...links };
    }
  }
  return links;
}

/** Turns a widget's numeric Resy venue id into a public booking URL. */
async function resolveResyVenue(id: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://api.resy.com/3/venue?id=${encodeURIComponent(id)}`, {
      headers: RESY_HEADERS,
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return undefined;
    const v = (await res.json()) as { url_slug?: string; location?: { url_slug?: string } };
    const city = v.location?.url_slug;
    if (!v.url_slug || !city || !resyCityOk(city)) return undefined;
    return `https://resy.com/cities/${city}/venues/${v.url_slug}`;
  } catch {
    return undefined;
  }
}

function strip(l: Links): Links {
  return Object.fromEntries(Object.entries(l).filter(([, v]) => v)) as Links;
}

// ---------- Resy search ----------

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

function namesMatch(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const shorter = Math.min(x.length, y.length), longer = Math.max(x.length, y.length);
  return shorter >= 4 && (x.includes(y) || y.includes(x)) && shorter >= longer * 0.6;
}

function meters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function searchResy(row: Row): Promise<Links> {
  if (row.latitude == null || row.longitude == null) return {};
  const names = [row.google_display_name, row.restaurant_name].filter((s): s is string => !!s);
  for (const name of names) {
    let hits: any[] = [];
    try {
      const res = await fetch('https://api.resy.com/3/venuesearch/search', {
        method: 'POST',
        headers: { ...RESY_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: name,
          geo: { latitude: row.latitude, longitude: row.longitude },
          per_page: 5,
          types: ['venue'],
        }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;
      hits = ((await res.json()) as any)?.search?.hits ?? [];
    } catch {
      continue;
    }
    for (const h of hits) {
      const geo = h._geoloc;
      const citySlug = h.location?.url_slug;
      if (!geo || !citySlug || !h.url_slug || !resyCityOk(citySlug) || !namesMatch(h.name ?? '', name)) continue;
      if (meters(row.latitude, row.longitude, geo.lat, geo.lng) > MAX_RESY_METERS) continue;
      const venueId = typeof h.id === 'object' ? h.id?.resy : h.id;
      return { resy: `https://resy.com/cities/${citySlug}/venues/${h.url_slug}`, resyVenueId: venueId ? String(venueId) : undefined };
    }
  }
  return {};
}

// ---------- Main ----------

async function save(id: string, l: Links): Promise<void> {
  await sql`
    UPDATE xhs_restaurants SET
      resy_booking_url      = COALESCE(resy_booking_url, ${l.resy ?? null}),
      resy_venue_id         = COALESCE(resy_venue_id, ${l.resyVenueId ?? null}),
      opentable_booking_url = COALESCE(opentable_booking_url, ${l.opentable ?? null}),
      opentable_rid         = COALESCE(opentable_rid, ${l.opentableRid ?? null}),
      tock_booking_url      = COALESCE(tock_booking_url, ${l.tock ?? null})
    WHERE id = ${id}`;
  sqlite.prepare(`
    UPDATE xhs_restaurants SET
      resy_booking_url      = COALESCE(resy_booking_url, ?),
      resy_venue_id         = COALESCE(resy_venue_id, ?),
      opentable_booking_url = COALESCE(opentable_booking_url, ?),
      opentable_rid         = COALESCE(opentable_rid, ?),
      tock_booking_url      = COALESCE(tock_booking_url, ?)
    WHERE id = ?`).run(l.resy ?? null, l.resyVenueId ?? null, l.opentable ?? null, l.opentableRid ?? null, l.tock ?? null, id);
}

async function main() {
  const rows = ((await sql`
    SELECT id, restaurant_name, google_display_name, website_url, latitude, longitude,
           resy_booking_url, opentable_booking_url, tock_booking_url
    FROM xhs_restaurants
    WHERE city = ${CITY} AND is_available_this_week = 1
      AND (resy_booking_url IS NULL OR opentable_booking_url IS NULL OR tock_booking_url IS NULL)
    ORDER BY total_likes DESC
  `) as Row[]).slice(0, LIMIT);
  console.log(`[booking-links] city=${CITY}${DRY_RUN ? ' (dry run)' : ''} rows=${rows.length}`);

  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const counts = { resy_site: 0, resy_search: 0, opentable: 0, tock: 0, any: 0, none: 0 };
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const row = rows[next++];
      const site = row.website_url ? await scanWebsite(browser, row.website_url) : {};
      if (!site.resy && site.resyVenueId) site.resy = await resolveResyVenue(site.resyVenueId);
      if (!site.resy) delete site.resyVenueId;
      const found: Links = { ...site };
      if (!found.resy && !row.resy_booking_url) {
        const r = await searchResy(row);
        if (r.resy) { Object.assign(found, r); counts.resy_search++; }
      } else if (site.resy) counts.resy_site++;
      if (found.opentable) counts.opentable++;
      if (found.tock) counts.tock++;
      const label = row.google_display_name ?? row.restaurant_name;
      if (found.resy || found.opentable || found.tock) {
        counts.any++;
        console.log(`✓ ${label}  ${[found.resy, found.opentable, found.tock].filter(Boolean).join('  ')}`);
        if (!DRY_RUN) await save(row.id, found);
      } else {
        counts.none++;
        console.log(`· ${label}${row.website_url ? '' : '  (no website)'}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();
  console.log('[booking-links] done', counts);
}

main().catch((e) => {
  console.error('[booking-links] failed:', e);
  process.exit(1);
});
