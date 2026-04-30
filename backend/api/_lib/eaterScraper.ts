/**
 * Eater NY scraper — ny.eater.com
 *
 * Eater uses Vox's Chorus CMS. Heatmap / "best of" articles mark each
 * restaurant up as a self-contained `<div class="duet--article--map-card"
 * id="{slug}" data-slug="{slug}">`. Inside:
 *
 *   <div class="hkfm3h3"> <h2>Restaurant Name</h2> <button>Copy link</button> </div>
 *   <p class="duet--article--standard-paragraph">Author quote...</p>
 *   <ul class="hkfm3hd">Location ... Address ... Phone ... Website ...</ul>
 *   <div>... photo credit ...</div>
 *   <div class="duet--recirculation--map-card-recirc">See more ...</div>
 *
 * Non-heatmap articles (news posts, single reviews) don't have these cards;
 * we return `mentions: []` and let the caller decide whether to LLM-fallback
 * the raw body.
 */
import * as cheerio from 'cheerio';
import { logger } from './logger';

export interface EaterMention {
  restaurantName: string;
  /** Verbatim author paragraph, copied exactly from the source. */
  authorQuote: string;
  /** Full street address (e.g. "158 E 188th St, The Bronx, NY 10468") if
   *  parseable from the card metadata. */
  address: string | null;
  /** Card slug (stable id). */
  slug: string | null;
}

export interface EaterArticle {
  postUrl: string;
  postTitle: string;
  postAuthor: string | null;
  /** ISO8601 from Atom <published> / article:published_time / first JSON-LD. */
  publishedAt: string;
  /** 'heatmap' = has map-cards (structured restaurants). 'other' = news/review,
   *  LLM fallback candidate. */
  postType: 'heatmap' | 'other';
  mentions: EaterMention[];
}

const EATER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const POLITE_DELAY_MS = 1500;
const MAX_RETRIES = 3;
let nextAllowedFetchAt = 0;

async function politeFetch(url: string): Promise<Response> {
  const now = Date.now();
  if (now < nextAllowedFetchAt) await sleep(nextAllowedFetchAt - now);
  nextAllowedFetchAt = Date.now() + POLITE_DELAY_MS;

  let attempt = 0;
  while (true) {
    attempt++;
    const resp = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': EATER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (resp.status === 429) {
      const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after')) ?? 60_000;
      logger.warn('eater.rate_limited', { url, retryAfterMs, attempt });
      if (attempt >= MAX_RETRIES) throw new Error(`rate-limited after ${MAX_RETRIES} retries: ${url}`);
      await sleep(retryAfterMs);
      continue;
    }

    if (!resp.ok) {
      if (attempt < MAX_RETRIES && (resp.status >= 500 || resp.status === 408)) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new Error(`eater fetch ${resp.status}: ${url}`);
    }
    return resp;
  }
}

function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const asInt = parseInt(raw, 10);
  if (!Number.isNaN(asInt) && asInt >= 0) return asInt * 1000;
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#8217;|&rsquo;/g, '\u2019')
    .replace(/&#8216;|&lsquo;/g, '\u2018')
    .replace(/&#8220;|&ldquo;/g, '\u201c')
    .replace(/&#8221;|&rdquo;/g, '\u201d')
    .replace(/&#8212;|&mdash;/g, '\u2014')
    .replace(/&#8211;|&ndash;/g, '\u2013')
    .replace(/&#x27;|&#39;/g, '\'')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

function cleanText(s: string): string {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

/** Return the *latest* editorial touch on the article — max(datePublished,
 *  dateModified). Eater heatmaps like "Best Classic Restaurants" are
 *  maintained for years; the original datePublished is stale for freshness
 *  filtering but dateModified tracks when editors last updated the list. */
function extractPublishedAt($: cheerio.CheerioAPI): string {
  const candidates: string[] = [];

  const jsonLd = $('script[type="application/ld+json"]').toArray();
  for (const el of jsonLd) {
    try {
      const data = JSON.parse($(el).contents().text().trim());
      const nodes = Array.isArray(data) ? data : [data];
      for (const n of nodes) {
        if (n?.['@type'] !== 'NewsArticle' && n?.['@type'] !== 'Article') continue;
        if (typeof n?.datePublished === 'string') candidates.push(n.datePublished);
        if (typeof n?.dateModified === 'string') candidates.push(n.dateModified);
      }
    } catch { /* skip */ }
  }

  const pubMeta = $('meta[property="article:published_time"]').attr('content');
  if (pubMeta) candidates.push(pubMeta);
  const modMeta = $('meta[property="article:modified_time"]').attr('content');
  if (modMeta) candidates.push(modMeta);
  const dt = $('time[datetime]').first().attr('datetime');
  if (dt) candidates.push(dt);

  if (!candidates.length) return new Date().toISOString();
  // Pick the latest valid ISO date.
  const sorted = candidates
    .map((c) => ({ c, ts: Date.parse(c) }))
    .filter((x) => !Number.isNaN(x.ts))
    .sort((a, b) => b.ts - a.ts);
  return sorted[0]?.c ?? candidates[0];
}

function extractAuthor($: cheerio.CheerioAPI): string | null {
  const jsonLd = $('script[type="application/ld+json"]').toArray();
  for (const el of jsonLd) {
    try {
      const data = JSON.parse($(el).contents().text().trim());
      const nodes = Array.isArray(data) ? data : [data];
      for (const n of nodes) {
        if (n?.['@type'] !== 'NewsArticle' && n?.['@type'] !== 'Article') continue;
        const a = n?.author;
        if (typeof a === 'string') return a;
        if (Array.isArray(a) && typeof a[0]?.name === 'string') return a[0].name;
        if (typeof a?.name === 'string') return a.name;
      }
    } catch { /* skip */ }
  }
  const metaAuthor = $('meta[name="author"]').attr('content');
  return metaAuthor ? decodeEntities(metaAuthor).trim() : null;
}

function extractTitle($: cheerio.CheerioAPI): string {
  const og = $('meta[property="og:title"]').attr('content');
  if (og) return decodeEntities(og).trim();
  return $('h1').first().text().trim();
}

/** US street-address inside an NYC borough or NY city, ending in zip. */
const ADDRESS_RE =
  /(\d{1,5}[A-Za-z]?\s+[^,]{3,70},\s+(?:The\s+)?(?:Bronx|Brooklyn|Manhattan|Queens|Staten\s+Island|New\s+York)[^,]*,?\s+NY\s+\d{5})(?:,?\s+USA)?/i;

function extractAddress(text: string): string | null {
  const m = text.match(ADDRESS_RE);
  if (!m) return null;
  return cleanText(m[1]).replace(/\s*,?\s*USA\s*$/i, '').trim();
}

function extractMapCards($: cheerio.CheerioAPI): EaterMention[] {
  const cards = $('.duet--article--map-card').toArray();
  const mentions: EaterMention[] = [];
  const seen = new Set<string>();

  for (const el of cards) {
    const $card = $(el);
    const name = cleanText($card.find('h2').first().text());
    if (!name) continue;

    const slug = $card.attr('data-slug') ?? $card.attr('id') ?? null;
    const dedup = slug ?? name.toLowerCase();
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    // Quote: prefer the Chorus "standard paragraph" block; else the first
    // long paragraph that isn't a metadata line or UI label.
    let authorQuote = cleanText(
      $card.find('p.duet--article--standard-paragraph').first().text()
    );

    if (!authorQuote) {
      $card.find('p').each((_, p) => {
        if (authorQuote) return;
        const t = cleanText($(p).text());
        if (t.length >= 60 && !/^(Location|Phone|Visit website|External Link|Copy Link)/i.test(t)) {
          authorQuote = t;
        }
      });
    }

    if (!authorQuote) continue;

    // Address: search the card's metadata region.
    const metaText = cleanText($card.find('ul, address').text()) || cleanText($card.text());
    const address = extractAddress(metaText);

    mentions.push({
      restaurantName: name,
      authorQuote,
      address,
      slug,
    });
  }

  return mentions;
}

export async function readEaterArticle(url: string): Promise<EaterArticle> {
  logger.success('eater.read.start', { url });

  const resp = await politeFetch(url);
  const html = await resp.text();
  const $ = cheerio.load(html);

  const postTitle = extractTitle($);
  const postAuthor = extractAuthor($);
  const publishedAt = extractPublishedAt($);

  const hasCards = $('.duet--article--map-card').length > 0;
  const mentions = hasCards ? extractMapCards($) : [];

  logger.success('eater.read.done', {
    url,
    title: postTitle,
    postType: hasCards ? 'heatmap' : 'other',
    mentions: mentions.length,
  });

  return {
    postUrl: url,
    postTitle,
    postAuthor,
    publishedAt,
    postType: hasCards ? 'heatmap' : 'other',
    mentions,
  };
}

// =============================================================================
// Pagination — heatmap index
// =============================================================================
//
// Eater NY's editorial picks live on heatmaps under `/maps/{slug}`. The
// `/maps` index page lists every active heatmap. There's no per-listing
// date in the index, so this walker just returns deduped URLs; the caller
// fetches each via `readEaterArticle` and uses its `publishedAt` for cutoff.
//
// We deliberately do NOT walk the regular article archive (reviews,
// openings, news) — `eaterScraper`'s extractor only knows the Vox CMS
// `.duet--article--map-card` heatmap layout, so non-heatmap pages return
// zero structural mentions anyway.

export interface EaterListedMap {
  url: string;
  slug: string;
}

/**
 * Walk the `/maps` index for every linked heatmap URL.
 * @param maxMaps cap to keep crawl bounded; default 100 (well above today's count).
 */
export async function listEaterMaps(options: { maxMaps?: number } = {}): Promise<EaterListedMap[]> {
  const { maxMaps = 100 } = options;
  let html: string;
  try {
    const resp = await politeFetch('https://ny.eater.com/maps');
    html = await resp.text();
  } catch (e) {
    logger.warn('eater.list.fetch_failed', { error: String(e) });
    return [];
  }

  const out: EaterListedMap[] = [];
  const seen = new Set<string>();

  // Match relative links of the form href="/maps/<slug>" — slug is alnum + dash.
  const re = /href="\/maps\/([a-z0-9][a-z0-9-]+)"/g;
  for (const m of html.matchAll(re)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    // Skip the index itself ("/maps" with nothing after) — already excluded
    // by the regex requiring at least one slug char, but defensive.
    if (!slug || slug === 'maps') continue;
    seen.add(slug);
    out.push({ url: `https://ny.eater.com/maps/${slug}`, slug });
    if (out.length >= maxMaps) break;
  }

  logger.success('eater.list.done', { count: out.length });
  return out;
}
