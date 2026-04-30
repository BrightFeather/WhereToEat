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

/**
 * Hydrate each row with its per-post xhs_sources entries, sorted by likes
 * DESC. **One** SQL round-trip regardless of row count.
 *
 * The tagged template can't accept a runtime-built `IN (...)` cleanly, so
 * we synthesize a TemplateStringsArray on the fly: one fragment per
 * placeholder. The result is a normal parameterized query — `$1, $2, ...`
 * on Neon, `?, ?, ...` on SQLite — driven through the same `sql` API
 * everything else uses.
 */
async function hydrateSources(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return rows;

  const ids = rows.map((r) => r.id).filter((id): id is string => typeof id === 'string');
  if (ids.length === 0) {
    for (const r of rows) r.sources = [];
    return rows;
  }

  // Build strings for the tagged template:
  //   strings[0]   = "<SELECT ... IN ("
  //   strings[1..N-1] = ","
  //   strings[N]   = ") ORDER BY likes DESC"
  const head = `
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
    WHERE restaurant_id IN (`;
  const tail = `) ORDER BY likes DESC`;
  const stringsArr: string[] = [head];
  for (let i = 1; i < ids.length; i++) stringsArr.push(',');
  stringsArr.push(tail);
  const tsa = Object.assign(stringsArr, { raw: stringsArr.slice() }) as unknown as TemplateStringsArray;
  const sourceRows = (await sql(tsa, ...ids)) as unknown as Array<XHSSource & { restaurantId: string }>;

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
  const etagCols = await sql`
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
    WHERE is_available_this_week = 1 AND google_maps_url IS NOT NULL
    ORDER BY id
  `;
  const sourcesEtagCols = await sql`
    SELECT restaurant_id, post_url, likes, source_type
    FROM xhs_sources
    ORDER BY restaurant_id, post_url
  `;
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

  // Log top 10 restaurants in DB for debugging
  const allForDebug = await sql`
    SELECT restaurant_name AS "restaurantName", google_display_name AS "googleDisplayName",
           mention_count AS "mentionCount", total_likes AS "totalLikes",
           post_created_at AS "postCreatedAt",
           is_available_this_week AS "isAvailable", google_maps_url AS "googleMapsUrl"
    FROM xhs_restaurants
  `;
  const top10 = sortByScore(allForDebug as Record<string, unknown>[]).slice(0, 10);
  if (top10.length > 0) {
    console.log(`[weekly] Top ${top10.length} restaurants in DB:`);
    top10.forEach((r, i) => {
      const name = (r.googleDisplayName as string) || (r.restaurantName as string);
      const available = r.isAvailable ? '✓' : '✗';
      const mapped = r.googleMapsUrl ? '📍' : '  ';
      console.log(`  ${i + 1}. ${mapped}${available} ${name} (score: ${score(r).toFixed(1)})`);
    });
  }

  // Find the most recent completed run
  const [latestCompleted] = await sql`
    SELECT id, completed_at
    FROM pipeline_runs
    WHERE city = ${city} AND status = 'completed'
    ORDER BY completed_at DESC
    LIMIT 1
  `;

  const isFresh =
    latestCompleted &&
    Date.now() - new Date(latestCompleted.completed_at as string).getTime() <
      FRESHNESS_DAYS * MS_PER_DAY;

  // Reap stale `running` rows older than 10 minutes — Vercel Hobby caps
  // function duration at 60s, so any run still flagged 'running' past that
  // window is a timed-out function whose DB row never got cleaned up.
  await sql`
    UPDATE pipeline_runs
    SET status = 'failed',
        error_message = 'reaped: function exceeded execution window'
    WHERE city = ${city}
      AND status = 'running'
      AND started_at < ${new Date(Date.now() - 10 * 60 * 1000).toISOString()}
  `;

  // Check if a run is currently in progress
  const [runningRun] = await sql`
    SELECT id, started_at
    FROM pipeline_runs
    WHERE city = ${city} AND status = 'running'
    ORDER BY started_at DESC
    LIMIT 1
  `;

  // Serve the last completed run whenever one exists — even if a fresh
  // pipeline is currently running. Hobby-plan Vercel functions often time
  // out on the 5-minute pipeline, leaving stale `status='running'` rows in
  // the DB; we don't want that to lock the iOS client out of all data.
  if (latestCompleted) {
    let rows = await fetchAvailable({ pipelineRunId: latestCompleted.id as string });
    // If latest run had no restaurants (e.g. rate-limited), fall back to all available
    if (rows.length === 0) {
      rows = await fetchAvailable({ pipelineRunId: null });
    }
    const responseStatus = isFresh ? 'ready' : 'stale';
    logger.success(`weekly.served.${responseStatus}`, { city, count: rows.length, building: !!runningRun });
    return res.status(200).json(
      ok({
        status: responseStatus,
        etag,
        restaurants: parseRows(filterToCity(sortByScore(await hydrateSources(rows)), city)),
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

  // No fresh run and nothing in progress. The HTTP-triggered pipeline route
  // is archived (we run the pipeline locally and push to Neon), so we just
  // serve whatever's available rather than auto-triggering on a 404 endpoint.
  if (latestCompleted) {
    const rows = await fetchAvailable({ pipelineRunId: null });
    logger.success('weekly.served.stale', { city, count: rows.length });
    return res.status(200).json(
      ok({
        status: 'stale',
        etag,
        restaurants: parseRows(filterToCity(sortByScore(await hydrateSources(rows)), city)),
      })
    );
  }

  logger.success('weekly.building.first', { city });
  return res.status(200).json(ok({ status: 'building' }));
}

async function fetchAvailable(opts: { pipelineRunId: string | null }): Promise<Record<string, unknown>[]> {
  const rows = opts.pipelineRunId
    ? await sql`
        SELECT
          id,
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
        WHERE pipeline_run_id = ${opts.pipelineRunId}
          AND is_available_this_week = 1
          AND google_maps_url IS NOT NULL
      `
    : await sql`
        SELECT
          id,
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
        WHERE is_available_this_week = 1
          AND google_maps_url IS NOT NULL
      `;
  return rows as Record<string, unknown>[];
}

export default withRequestLogging(handler);
