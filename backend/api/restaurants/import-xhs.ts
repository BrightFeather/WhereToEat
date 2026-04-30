import type { VercelRequest, VercelResponse } from '@vercel/node';
import { readNote } from '../_lib/xhsScraper';
import { extractRestaurantData } from '../_lib/llmExtractor';
import { enrichWithPlaces } from '../_lib/placesEnricher';
import * as resy from '../_lib/resy';
import * as opentable from '../_lib/opentable';
import { logger, withRequestLogging } from '../_lib/logger';
import { ok, err } from '../_lib/types';
import type { RawXhsPost } from '../_lib/xhsScraper';
import { canonicalizeFeatures, type FeatureKey } from '../_lib/features';
import type { CuisineKey } from '../_lib/cuisines';

const PLACES_DELAY_MS = 200;
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface ImportSource {
  postUrl: string;
  recommendation: string | null;
  likes: number;
  postCreatedAt: string | null;
  sourceType: string | null;
  author: string | null;
  sourceTitle: string | null;
}

interface ImportedRestaurant {
  name: string;
  address: string | null;
  borough: string | null;
  neighborhood: string | null;
  cuisineKey: CuisineKey | null;
  features: FeatureKey[];
  /** Denormalised "best snippet" — kept for client back-compat. */
  recommendation: string | null;
  /** Per-post source evidence. Always at least one entry — the originating
   *  XHS post the user pasted. Mirrors the shape returned by `weekly.ts`. */
  sources: ImportSource[];
  googlePlaceId: string | null;
  googleMapsUrl: string | null;
  photoUrls: string[];
  websiteUrl: string | null;
  googleRating: number | null;
  googleUserRatingCount: number | null;
  instagramUrl: string | null;
  resyBookingUrl: string | null;
  opentableBookingUrl: string | null;
  priceLevel: string | null;
}

async function resolveXhsUrl(rawUrl: string): Promise<{ noteId: string; xsecToken?: string; fullUrl: string }> {
  // Use redirect: 'manual' to capture the Location header without hitting xiaohongshu.com
  // This avoids triggering XHS captcha from the redirect itself
  const response = await fetch(rawUrl, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'User-Agent': BROWSER_UA },
  });
  let finalUrl = response.headers.get('location') || response.url;
  // If first redirect goes to another short URL, follow it
  if (finalUrl && !finalUrl.includes('xiaohongshu.com')) {
    const r2 = await fetch(finalUrl, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': BROWSER_UA } });
    finalUrl = r2.headers.get('location') || r2.url;
  }

  // Extract noteId from /explore/<noteId> or /discovery/item/<noteId>
  const match = finalUrl.match(/(?:explore|discovery\/item)\/([a-f0-9]{24})/);
  if (match) {
    // Extract xsec_token from query params (required for some posts)
    const urlObj = new URL(finalUrl);
    const xsecToken = urlObj.searchParams.get('xsec_token') ?? undefined;
    return { noteId: match[1], xsecToken, fullUrl: finalUrl };
  }

  // Also try the original URL in case redirect didn't work
  const origMatch = rawUrl.match(/(?:explore|discovery\/item)\/([a-f0-9]{24})/);
  if (origMatch) {
    return { noteId: origMatch[1], fullUrl: rawUrl };
  }

  throw new Error(`Could not extract note ID from URL: ${finalUrl}`);
}

async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const { url } = req.body ?? {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json(err('Missing "url" in request body', 'MISSING_URL'));
  }

  logger.request('POST', '/api/restaurants/import-xhs', { url });

  try {
    // Step 1: Resolve short link → full XHS URL → noteId + xsec_token
    const { noteId, xsecToken, fullUrl } = await resolveXhsUrl(url);
    logger.success('import-xhs.resolved', { noteId, xsecToken: !!xsecToken, fullUrl });

    // Step 2: Read the post via xhs CLI (xsec_token required for some posts)
    const note = await readNote(noteId, xsecToken);
    if (!note?.note_card) {
      return res.status(404).json(err('Could not read XHS post', 'POST_NOT_FOUND'));
    }

    const { title = '', desc = '', time, interact_info } = note.note_card;
    const likes = parseLikeCount(interact_info?.liked_count);
    const createdAt = time ? new Date(time).toISOString() : new Date().toISOString();
    logger.success('import-xhs.note_card', { title, descLen: desc.length, likes, time });

    const post: RawXhsPost = {
      noteId,
      title,
      body: desc,
      likes,
      postUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
      createdAt,
    };
    logger.success('import-xhs.post_read', { noteId, title, bodyLen: desc.length });

    // Step 3: LLM extraction — get all restaurants mentioned
    logger.success('import-xhs.llm_start', { title, bodyLen: desc.length, bodyPreview: desc.substring(0, 100) });
    const extracted = await extractRestaurantData(post);
    logger.success('import-xhs.llm_done', { count: extracted.length });
    if (!extracted.length) {
      return res.json(ok({ postTitle: title, postUrl: post.postUrl, restaurants: [] }));
    }
    logger.success('import-xhs.extracted', { count: extracted.length });

    // Step 4: Enrich each restaurant with Google Places + Resy + OpenTable
    const restaurants: ImportedRestaurant[] = [];

    for (let i = 0; i < extracted.length; i++) {
      const r = extracted[i];
      const places = await enrichWithPlaces(r);

      let resyBookingUrl: string | null = null;
      let opentableBookingUrl: string | null = null;

      // Try Resy/OpenTable lookups with 8s timeout each — skip on error or timeout
      const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
        Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

      try {
        if (places?.googleMapsUrl) {
          const resyMatch = await withTimeout(resy.findVenue(r.restaurantName, 40.7128, -74.006), 8000);
          if (resyMatch) resyBookingUrl = resyMatch.bookingUrl;
        }
      } catch { /* skip */ }

      try {
        const otMatch = await withTimeout(opentable.findVenue(r.restaurantName), 8000);
        if (otMatch) opentableBookingUrl = otMatch.bookingUrl;
      } catch { /* skip */ }

      // Cuisine: trust Places when it recognised a `<foo>_restaurant` type,
      // else use the LLM's classification. Features: union Places signals
      // (coffee / brunch / bakery / …) with LLM-extracted sub-cuisines.
      const cuisineKey = places?.cuisineKey ?? r.cuisineKey ?? null;
      const features = canonicalizeFeatures([
        ...(places?.features ?? []),
        ...(r.features ?? []),
      ]);

      // Single-post import — only the pasted XHS post mentions this restaurant
      // right now. Shape mirrors `weekly.ts` so the iOS client can treat
      // import + pipeline output identically.
      const sources: ImportSource[] = [
        {
          postUrl: post.postUrl,
          recommendation: r.creatorRecommendation,
          likes: post.likes,
          postCreatedAt: post.createdAt,
          sourceType: 'xiaohongshu',
          author: null,
          sourceTitle: post.title || null,
        },
      ];

      restaurants.push({
        name: places?.googleDisplayName || r.restaurantName,
        address: places?.address || r.address,
        borough: places?.borough ?? null,
        neighborhood: places?.neighborhood ?? r.locationHint,
        cuisineKey,
        features,
        recommendation: r.creatorRecommendation,
        sources,
        googlePlaceId: places?.googlePlaceId ?? null,
        googleMapsUrl: places?.googleMapsUrl ?? null,
        photoUrls: places?.photoUrls ?? [],
        websiteUrl: places?.websiteUrl ?? null,
        googleRating: places?.googleRating ?? null,
        googleUserRatingCount: places?.googleUserRatingCount ?? null,
        instagramUrl: places?.instagramUrl ?? null,
        resyBookingUrl,
        opentableBookingUrl,
        priceLevel: places?.priceLevel ?? null,
      });

      if (i < extracted.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, PLACES_DELAY_MS));
      }
    }

    logger.success('import-xhs.complete', {
      noteId,
      restaurantCount: restaurants.length,
      enrichedCount: restaurants.filter((r) => r.googlePlaceId).length,
    });

    return res.json(ok({ postTitle: title, postUrl: post.postUrl, restaurants }));
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Import failed';
    logger.error('import-xhs.failed', e, { url });
    return res.status(500).json(err(message, 'IMPORT_ERROR'));
  }
}

function parseLikeCount(raw: string | undefined): number {
  if (!raw) return 0;
  const s = raw.trim();
  if (s.includes('万')) return Math.round(parseFloat(s) * 10000);
  return parseInt(s, 10) || 0;
}

export default withRequestLogging(handler);
