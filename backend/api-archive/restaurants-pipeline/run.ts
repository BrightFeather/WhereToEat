import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'crypto';
import { put } from '@vercel/blob';
import { sql } from '../../_lib/db';
import { searchXhsPosts, buildXhsCookieHeader } from '../../_lib/xhsScraper';
import { extractBatch } from '../../_lib/llmExtractor';
import { enrichWithPlaces } from '../../_lib/placesEnricher';
import { deduplicateAndRank, type EnrichedRestaurant } from '../../_lib/restaurantMerger';
import { logger, withRequestLogging } from '../../_lib/logger';
import { ok, err } from '../../_lib/types';

const CITY = 'nyc';
const XHS_HASHTAG = '#纽约美食';
const MAX_PAGES = 10;
// Delay between Places API calls to avoid rate limits
const PLACES_DELAY_MS = 200;

// Prefer the named public store; the default BLOB_READ_WRITE_TOKEN may point
// at a stale private store from an earlier attempt.
const BLOB_TOKEN =
  process.env.RESTAURANT_PHOTOS_READ_WRITE_TOKEN ||
  process.env.BLOB_READ_WRITE_TOKEN;

async function uploadOne(remoteUrl: string, key: string): Promise<string | null> {
  if (!BLOB_TOKEN) return null;
  try {
    const response = await fetch(remoteUrl);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const blob = await put(`photos/${key}.jpg`, buffer, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      token: BLOB_TOKEN,
    });
    return blob.url;
  } catch (e) {
    logger.warn('photo.upload.failed', { key, error: String(e) });
    return null;
  }
}

// For each remote (Google Places) URL, upload the bytes to Vercel Blob and
// return the Blob URL. Falls back to the original remote URL if the upload
// fails, so the result is never worse than the input.
async function uploadPhotos(remoteUrls: string[], placeId: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < remoteUrls.length; i++) {
    const blobUrl = await uploadOne(remoteUrls[i], `${placeId}_${i}`);
    out.push(blobUrl ?? remoteUrls[i]);
  }
  return out;
}

async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel cron triggers come in as GET; our local invokers (weekly.ts,
  // run-pipeline.sh) POST. Accept both so the same endpoint serves both paths.
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  // Auth: Vercel cron sends the Vercel-Cron header + a bearer that matches
  // CRON_SECRET. Local invokers send x-cron-secret directly. Accept either.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const bearer = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    const provided = req.headers['x-cron-secret'] ?? bearer;
    const isVercelCron = req.headers['x-vercel-cron'] === '1' || req.headers['user-agent']?.includes('vercel-cron');
    if (provided !== cronSecret && !isVercelCron) {
      return res.status(401).json(err('Unauthorized', 'UNAUTHORIZED'));
    }
  }

  // Warn (but don't fail) when XHS cookies aren't configured on Vercel —
  // anonymous search returns empty so the run would produce zero posts.
  if (process.env.VERCEL === '1' && !buildXhsCookieHeader()) {
    logger.warn('pipeline.xhs_cookies.missing', {
      hint: 'Set XHS_WEB_SESSION / XHS_A1 / XHS_WEBID in Vercel env for HTTP scrape to return results.',
    });
  }

  if (!BLOB_TOKEN) {
    logger.warn('pipeline.blob_token.missing', {
      hint: 'Photos will fall back to Google Places URLs.',
    });
  }

  // Check if a run is already in progress
  const [existing] = await sql`
    SELECT id, status FROM pipeline_runs
    WHERE city = ${CITY} AND status = 'running'
    ORDER BY started_at DESC
    LIMIT 1
  `;
  if (existing) {
    logger.warn('pipeline.already_running', { runId: existing.id });
    return res.status(409).json(err('Pipeline already running', 'ALREADY_RUNNING'));
  }

  // Create a run record
  const runId = randomUUID();
  await sql`
    INSERT INTO pipeline_runs (id, city, status)
    VALUES (${runId}, ${CITY}, 'running')
  `;
  logger.success('pipeline.started', { runId, city: CITY });

  // Respond immediately — pipeline runs async via waitUntil so the function
  // doesn't return before the background work has a chance to kick off.
  // Note: on Vercel Hobby, function wall time is capped (60s default); full
  // runs exceed that. Either upgrade to Fluid Compute / Pro (maxDuration up
  // to 300s) or chunk this work into smaller tick endpoints.
  res.status(202).json(ok({ runId, status: 'running' }));

  runPipeline(runId).catch((e) => {
    logger.error('pipeline.unhandled_error', e, { runId });
  });
}

async function runPipeline(runId: string) {
  try {
    // Step 1: scrape XHS — HTTP on Vercel (needs XHS_* cookies), CLI locally
    logger.success('pipeline.scrape.start', { runId });
    const rawPosts = await searchXhsPosts(XHS_HASHTAG, MAX_PAGES);
    logger.success('pipeline.scrape.done', { runId, postCount: rawPosts.length });

    // Step 2: LLM extraction
    logger.success('pipeline.extract.start', { runId });
    const extracted = await extractBatch(rawPosts);
    logger.success('pipeline.extract.done', { runId, extracted: extracted.length });

    // Step 3: Google Places enrichment + Blob photo upload
    logger.success('pipeline.enrich.start', { runId, count: extracted.length });
    const enriched: EnrichedRestaurant[] = [];
    for (let i = 0; i < extracted.length; i++) {
      const restaurant = extracted[i];
      const places = await enrichWithPlaces(restaurant);

      if (places?.photoUrls.length && places.googlePlaceId) {
        const blobUrls = await uploadPhotos(places.photoUrls, places.googlePlaceId);
        places.photoUrls = blobUrls;
        places.photoUrl = blobUrls[0] ?? null;
        logger.success('photos.saved', { placeId: places.googlePlaceId, count: blobUrls.length });
      }

      enriched.push({ ...restaurant, places });
      if (i < extracted.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, PLACES_DELAY_MS));
      }
    }
    const enrichedCount = enriched.filter((r) => r.places).length;
    logger.success('pipeline.enrich.done', { runId, enriched: enrichedCount, total: enriched.length });

    // Step 4: deduplicate + rank
    const restaurants = deduplicateAndRank(enriched);
    logger.success('pipeline.merge.done', { runId, restaurants: restaurants.length });

    // Step 5: upsert xhs_restaurants keyed on (city, google_place_id) so the
    // row id is stable across weekly runs. Rows without a Places hit fall
    // back to a fresh INSERT — the partial unique index lets the conflict
    // target apply only when google_place_id is set.
    for (const r of restaurants) {
      const newId = randomUUID();
      const featuresJson = r.features.length ? JSON.stringify(r.features) : null;
      const photosJson = r.photoUrls.length ? JSON.stringify(r.photoUrls) : null;
      let restaurantId: string = newId;

      if (r.googlePlaceId) {
        // Upsert on the partial unique index. RETURNING id gives us the
        // stable row id regardless of whether this was an insert or update.
        const rows = await sql`
          INSERT INTO xhs_restaurants (
            id, city, restaurant_name, address, borough, neighborhood, cuisine_type, features,
            recommendation, post_url, post_created_at,
            mention_count, total_likes,
            google_place_id, google_maps_url, google_display_name, website_url, photo_url, photo_urls,
            google_rating, google_user_rating_count, instagram_url, latitude, longitude,
            pipeline_run_id
          ) VALUES (
            ${newId}, ${CITY}, ${r.restaurantName}, ${r.address}, ${r.borough}, ${r.neighborhood},
            ${r.cuisineKey}, ${featuresJson},
            ${r.recommendation}, ${r.postUrl}, ${r.postCreatedAt ?? null},
            ${r.mentionCount}, ${r.totalLikes},
            ${r.googlePlaceId}, ${r.googleMapsUrl}, ${r.googleDisplayName}, ${r.websiteUrl},
            ${r.photoUrl}, ${photosJson},
            ${r.googleRating}, ${r.googleUserRatingCount}, ${r.instagramUrl},
            ${r.latitude}, ${r.longitude},
            ${runId}
          )
          ON CONFLICT (city, google_place_id) WHERE google_place_id IS NOT NULL DO UPDATE SET
            restaurant_name     = EXCLUDED.restaurant_name,
            address             = COALESCE(EXCLUDED.address, xhs_restaurants.address),
            borough             = COALESCE(EXCLUDED.borough, xhs_restaurants.borough),
            neighborhood        = COALESCE(EXCLUDED.neighborhood, xhs_restaurants.neighborhood),
            cuisine_type        = COALESCE(EXCLUDED.cuisine_type, xhs_restaurants.cuisine_type),
            features            = EXCLUDED.features,
            recommendation      = EXCLUDED.recommendation,
            post_url            = EXCLUDED.post_url,
            post_created_at     = EXCLUDED.post_created_at,
            mention_count       = EXCLUDED.mention_count,
            total_likes         = EXCLUDED.total_likes,
            google_maps_url     = COALESCE(EXCLUDED.google_maps_url, xhs_restaurants.google_maps_url),
            google_display_name = COALESCE(EXCLUDED.google_display_name, xhs_restaurants.google_display_name),
            website_url         = COALESCE(EXCLUDED.website_url, xhs_restaurants.website_url),
            photo_url           = COALESCE(EXCLUDED.photo_url, xhs_restaurants.photo_url),
            photo_urls          = COALESCE(EXCLUDED.photo_urls, xhs_restaurants.photo_urls),
            google_rating              = COALESCE(EXCLUDED.google_rating, xhs_restaurants.google_rating),
            google_user_rating_count   = COALESCE(EXCLUDED.google_user_rating_count, xhs_restaurants.google_user_rating_count),
            instagram_url              = COALESCE(EXCLUDED.instagram_url, xhs_restaurants.instagram_url),
            latitude                   = COALESCE(EXCLUDED.latitude,  xhs_restaurants.latitude),
            longitude                  = COALESCE(EXCLUDED.longitude, xhs_restaurants.longitude),
            pipeline_run_id     = EXCLUDED.pipeline_run_id
          RETURNING id
        `;
        restaurantId = (rows as Array<{ id: string }>)[0]?.id ?? newId;
      } else {
        await sql`
          INSERT INTO xhs_restaurants (
            id, city, restaurant_name, address, borough, neighborhood, cuisine_type, features,
            recommendation, post_url, post_created_at,
            mention_count, total_likes,
            google_place_id, google_maps_url, google_display_name, website_url, photo_url, photo_urls,
            google_rating, google_user_rating_count, instagram_url, latitude, longitude,
            pipeline_run_id
          ) VALUES (
            ${newId}, ${CITY}, ${r.restaurantName}, ${r.address}, ${r.borough}, ${r.neighborhood},
            ${r.cuisineKey}, ${featuresJson},
            ${r.recommendation}, ${r.postUrl}, ${r.postCreatedAt ?? null},
            ${r.mentionCount}, ${r.totalLikes},
            ${null}, ${r.googleMapsUrl}, ${r.googleDisplayName}, ${r.websiteUrl},
            ${r.photoUrl}, ${photosJson},
            ${r.googleRating}, ${r.googleUserRatingCount}, ${r.instagramUrl},
            ${r.latitude}, ${r.longitude},
            ${runId}
          )
        `;
      }

      // Step 5b: persist every post that mentioned this restaurant. Upsert
      // on (restaurant_id, post_url) so a post re-surfacing in a later run
      // just refreshes likes / recommendation instead of duplicating.
      for (const src of r.sources) {
        await sql`
          INSERT INTO xhs_sources (
            id, restaurant_id, post_url, recommendation, likes, post_created_at
          ) VALUES (
            ${randomUUID()}, ${restaurantId}, ${src.postUrl},
            ${src.recommendation}, ${src.likes}, ${src.postCreatedAt}
          )
          ON CONFLICT (restaurant_id, post_url) DO UPDATE SET
            recommendation  = COALESCE(EXCLUDED.recommendation, xhs_sources.recommendation),
            likes           = CASE WHEN EXCLUDED.likes > xhs_sources.likes
                                   THEN EXCLUDED.likes ELSE xhs_sources.likes END,
            post_created_at = COALESCE(EXCLUDED.post_created_at, xhs_sources.post_created_at)
        `;
      }
    }

    await sql`
      UPDATE pipeline_runs
      SET status = 'completed',
          completed_at = ${new Date().toISOString()},
          post_count = ${rawPosts.length},
          restaurant_count = ${restaurants.length}
      WHERE id = ${runId}
    `;
    logger.success('pipeline.completed', { runId, restaurants: restaurants.length });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('pipeline.failed', e, { runId });
    await sql`
      UPDATE pipeline_runs
      SET status = 'failed',
          completed_at = ${new Date().toISOString()},
          error_message = ${message}
      WHERE id = ${runId}
    `.catch(() => {}); // best-effort
  }
}

export default withRequestLogging(handler);
