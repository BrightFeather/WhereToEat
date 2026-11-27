import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../_lib/db';
import crypto from 'crypto';
import { logger, withRequestLogging } from '../_lib/logger';
import { ok, err } from '../_lib/types';
import { getBoroughNames } from '../_lib/cityRegions';

const FRESHNESS_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface XHSSource {
  postUrl: string;
  recommendation: string | null;
  likes: number;
  postCreatedAt: string | null;
  /** Polymorphic source type: 'xiaohongshu' | 'eater' | 'resy_blog'. */
  sourceType: string | null;
  /** Author / creator handle. XHS = creator name; Eater/Resy = editor byline. */
  author: string | null;
  /** Article / post title. Used as the byline subtitle on detail-page quotes. */
  sourceTitle: string | null;
}

interface WeeklyRestaurant {
  id: string;
  restaurantName: string;
  address: string | null;
  borough: string | null;
  neighborhood: string | null;
  cuisineType: string | null;
  recommendation: string | null;
  postUrl: string | null;
  postCreatedAt: string | null;
  mentionCount: number;
  totalLikes: number;
  googlePlaceId: string | null;
  googleMapsUrl: string | null;
  googleDisplayName: string | null;
  websiteUrl: string | null;
  photoUrl: string | null;
  photoUrls: string[];
  features: string[];
  /** Google Maps overall rating (e.g. 4.7) and # of reviews backing it. */
  googleRating: number | null;
  googleUserRatingCount: number | null;
  /** Best-effort Instagram profile URL — null when no link found on the
   *  restaurant's Google-Places-listed website. */
  instagramUrl: string | null;
  resyBookingUrl: string | null;
  opentableBookingUrl: string | null;
  /** Google Places New API `priceLevel` enum
   *  (`PRICE_LEVEL_INEXPENSIVE`/`MODERATE`/`EXPENSIVE`/`VERY_EXPENSIVE`).
   *  iOS maps to $/$$/$$$/$$$$ on the card. Null when Places hasn't
   *  classified the listing. */
  priceLevel: string | null;
  /** All XHS posts that mentioned this restaurant, sorted by likes DESC.
   *  Drives the multi-quote creator carousel on the card / detail view. */
  sources: XHSSource[];
}

// Recency-decayed ranking, computed in JS so the SQL stays dialect-portable
// across SQLite (local) and Postgres (cloud).
function score(row: Record<string, unknown>): number {
  const mention = Number(row.mentionCount ?? 0);
  const likes = Number(row.totalLikes ?? 0);
  const createdAt = row.postCreatedAt as string | null;

  let recency: number;
  if (!createdAt) {
    recency = 0.4;
  } else {
    const ageDays = (Date.now() - new Date(createdAt).getTime()) / MS_PER_DAY;
    if (ageDays <= 7) recency = 1.0;
    else if (ageDays >= 60) recency = 0.2;
    else recency = 1.0 - ((ageDays - 7) / 53.0) * 0.8;
  }
  return mention * 10 + likes * recency;
}

function sortByScore(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((a, b) => score(b) - score(a));
}

function parseRows(rows: Record<string, unknown>[]): WeeklyRestaurant[] {
  return rows.map((r) => ({
    ...(r as unknown as WeeklyRestaurant),
    photoUrls: r.photoUrls
      ? JSON.parse(r.photoUrls as string) as string[]
      : (r.photoUrl ? [r.photoUrl as string] : []),
    features: r.features ? (JSON.parse(r.features as string) as string[]) : [],
    sources: (r.sources as XHSSource[] | undefined) ?? [],
  }));
}

/** Every source row for the city's available restaurants, likes DESC.
 *  Keyed by the same WHERE as `fetchAvailable` so both run in parallel. */
async function fetchSources(city: string): Promise<Array<XHSSource & { restaurantId: string }>> {
  const rows = await sql`
    SELECT
      restaurant_id   AS "restaurantId",
      post_url        AS "postUrl",
      recommendation,
      likes,
      post_created_at AS "postCreatedAt",
      source_type     AS "sourceType",
      author,
      source_title    AS "sourceTitle"
    FROM xhs_sources
    WHERE restaurant_id IN (
      SELECT id FROM xhs_restaurants
      WHERE city = ${city}
        AND is_available_this_week = 1
        AND google_maps_url IS NOT NULL
    )
    ORDER BY likes DESC
  `;
  return rows as unknown as Array<XHSSource & { restaurantId: string }>;
}

function attachSources(
  rows: Record<string, unknown>[],
  sourceRows: Array<XHSSource & { restaurantId: string }>,
): Record<string, unknown>[] {
  const sourcesById = new Map<string, XHSSource[]>();
  for (const s of sourceRows) {
    const stripped: XHSSource = {
      postUrl: s.postUrl,
      recommendation: s.recommendation,
      likes: s.likes,
      postCreatedAt: s.postCreatedAt,
      sourceType: s.sourceType,
      author: s.author,
      sourceTitle: s.sourceTitle,
    };
    const list = sourcesById.get(s.restaurantId);
    if (list) list.push(stripped);
    else sourcesById.set(s.restaurantId, [stripped]);
  }
  for (const row of rows) {
    row.sources = sourcesById.get(row.id as string) ?? [];
  }
  return rows;
}

// Drops rows whose borough isn't in the canonical city→borough mapping. Used
// so e.g. an NYC user never sees a New Jersey or Hong Kong restaurant that
// slipped through Google Places enrichment.
function filterToCity(rows: Record<string, unknown>[], city: string): Record<string, unknown>[] {
  const allowed = new Set(getBoroughNames(city));
  if (allowed.size === 0) return rows;
  return rows.filter((r) => allowed.has(r.borough as string));
}

async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const city = (req.query.city as string) || 'nyc';
  logger.request('GET', '/api/restaurants/weekly', { city });

  // Etag = MD5 of the response-shape columns the client actually renders,
  // not MAX(updated_at). A backfill that only touches latitude/longitude /
  // price_level (which the response also exposes) bumps via those columns;
  // a backfill that touches an internal-only column (e.g. `updated_at`
  // bumped by a trigger) does not — keeping the edge cache stable.
  // **Important:** every column the iOS client renders MUST appear here
  // or the conditional cache will return 304 with stale data after a
  // backfill that only touched the missing column. price_level was
  // initially omitted; symptom was the $/$$/$$$/$$$$ chip not showing
  // up after the 2026-04-28 backfill.
  // Cross-dialect-safe: the projection is plain SQL; we hash in JS.
  const [etagCols, sourcesEtagCols] = await Promise.all([sql`
    SELECT id,
           photo_url,
           google_rating,
           google_user_rating_count,
           recommendation,
           features,
           instagram_url,
           resy_booking_url,
           opentable_booking_url,
           mention_count,
           total_likes,
           post_created_at,
           latitude,
           longitude,
           price_level
    FROM xhs_restaurants
    WHERE city = ${city} AND is_available_this_week = 1 AND google_maps_url IS NOT NULL
    ORDER BY id
  `, sql`
    SELECT restaurant_id, post_url, likes, source_type
    FROM xhs_sources
    ORDER BY restaurant_id, post_url
  `]);
  const etag = etagCols.length > 0
    ? '"' + crypto
        .createHash('md5')
        .update(JSON.stringify(etagCols))
        .update('|')
        .update(JSON.stringify(sourcesEtagCols))
        .digest('hex') + '"'
    : null;

  if (etag) {
    res.setHeader('ETag', etag);
    // Edge-cacheable: the body is identical for all NYC users in the same
    // etag window (no per-user fields), so it's safe to drop `private` and
    // let Vercel's CDN serve repeated requests. `s-maxage=300` keeps the
    // edge response for 5 minutes; `stale-while-revalidate=86400` lets it
    // serve stale responses for 24h while revalidating in the background.
    // Devices still revalidate via `If-None-Match` (max-age=0).
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400, must-revalidate');
    res.setHeader('Vary', 'Accept-Encoding');
    const ifNoneMatch = req.headers['if-none-match'];
    if (typeof ifNoneMatch === 'string' && ifNoneMatch === etag) {
      logger.success('weekly.not_modified', { city, etag });
      return res.status(304).end();
    }
  }

  // Every query below is independent, so they run as one parallel stage:
  // a cache-miss request costs two DB round-trips (etag, then this) instead
  // of one per query. Restaurants and sources are fetched for the whole
  // city; the latest-run filter is applied in JS.
  // Runs older than 10 minutes still flagged 'running' are timed-out
  // functions (Hobby caps duration at 60s): the UPDATE reaps them and the
  // running-run lookup ignores them, so the two don't need to be ordered.
  const staleRunCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const [latestRows, runningRows, cityRows, sourceRows] = await Promise.all([
    sql`
    SELECT id, completed_at
    FROM pipeline_runs
    WHERE city = ${city} AND status = 'completed'
    -- NULLS LAST: Postgres sorts NULL first under DESC, and Neon holds a
    -- legacy 'completed' run with NULL completed_at that would otherwise
    -- shadow every real run (SQLite sorts NULL last, so local never showed it).
    ORDER BY completed_at DESC NULLS LAST
    LIMIT 1
  `,
    sql`
    SELECT id, started_at
    FROM pipeline_runs
    WHERE city = ${city} AND status = 'running' AND started_at >= ${staleRunCutoff}
    ORDER BY started_at DESC
    LIMIT 1
  `,
    fetchAvailable(city),
    fetchSources(city),
    sql`
    UPDATE pipeline_runs
    SET status = 'failed',
        error_message = 'reaped: function exceeded execution window'
    WHERE city = ${city}
      AND status = 'running'
      AND started_at < ${staleRunCutoff}
  `,
  ]);
  const latestCompleted = latestRows[0];
  const runningRun = runningRows[0];

  const isFresh =
    latestCompleted &&
    Date.now() - new Date(latestCompleted.completed_at as string).getTime() <
      FRESHNESS_DAYS * MS_PER_DAY;

  // Serve the last completed run whenever one exists — even if a fresh
  // pipeline is currently running. Hobby-plan Vercel functions often time
  // out on the 5-minute pipeline, leaving stale `status='running'` rows in
  // the DB; we don't want that to lock the iOS client out of all data.
  if (latestCompleted) {
    const runRows = cityRows.filter((r) => String(r.pipelineRunId) === String(latestCompleted.id));
    // If latest run had no restaurants (e.g. rate-limited), fall back to all available
    const rows = runRows.length > 0 ? runRows : cityRows;
    for (const r of rows) delete r.pipelineRunId;
    const responseStatus = isFresh ? 'ready' : 'stale';
    logger.success(`weekly.served.${responseStatus}`, { city, count: rows.length, building: !!runningRun });
    return res.status(200).json(
      ok({
        status: responseStatus,
        etag,
        restaurants: parseRows(filterToCity(sortByScore(attachSources(rows, sourceRows)), city)),
        pipelineStartedAt: runningRun ? new Date(runningRun.started_at as string).toISOString() : undefined,
      })
    );
  }

  if (runningRun) {
    // No completed run yet — first ever build. Honest "building" state.
    logger.success('weekly.building', { city, runId: runningRun.id });
    return res.status(200).json(
      ok({
        status: 'building',
        pipelineStartedAt: new Date(runningRun.started_at as string).toISOString(),
      })
    );
  }

  logger.success('weekly.building.first', { city });
  return res.status(200).json(ok({ status: 'building' }));
}

async function fetchAvailable(city: string): Promise<Record<string, unknown>[]> {
  const rows = await sql`
    SELECT
      id,
      pipeline_run_id      AS "pipelineRunId",
      restaurant_name      AS "restaurantName",
      address,
      borough,
      neighborhood,
      cuisine_type         AS "cuisineType",
      recommendation,
      post_url             AS "postUrl",
      post_created_at      AS "postCreatedAt",
      mention_count        AS "mentionCount",
      total_likes          AS "totalLikes",
      google_place_id      AS "googlePlaceId",
      google_maps_url      AS "googleMapsUrl",
      google_display_name  AS "googleDisplayName",
      website_url          AS "websiteUrl",
      photo_url            AS "photoUrl",
      photo_urls           AS "photoUrls",
      features             AS "features",
      google_rating        AS "googleRating",
      google_user_rating_count AS "googleUserRatingCount",
      instagram_url        AS "instagramUrl",
      resy_booking_url     AS "resyBookingUrl",
      opentable_booking_url AS "opentableBookingUrl",
      latitude             AS "latitude",
      longitude            AS "longitude",
      price_level          AS "priceLevel"
    FROM xhs_restaurants
    WHERE city = ${city}
      AND is_available_this_week = 1
      AND google_maps_url IS NOT NULL
  `;
  return rows as Record<string, unknown>[];
}

export default withRequestLogging(handler);
