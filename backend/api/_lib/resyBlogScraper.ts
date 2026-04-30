/**
 * Resy blog scraper — blog.resy.com
 *
 * Resy blog posts come in two discoverable shapes:
 *
 * (A) Listicle ("Top 10 NYC Restaurants of 2025", "NYC Wine Hit List"):
 *     - N <article class="teaser2" data-lat data-lng> cards — 1:1 with
 *       restaurants. Each has a Resy venue anchor + `img[alt="N. Name"]`.
 *     - N matching `<h3>N. Name</h3>` editorial headings (clean) with
 *       paragraphs in between, plus a polluted `<h3 class="venue2-title">
 *       N. Name Neighborhood map</h3>` that we must NOT pick up.
 *
 * (B) Single-restaurant post ("Dean's Is an Ode to the British Pub"):
 *     - One dominant Resy venue anchor, the post title *is* the restaurant.
 *     - Numbered `<h3>` sub-headings ("1. Menu is...", "2. The bar...") are
 *       section headers ABOUT this one restaurant — they must NOT be treated
 *       as separate restaurants.
 *
 * Detection order: if any `article.teaser2` cards are present → listicle
 * mode. Else → single-post mode. Each mode emits one `ResyBlogMention` per
 * restaurant with the author's verbatim paragraph as `authorQuote`.
 */
import * as cheerio from 'cheerio';
import { logger } from './logger';

export interface ResyVenueRef {
  /** venueId from `?venueId=N` in the Resy deep link. */
  venueId: string | null;
  /** e.g. "deans" — from `/cities/.../venues/deans` */
  slug: string | null;
  /** Canonical public booking URL (no venueId param). */
  bookingUrl: string;
}

export interface ResyBlogMention {
  restaurantName: string;
  /** The author's verbatim paragraph about this specific restaurant. */
  authorQuote: string;
  resy: ResyVenueRef | null;
  /** Approximate lat/lng from the teaser2 card if available. */
  lat: number | null;
  lng: number | null;
  detectionMethod: 'listicle_teaser' | 'single_post';
}

export interface ResyBlogPost {
  postUrl: string;
  postTitle: string;
  postAuthor: string | null;
  /** ISO8601 UTC from JSON-LD datePublished, fallback to /YYYY/MM/ slug. */
  publishedAt: string;
  /** 'listicle' or 'single' — drives downstream confidence. */
  postType: 'listicle' | 'single' | 'unknown';
  mentions: ResyBlogMention[];
}

const RESY_BLOG_UA =
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
        'User-Agent': RESY_BLOG_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (resp.status === 429) {
      const retryAfterMs = parseRetryAfter(resp.headers.get('retry-after')) ?? 60_000;
      logger.warn('resyBlog.rate_limited', { url, retryAfterMs, attempt });
      if (attempt >= MAX_RETRIES) throw new Error(`rate-limited after ${MAX_RETRIES} retries: ${url}`);
      await sleep(retryAfterMs);
      continue;
    }

    if (!resp.ok) {
      if (attempt < MAX_RETRIES && (resp.status >= 500 || resp.status === 408)) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new Error(`resy blog fetch ${resp.status}: ${url}`);
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

function extractPublishedAt($: cheerio.CheerioAPI, url: string): string {
  const jsonLdScripts = $('script[type="application/ld+json"]').toArray();
  for (const el of jsonLdScripts) {
    const raw = $(el).contents().text().trim();
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      const nodes = Array.isArray(data) ? data : [data];
      for (const n of nodes) {
        if (typeof n?.datePublished === 'string') return n.datePublished;
      }
    } catch { /* skip malformed */ }
  }
  const m = url.match(/\/(20\d{2})\/(\d{2})\//);
  if (m) return `${m[1]}-${m[2]}-01T00:00:00Z`;
  return new Date().toISOString();
}

function extractAuthor($: cheerio.CheerioAPI): string | null {
  const metaAuthor = $('meta[name="author"]').attr('content');
  if (metaAuthor) return metaAuthor.trim();

  const jsonLdScripts = $('script[type="application/ld+json"]').toArray();
  for (const el of jsonLdScripts) {
    try {
      const data = JSON.parse($(el).contents().text().trim());
      const nodes = Array.isArray(data) ? data : [data];
      for (const n of nodes) {
        const a = n?.author;
        if (typeof a === 'string') return a;
        if (Array.isArray(a) && typeof a[0]?.name === 'string') return a[0].name;
        if (typeof a?.name === 'string') return a.name;
      }
    } catch { /* skip */ }
  }
  return null;
}

function extractTitle($: cheerio.CheerioAPI): string {
  const og = $('meta[property="og:title"]').attr('content');
  if (og) return cleanTitle(decodeEntities(og).trim());
  return cleanTitle($('h1').first().text().trim());
}

/** Strip Resy's "— Resy | Right This Way" suffix from og:titles. */
function cleanTitle(title: string): string {
  return decodeEntities(title)
    .replace(/\s*[\u2014\u2013-]\s*Resy\s*\|.*$/i, '')
    .replace(/\s*\|\s*Resy.*$/i, '')
    .trim();
}

function venueRefFrom(href: string): ResyVenueRef | null {
  const slugMatch = href.match(/\/cities\/[^/]+\/venues\/([^/?#]+)/);
  if (!slugMatch) return null;
  const slug = decodeURIComponent(slugMatch[1]);
  const venueIdMatch = href.match(/[?&]venueId=(\d+)/);
  const venueId = venueIdMatch?.[1] ?? null;
  const cityMatch = href.match(/\/cities\/([^/]+)\/venues\//);
  const city = cityMatch?.[1] ?? 'new-york-ny';
  return {
    venueId,
    slug,
    bookingUrl: `https://resy.com/cities/${city}/venues/${slug}`,
  };
}

function stripNumberPrefix(s: string): string {
  return s.replace(/^\s*\d+\.\s+/, '').trim();
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function namesMatch(a: string, b: string): boolean {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** Listicle mode: iterate `.venue2-main` sections — Resy's expandable
 *  long-form container, 1:1 with restaurants. Each has a clean `venue2-name`,
 *  `venue2-location` (neighborhood), `venue2-lead` (verbatim editorial
 *  paragraph), and a Resy venue anchor. Also pair with article.teaser2 by
 *  venue slug to recover lat/lng when available. */
function extractListicle($: cheerio.CheerioAPI): ResyBlogMention[] {
  const mentions: ResyBlogMention[] = [];
  const seen = new Set<string>();

  // Build a slug → {lat, lng} index from teaser2 cards for coord lookup.
  const coordsBySlug = new Map<string, { lat: number; lng: number }>();
  $('article.teaser2').each((_, el) => {
    const $card = $(el);
    const href = $card.find('a[href*="/venues/"]').first().attr('href') ?? '';
    const slug = venueRefFrom(href)?.slug;
    const lat = parseFloat($card.attr('data-lat') ?? '');
    const lng = parseFloat($card.attr('data-lng') ?? '');
    if (slug && Number.isFinite(lat) && Number.isFinite(lng)) {
      coordsBySlug.set(slug, { lat, lng });
    }
  });

  const sections = $('.venue2-main').toArray();
  for (const el of sections) {
    const $m = $(el);

    // Name: prefer the clean `venue2-name` element; fall back to stripping
    // number + trailing neighborhood from `venue2-title`.
    let name = cleanText($m.find('.venue2-name').first().text());
    if (!name) {
      const title = cleanText($m.find('.venue2-title').first().text());
      name = stripNumberPrefix(title)
        .replace(/\s+map$/i, '')
        .trim();
    }
    if (!name) continue;

    // Quote: the author's verbatim editorial paragraph from `venue2-lead`.
    const authorQuote = cleanText($m.find('.venue2-lead').first().text());

    // Resy anchor: any link to resy.com/.../venues/ in this section.
    const href = $m.find('a[href*="resy.com"][href*="/venues/"]').first().attr('href') ?? '';
    const ref = href ? venueRefFrom(href) : null;

    const dedup = ref?.slug ?? normName(name);
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    const coords = ref?.slug ? coordsBySlug.get(ref.slug) : undefined;

    mentions.push({
      restaurantName: name,
      authorQuote,
      resy: ref ?? null,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      detectionMethod: 'listicle_teaser',
    });
  }

  return mentions;
}

/** Single-post mode: the post is about one restaurant. Pair with the
 *  dominant Resy anchor, pull its anchor text as the canonical name, and
 *  grab the first few substantial paragraphs as the author quote. */
function extractSinglePost(
  $: cheerio.CheerioAPI,
  title: string
): ResyBlogMention | null {
  // Find all Resy venue anchors; pick the most frequent slug as the subject.
  // Track each anchor's text so we can pick a short restaurant-shaped name.
  const slugInfo = new Map<string, {
    count: number;
    ref: ResyVenueRef;
    shortestText: string;
  }>();
  $('a[href*="resy.com/cities/"][href*="/venues/"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const ref = venueRefFrom(href);
    if (!ref?.slug) return;
    const text = cleanText($(el).text());
    const entry = slugInfo.get(ref.slug);
    if (entry) {
      entry.count++;
      // Shortest non-empty, non-generic anchor text is usually the name.
      if (text && text.length >= 2 && text.length < 40 &&
          !/^(reserve|book|visit|here|read more)$/i.test(text) &&
          (!entry.shortestText || text.length < entry.shortestText.length)) {
        entry.shortestText = text;
      }
    } else {
      slugInfo.set(ref.slug, {
        count: 1,
        ref,
        shortestText: text && text.length < 40 && !/^(reserve|book|visit|here|read more)$/i.test(text) ? text : '',
      });
    }
  });

  if (slugInfo.size === 0) return null;
  const [, best] = [...slugInfo.entries()].sort((a, b) => b[1].count - a[1].count)[0];

  // Page-scoped <p> walk — Resy wraps many sidebar items in <article> tags
  // (teaser6, etc.), so restricting to article.first() picks up the wrong
  // content. Filter for substantial paragraphs and skip known CTA patterns.
  const paragraphs: string[] = [];
  $('p').each((_, el) => {
    if (paragraphs.length >= 3) return;
    const t = cleanText($(el).text());
    if (t.length < 80) return;
    if (/^(subscribe|sign up|follow us|resy is|reserve at|book a|photo by|photo courtesy|all rights reserved)/i.test(t)) return;
    // Drop byline paragraphs ("By Diana Hubbell, a two-time James Beard
    // Award-winning writer…") — author byline, not editorial content.
    if (/^by\s+[A-Z][\w'\u2019-]+(\s+[A-Z][\w'\u2019-]+){1,3}\s*,\s+/i.test(t)) return;
    paragraphs.push(t);
  });

  const authorQuote = paragraphs.slice(0, 2).join('\n\n').trim();
  if (!authorQuote) return null;

  // Name preference: shortest sensible anchor text → slug-derived fallback.
  // The full post title ("Dean's Is an Ode to the British Pub") is worse than
  // the slug-derived name ("Dean's") for DB + display.
  const anchorName = best.shortestText;
  const slugName = best.ref.slug ? slugToName(best.ref.slug) : null;
  const restaurantName = anchorName || slugName || cleanTitle(title);

  return {
    restaurantName,
    authorQuote,
    resy: best.ref,
    lat: null,
    lng: null,
    detectionMethod: 'single_post',
  };
}

/** Convert a Resy slug ("arthur-ny", "deans") to a display-friendly name.
 *  Drops trailing city/region tokens and title-cases the rest. Fallback
 *  only — the real canonical name comes from Places enrichment later. */
function slugToName(slug: string): string {
  const trimmed = slug
    .replace(/-(ny|nyc|new-york|brooklyn|queens|bronx|manhattan|staten-island)$/i, '')
    .replace(/-/g, ' ');
  return trimmed.replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function readResyBlogPost(url: string): Promise<ResyBlogPost> {
  logger.success('resyBlog.read.start', { url });

  const resp = await politeFetch(url);
  const html = await resp.text();
  const $ = cheerio.load(html);

  const postTitle = extractTitle($);
  const publishedAt = extractPublishedAt($, url);
  const postAuthor = extractAuthor($);

  const hasTeaserCards = $('article.teaser2').length > 0;

  let postType: ResyBlogPost['postType'] = 'unknown';
  let mentions: ResyBlogMention[] = [];

  if (hasTeaserCards) {
    postType = 'listicle';
    mentions = extractListicle($);
  } else {
    postType = 'single';
    const single = extractSinglePost($, postTitle);
    if (single) mentions = [single];
  }

  logger.success('resyBlog.read.done', {
    url,
    title: postTitle,
    postType,
    mentions: mentions.length,
  });

  return {
    postUrl: url,
    postTitle,
    postAuthor,
    publishedAt,
    postType,
    mentions,
  };
}

// =============================================================================
// Pagination — category listings
// =============================================================================
//
// Resy's blog runs on WordPress; categories paginate as
// `https://blog.resy.com/category/<slug>/page/<N>/`. Each page renders a
// repeating set of post links matching `https://blog.resy.com/YYYY/MM/slug/`.
// Pages beyond the last return HTTP 200 with zero matching links; we use
// "no new URLs found" as the stop signal alongside `maxPages`.
//
// We cannot derive `publishedAt` from the listing alone — date metadata is
// only present on each individual post. So this walker returns post URLs
// only; the caller is expected to fetch each post via `readResyBlogPost`
// and apply its own cutoff against `publishedAt`. URLs do embed `/YYYY/MM/`
// in their slug, which the orchestrator can use for a cheap pre-filter
// before fetching the full post body.

const RESY_POST_URL_RE = /https:\/\/blog\.resy\.com\/(\d{4})\/(\d{2})\/[a-z0-9-]+\/?/g;

export interface ResyListedPost {
  url: string;
  // Approximate date from URL slug (`/YYYY/MM/...`). The actual
  // `publishedAt` comes from the post's JSON-LD; this is a cheap pre-filter
  // for cutoff decisions.
  approxDate: Date;
}

/**
 * Walk a Resy blog category listing for post URLs.
 *
 * @param categorySlug e.g. "the-hit-list" → /category/the-hit-list/, or
 *                     "city/new-york" → /city/new-york/ (note the slash).
 * @param maxPages     hard upper bound on pages walked.
 * @param cutoffDate   if a page contains no posts newer than this, stop.
 *                     Compared against the URL-slug date.
 * @returns deduped, in-order list of post URLs (newest first).
 */
export async function listResyBlogCategory(
  categorySlug: string,
  options: { maxPages?: number; cutoffDate?: Date } = {}
): Promise<ResyListedPost[]> {
  const { maxPages = 50, cutoffDate } = options;
  const seen = new Set<string>();
  const out: ResyListedPost[] = [];

  // The "city/new-york" listing lives at /city/{slug}/, not /category/.
  const baseSlug = categorySlug.startsWith('city/') ? categorySlug : `category/${categorySlug}`;

  for (let page = 1; page <= maxPages; page++) {
    const url =
      page === 1
        ? `https://blog.resy.com/${baseSlug}/`
        : `https://blog.resy.com/${baseSlug}/page/${page}/`;

    let html: string;
    try {
      const resp = await politeFetch(url);
      html = await resp.text();
    } catch (e) {
      logger.warn('resyBlog.list.fetch_failed', { url, error: String(e) });
      break;
    }

    let pageNew = 0;
    let pageOldEnoughToStop = !!cutoffDate; // becomes false if any post >= cutoff
    for (const m of html.matchAll(RESY_POST_URL_RE)) {
      const postUrl = m[0].endsWith('/') ? m[0] : `${m[0]}/`;
      if (seen.has(postUrl)) continue;
      seen.add(postUrl);
      const approxDate = new Date(`${m[1]}-${m[2]}-15T00:00:00Z`); // mid-month
      if (cutoffDate && approxDate < cutoffDate) {
        // Older than cutoff — skip silently. We still record cutoff hits
        // because slug-date is approximate; the per-post `publishedAt` is
        // authoritative.
      } else {
        pageOldEnoughToStop = false;
      }
      out.push({ url: postUrl, approxDate });
      pageNew++;
    }

    logger.success('resyBlog.list.page', { categorySlug, page, pageNew, totalSoFar: out.length });

    if (pageNew === 0) {
      // Either we ran past the last page or the slug regex stopped matching.
      break;
    }
    if (pageOldEnoughToStop) {
      // Every post on this page is older than the cutoff — stop walking.
      break;
    }
  }

  return out;
}
