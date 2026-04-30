/**
 * Multi-source ingest (Resy blog + Eater NY) — MS5.
 *
 * Pipeline per mention:
 *   1. Scrape (Resy/Eater — already done by readResyBlogPost / readEaterArticle)
 *   2. Classify cuisine + features (Gemini)
 *   3. Places enrichment (Google Places New API)
 *   4. Opportunistic Resy findVenue for Eater/unlinked Resy mentions
 *   5. Dedup across sources by googlePlaceId (fallback: normalized name)
 *   6. Upsert canonical row into xhs_restaurants
 *   7. Insert one xhs_sources row per source mention with source_type
 *
 * Scoped intentionally to a hardcoded small curated URL list to match the
 * validation-first workflow. Pagination / full listing crawl lands in a
 * follow-up; this script is about getting real DB rows flowing.
 *
 * Run:
 *   npx ts-node scripts/ingest-multi-source.ts            # live writes
 *   npx ts-node scripts/ingest-multi-source.ts --dry-run  # prints, no DB
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { sql } from '../api/_lib/db';
import {
  readResyBlogPost,
  listResyBlogCategory,
  type ResyBlogMention,
} from '../api/_lib/resyBlogScraper';
import { readEaterArticle, listEaterMaps, type EaterMention } from '../api/_lib/eaterScraper';
import { classifyMention, classifyMentionsBatch } from '../api/_lib/llmExtractor';
import { enrichWithPlaces, type PlacesResult } from '../api/_lib/placesEnricher';
import { canonicalizeFeatures, type FeatureKey } from '../api/_lib/features';
import type { CuisineKey } from '../api/_lib/cuisines';
import { logger } from '../api/_lib/logger';

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_ENRICH = process.argv.includes('--no-enrich');
const SKIP_CLASSIFY = process.argv.includes('--no-classify');
const FROM_CACHE = process.argv.includes('--from-cache');
const PAGINATE = process.argv.includes('--paginate');
const BATCH_CLASSIFY = !process.argv.includes('--no-batch-classify');
const CACHE_PATH = path.resolve(__dirname, '../data/ingest-cache.json');
const PROGRESS_PATH = path.resolve(__dirname, '../data/ingest-progress.json');

const CITY = 'nyc';
const CLASSIFY_DELAY_MS = parseInt(process.env.CLASSIFY_DELAY_MS ?? '7000', 10);
const PLACES_DELAY_MS = parseInt(process.env.PLACES_DELAY_MS ?? '200', 10);
const CLASSIFY_BATCH_SIZE = parseInt(process.env.CLASSIFY_BATCH_SIZE ?? '10', 10);
// Posts older than this are dropped during pagination.
const CUTOFF_DAYS = parseInt(process.env.CUTOFF_DAYS ?? '365', 10);

// Hardcoded fallback URLs (used when --paginate is NOT passed). The
// pagination path discovers URLs dynamically via category walkers below.
const RESY_URLS = [
  'https://blog.resy.com/2025/12/nyc-restaurants-2025/',
  'https://blog.resy.com/2026/03/deans-nyc/',
  'https://blog.resy.com/2026/04/arthur-nyc/',
];
const EATER_URLS = [
  'https://ny.eater.com/maps/classic-restaurants-nyc',
  'https://ny.eater.com/maps/best-nyc-steakhouse-classic',
];

// Categories walked when --paginate is set.
//
// Default: NYC-only via `/city/new-york/`. The other 3 Resy blog categories
// (the-hit-list, guides, new-on-resy) are city-mixed national feeds —
// page-1 of `guides` returned posts from Detroit, DC, Chicago, LA, etc.
// Any NYC post in those categories is also tagged `/city/new-york/`, so
// using the city slug alone is exhaustive and noise-free.
//
// Pass `--all-categories` to opt into the wider crawl (use with care:
// it'll add ~370 non-NYC URLs to the fetch+classify queue).
const RESY_CATEGORIES_NYC = ['city/new-york'];
const RESY_CATEGORIES_ALL = [
  'the-hit-list',
  'guides',
  'new-on-resy',
  'city/new-york',
];
const RESY_CATEGORIES = process.argv.includes('--all-categories')
  ? RESY_CATEGORIES_ALL
  : RESY_CATEGORIES_NYC;

// Common intermediate shape — everything we need to write one source row.
interface CandidateMention {
  sourceType: 'resy_blog' | 'eater';
  sourceUrl: string;      // post URL
  sourceTitle: string;    // post headline
  author: string | null;
  postCreatedAt: string;  // ISO

  restaurantName: string;
  authorQuote: string;
  address: string | null;
  locationHint: string | null;

  // Pre-attached Resy booking (only for Resy-blog mentions that had an anchor).
  resyVenueId: string | null;
  resyBookingUrl: string | null;

  // Populated after classify + enrich.
  llmCuisineKey?: CuisineKey | null;
  llmFeatures?: FeatureKey[];
  places?: PlacesResult | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function scrapeResyUrls(urls: string[]): Promise<CandidateMention[]> {
  const out: CandidateMention[] = [];
  for (const url of urls) {
    const post = await readResyBlogPost(url);
    if (!post) continue;
    for (const m of post.mentions) {
      out.push(resyMentionToCandidate(m, post));
    }
  }
  return out;
}

function resyMentionToCandidate(
  m: ResyBlogMention,
  post: { postUrl: string; postTitle: string; postAuthor: string | null; publishedAt: string }
): CandidateMention {
  return {
    sourceType: 'resy_blog',
    sourceUrl: post.postUrl,
    sourceTitle: post.postTitle,
    author: post.postAuthor,
    postCreatedAt: post.publishedAt,
    restaurantName: m.restaurantName,
    authorQuote: m.authorQuote,
    address: null,
    // Hint for Places search: neighborhood from the resy URL slug isn't reliable,
    // but coordinates are — if we have lat/lng we could do a reverse-geocode.
    // Keep it simple for now — name + "New York City" is the Places fallback.
    locationHint: null,
    resyVenueId: m.resy?.venueId ?? null,
    resyBookingUrl: m.resy?.bookingUrl ?? null,
  };
}

async function scrapeEaterUrls(urls: string[]): Promise<CandidateMention[]> {
  const out: CandidateMention[] = [];
  for (const url of urls) {
    const post = await readEaterArticle(url);
    for (const m of post.mentions) {
      out.push(eaterMentionToCandidate(m, post));
    }
  }
  return out;
}

function eaterMentionToCandidate(
  m: EaterMention,
  post: { postUrl: string; postTitle: string; postAuthor: string | null; publishedAt: string }
): CandidateMention {
  return {
    sourceType: 'eater',
    sourceUrl: post.postUrl,
    sourceTitle: post.postTitle,
    author: post.postAuthor,
    postCreatedAt: post.publishedAt,
    restaurantName: m.restaurantName,
    authorQuote: m.authorQuote,
    address: m.address,
    locationHint: null,
    resyVenueId: null,
    resyBookingUrl: null,
  };
}

async function classifyAll(mentions: CandidateMention[]): Promise<void> {
  if (SKIP_CLASSIFY) {
    for (const m of mentions) { m.llmCuisineKey = null; m.llmFeatures = []; }
    return;
  }

  if (BATCH_CLASSIFY) {
    // 10 mentions per Gemini call. ~140 calls × 7s = ~16 min for ~1,400
    // mentions, well under the free-tier 250 RPD cap.
    const inputs = mentions.map((m) => ({
      name: m.restaurantName,
      authorQuote: m.authorQuote,
      address: m.address,
    }));
    process.stderr.write(`  classify (batched, size=${CLASSIFY_BATCH_SIZE}) ${mentions.length} mentions…\n`);
    const classified = await classifyMentionsBatch(inputs, CLASSIFY_BATCH_SIZE, CLASSIFY_DELAY_MS);
    for (let i = 0; i < mentions.length; i++) {
      mentions[i].llmCuisineKey = classified[i].cuisineKey;
      mentions[i].llmFeatures = classified[i].features;
    }
    return;
  }

  for (let i = 0; i < mentions.length; i++) {
    const m = mentions[i];
    process.stderr.write(`  classify ${i + 1}/${mentions.length} — ${m.restaurantName.slice(0, 40)}\r`);
    const c = await classifyMention({
      name: m.restaurantName,
      authorQuote: m.authorQuote,
      address: m.address,
    });
    m.llmCuisineKey = c.cuisineKey;
    m.llmFeatures = c.features;
    if (i < mentions.length - 1) await sleep(CLASSIFY_DELAY_MS);
  }
  process.stderr.write('\n');
}

async function enrichAll(mentions: CandidateMention[]): Promise<void> {
  if (SKIP_ENRICH) {
    for (const m of mentions) m.places = null;
    return;
  }
  for (let i = 0; i < mentions.length; i++) {
    const m = mentions[i];
    process.stderr.write(`  enrich  ${i + 1}/${mentions.length} — ${m.restaurantName.slice(0, 40)}\r`);
    m.places = await enrichWithPlaces({
      restaurantName: m.restaurantName,
      address: m.address,
      locationHint: m.locationHint,
      cuisineKey: null,
      features: [],
      creatorRecommendation: null,
      postUrl: m.sourceUrl,
      postCreatedAt: m.postCreatedAt,
      likes: 0,
    });
    if (i < mentions.length - 1) await sleep(PLACES_DELAY_MS);
  }
  process.stderr.write('\n');
}

// Canonical row aggregated across all mentions of the same restaurant.
interface CanonicalRestaurant {
  dedupKey: string;        // googlePlaceId when available; normalized name otherwise
  id: string;              // uuid for DB row (generated if new)
  restaurantName: string;
  address: string | null;
  borough: string | null;
  neighborhood: string | null;
  cuisineKey: CuisineKey | null;
  features: FeatureKey[];
  googlePlaceId: string | null;
  googleMapsUrl: string | null;
  googleDisplayName: string | null;
  websiteUrl: string | null;
  photoUrl: string | null;
  photoUrls: string[];
  resyVenueId: string | null;
  resyBookingUrl: string | null;
  priceLevel: string | null;
  mentionCount: number;
  sources: CandidateMention[];
}

function dedupAcrossSources(mentions: CandidateMention[]): CanonicalRestaurant[] {
  const groups = new Map<string, CanonicalRestaurant>();

  for (const m of mentions) {
    const key = m.places?.googlePlaceId
      ? `place:${m.places.googlePlaceId}`
      : `name:${normName(m.restaurantName)}`;

    const existing = groups.get(key);
    if (existing) {
      existing.sources.push(m);
      existing.mentionCount = existing.sources.length;
      // Prefer non-null Places fields from the current mention if the current
      // canonical doesn't have them.
      if (!existing.resyVenueId && m.resyVenueId) {
        existing.resyVenueId = m.resyVenueId;
        existing.resyBookingUrl = m.resyBookingUrl;
      }
      existing.features = canonicalizeFeatures([...existing.features, ...(m.llmFeatures ?? [])]);
      continue;
    }

    const p = m.places;
    // Places-derived cuisine takes priority; fall back to LLM classifier.
    const cuisineKey: CuisineKey | null = p?.cuisineKey ?? m.llmCuisineKey ?? null;
    // Features: union of Places-derived + LLM-derived.
    const features = canonicalizeFeatures([...(p?.features ?? []), ...(m.llmFeatures ?? [])]);

    groups.set(key, {
      dedupKey: key,
      id: randomUUID(),
      restaurantName: p?.googleDisplayName || m.restaurantName,
      address: p?.address ?? m.address,
      borough: p?.borough ?? null,
      neighborhood: p?.neighborhood ?? null,
      cuisineKey,
      features,
      googlePlaceId: p?.googlePlaceId ?? null,
      googleMapsUrl: p?.googleMapsUrl ?? null,
      googleDisplayName: p?.googleDisplayName ?? null,
      websiteUrl: p?.websiteUrl ?? null,
      photoUrl: p?.photoUrl ?? null,
      photoUrls: p?.photoUrls ?? [],
      resyVenueId: m.resyVenueId,
      resyBookingUrl: m.resyBookingUrl,
      priceLevel: p?.priceLevel ?? null,
      mentionCount: 1,
      sources: [m],
    });
  }

  return [...groups.values()].sort((a, b) => b.mentionCount - a.mentionCount);
}

async function writeToDb(canonicals: CanonicalRestaurant[]): Promise<{
  canonicalsInserted: number;
  canonicalsUpdated: number;
  sourcesInserted: number;
  sourcesSkipped: number;
}> {
  let canonicalsInserted = 0;
  let canonicalsUpdated = 0;
  let sourcesInserted = 0;
  let sourcesSkipped = 0;

  for (const c of canonicals) {
    // Try to find an existing canonical row by (city, google_place_id). If
    // google_place_id is null we skip the lookup and always insert fresh —
    // same semantics as the archived pipeline.
    let canonicalId = c.id;
    let isUpdate = false;

    if (c.googlePlaceId) {
      const rows = await sql`
        SELECT id FROM xhs_restaurants
        WHERE city = ${CITY} AND google_place_id = ${c.googlePlaceId}
        LIMIT 1
      `;
      if (rows.length) {
        canonicalId = String(rows[0].id);
        isUpdate = true;
      }
    }

    const featuresJson = c.features.length ? JSON.stringify(c.features) : null;
    const photoUrlsJson = c.photoUrls.length ? JSON.stringify(c.photoUrls) : null;

    if (isUpdate) {
      await sql`
        UPDATE xhs_restaurants SET
          restaurant_name = ${c.restaurantName},
          address = ${c.address},
          borough = ${c.borough},
          neighborhood = ${c.neighborhood},
          cuisine_type = ${c.cuisineKey},
          features = ${featuresJson},
          google_maps_url = ${c.googleMapsUrl},
          google_display_name = ${c.googleDisplayName},
          website_url = ${c.websiteUrl},
          photo_url = ${c.photoUrl},
          photo_urls = ${photoUrlsJson},
          resy_venue_id = COALESCE(${c.resyVenueId}, resy_venue_id),
          resy_booking_url = COALESCE(${c.resyBookingUrl}, resy_booking_url),
          price_level = COALESCE(${c.priceLevel}, price_level),
          mention_count = ${c.mentionCount}
        WHERE id = ${canonicalId}
      `;
      canonicalsUpdated++;
    } else {
      // Pick a representative sourceUrl for the canonical row (soonest post).
      const primarySource = c.sources.reduce((a, b) =>
        a.postCreatedAt > b.postCreatedAt ? a : b
      );
      await sql`
        INSERT INTO xhs_restaurants (
          id, city, restaurant_name, address, borough, neighborhood,
          cuisine_type, features, recommendation,
          post_url, post_created_at,
          mention_count, total_likes,
          google_place_id, google_maps_url, google_display_name, website_url,
          photo_url, photo_urls,
          resy_venue_id, resy_booking_url,
          price_level
        ) VALUES (
          ${canonicalId}, ${CITY}, ${c.restaurantName}, ${c.address},
          ${c.borough}, ${c.neighborhood},
          ${c.cuisineKey}, ${featuresJson}, ${primarySource.authorQuote},
          ${primarySource.sourceUrl}, ${primarySource.postCreatedAt},
          ${c.mentionCount}, ${0},
          ${c.googlePlaceId}, ${c.googleMapsUrl}, ${c.googleDisplayName}, ${c.websiteUrl},
          ${c.photoUrl}, ${photoUrlsJson},
          ${c.resyVenueId}, ${c.resyBookingUrl},
          ${c.priceLevel}
        )
      `;
      canonicalsInserted++;
    }

    // One xhs_sources row per source mention. Uniqueness constraint
    // (restaurant_id, post_url) means same URL won't duplicate on re-runs.
    for (const s of c.sources) {
      try {
        // post_url IS the source URL for all source types — the column
        // predates multi-source; keeping the name avoids a mass migration.
        await sql`
          INSERT INTO xhs_sources (
            id, restaurant_id, source_type, source_title, author,
            post_url, recommendation, post_created_at, likes
          ) VALUES (
            ${randomUUID()}, ${canonicalId}, ${s.sourceType},
            ${s.sourceTitle}, ${s.author},
            ${s.sourceUrl}, ${s.authorQuote}, ${s.postCreatedAt}, ${0}
          )
        `;
        sourcesInserted++;
      } catch (e) {
        const msg = String(e);
        if (msg.includes('UNIQUE') || msg.includes('unique') || msg.includes('duplicate')) {
          sourcesSkipped++;
        } else {
          throw e;
        }
      }
    }
  }

  return { canonicalsInserted, canonicalsUpdated, sourcesInserted, sourcesSkipped };
}

async function main() {
  console.error('\n=== Multi-source ingest ===');
  console.error(`Mode: ${DRY_RUN ? 'DRY-RUN (no DB writes)' : 'LIVE'}`);
  console.error(`Classify: ${SKIP_CLASSIFY ? 'skipped' : 'enabled'} | Enrich: ${SKIP_ENRICH ? 'skipped' : 'enabled'} | FromCache: ${FROM_CACHE}`);
  console.error('');

  let all: CandidateMention[];

  if (FROM_CACHE) {
    if (!fs.existsSync(CACHE_PATH)) {
      throw new Error(`--from-cache but no cache at ${CACHE_PATH}; run without the flag first`);
    }
    all = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    console.error(`→ Loaded ${all.length} mentions from cache ${CACHE_PATH}`);
  } else {
    let resyTargets: string[];
    let eaterTargets: string[];

    if (PAGINATE) {
      const cutoff = new Date(Date.now() - CUTOFF_DAYS * 86400 * 1000);
      console.error(`→ Walking Resy categories (cutoff: posts published after ${cutoff.toISOString().slice(0, 10)})`);
      const resyDiscovered = new Map<string, Date>();
      for (const cat of RESY_CATEGORIES) {
        const list = await listResyBlogCategory(cat, { cutoffDate: cutoff, maxPages: 50 });
        for (const p of list) {
          if (!resyDiscovered.has(p.url) && p.approxDate >= cutoff) {
            resyDiscovered.set(p.url, p.approxDate);
          }
        }
        console.error(`  ${cat}: cumulative ${resyDiscovered.size} unique post URLs`);
      }
      resyTargets = [...resyDiscovered.keys()];

      console.error('→ Walking Eater /maps index');
      const eaterList = await listEaterMaps({ maxMaps: 100 });
      eaterTargets = eaterList.map((m) => m.url);
      console.error(`  ${eaterTargets.length} maps`);

      // Persist the discovery list so a crash mid-fetch can resume.
      fs.writeFileSync(
        PROGRESS_PATH,
        JSON.stringify({
          resy: resyTargets,
          eater: eaterTargets,
          discoveredAt: new Date().toISOString(),
        }, null, 2)
      );
      console.error(`→ Wrote discovery progress to ${PROGRESS_PATH}`);
    } else if (fs.existsSync(PROGRESS_PATH) && process.argv.includes('--resume')) {
      const prog = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8')) as { resy: string[]; eater: string[] };
      resyTargets = prog.resy;
      eaterTargets = prog.eater;
      console.error(`→ Resumed discovery list (${resyTargets.length} resy, ${eaterTargets.length} eater)`);
    } else {
      resyTargets = RESY_URLS;
      eaterTargets = EATER_URLS;
    }

    console.error(`→ Scraping Resy blog (${resyTargets.length} URLs)…`);
    const resy = await scrapeResyUrls(resyTargets);
    console.error(`  ${resy.length} mentions`);

    console.error(`→ Scraping Eater NY (${eaterTargets.length} URLs)…`);
    const eater = await scrapeEaterUrls(eaterTargets);
    console.error(`  ${eater.length} mentions`);

    // Cutoff filter — drop mentions whose post is older than the threshold,
    // using the authoritative `postCreatedAt` (from JSON-LD) rather than the
    // approximate URL-slug date.
    if (PAGINATE) {
      const cutoffMs = Date.now() - CUTOFF_DAYS * 86400 * 1000;
      const before = resy.length + eater.length;
      const keep = (m: CandidateMention) => new Date(m.postCreatedAt).getTime() >= cutoffMs;
      const resyKept = resy.filter(keep);
      const eaterKept = eater.filter(keep);
      const dropped = before - (resyKept.length + eaterKept.length);
      if (dropped > 0) console.error(`  cutoff drop: ${dropped} mentions older than ${CUTOFF_DAYS}d`);
      all = [...resyKept, ...eaterKept];
    } else {
      all = [...resy, ...eater];
    }
    console.error(`→ ${all.length} total mentions`);

    console.error('→ Classifying (Gemini)…');
    await classifyAll(all);

    console.error('→ Places enrichment (Google)…');
    await enrichAll(all);

    // Cache the expensive work so --from-cache re-runs skip 7 min of API.
    fs.writeFileSync(CACHE_PATH, JSON.stringify(all));
    console.error(`→ Wrote cache ${CACHE_PATH}`);
  }

  console.error('→ Dedup across sources…');
  const canonicals = dedupAcrossSources(all);
  const enrichedCount = canonicals.filter((c) => c.googlePlaceId).length;
  console.error(`  ${canonicals.length} canonical restaurants (${enrichedCount} with googlePlaceId)`);

  const multiSource = canonicals.filter((c) => c.mentionCount > 1);
  console.error(`  ${multiSource.length} multi-source restaurants:`);
  for (const m of multiSource.slice(0, 10)) {
    const types = m.sources.map((s) => s.sourceType).sort();
    console.error(`    • ${m.restaurantName} — ${types.join(', ')}`);
  }

  // Always write a JSON report for eyeball review.
  const reportPath = path.resolve(__dirname, '../data/ingest-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(canonicals.map((c) => ({
    dedupKey: c.dedupKey,
    restaurantName: c.restaurantName,
    address: c.address,
    borough: c.borough,
    neighborhood: c.neighborhood,
    cuisineKey: c.cuisineKey,
    features: c.features,
    googlePlaceId: c.googlePlaceId,
    resyBookingUrl: c.resyBookingUrl,
    mentionCount: c.mentionCount,
    sources: c.sources.map((s) => ({
      sourceType: s.sourceType,
      sourceUrl: s.sourceUrl,
      sourceTitle: s.sourceTitle,
      author: s.author,
      authorQuote: s.authorQuote.slice(0, 300),
    })),
  })), null, 2));
  console.error(`\nwrote ${reportPath}`);

  if (DRY_RUN) {
    console.error('\n(dry-run — skipping DB writes)');
    return;
  }

  console.error('\n→ Writing to DB…');
  const stats = await writeToDb(canonicals);
  console.error(`  inserted ${stats.canonicalsInserted} canonical + ${stats.sourcesInserted} sources`);
  console.error(`  updated  ${stats.canonicalsUpdated} canonical`);
  console.error(`  skipped  ${stats.sourcesSkipped} duplicate source rows`);
  console.error('\ndone.');
}

main().catch((e) => {
  logger.error('ingest.failed', e);
  console.error('FATAL:', e);
  process.exit(1);
});
