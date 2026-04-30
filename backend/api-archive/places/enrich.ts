import { VercelRequest, VercelResponse } from '@vercel/node';
import { searchPlace, mapTypesToCuisine } from '../_lib/googlePlaces';
import { searchBusinesses, getBusinessDetails, priceStringToLevel } from '../_lib/yelp';
import { ok, err, EnrichedRestaurant, ReviewDTO } from '../_lib/types';
import * as resyLib from '../_lib/resy';
import * as opentableLib from '../_lib/opentable';
import { logger, withRequestLogging } from '../_lib/logger';

async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const { name, lat, lng } = req.query;
  if (!name || !lat || !lng) {
    return res.status(400).json(err('Missing name, lat, or lng', 'BAD_REQUEST'));
  }

  const latitude = parseFloat(lat as string);
  const longitude = parseFloat(lng as string);

  logger.request('GET', '/api/places/enrich', { name, lat, lng });

  try {
    // Run Google Places + Yelp in parallel
    const [googleResult, yelpResults] = await Promise.all([
      searchPlace(name as string, latitude, longitude),
      searchBusinesses(latitude, longitude, undefined, 5),
    ]);

    logger.success('places.enrich.sources_fetched', {
      name,
      googleFound: !!googleResult,
      yelpCount: yelpResults.length,
    });

    // Find best Yelp match by name similarity
    const yelpMatch = yelpResults.find((b) =>
      normalize(b.name).includes(normalize(name as string)) ||
      normalize(name as string).includes(normalize(b.name))
    ) ?? yelpResults[0];

    // Fetch Yelp details if match found
    const yelpDetails = yelpMatch ? await getBusinessDetails(yelpMatch.id) : null;

    // Merge data — prefer Google for address/coordinates/hours
    const merged: EnrichedRestaurant = {
      name: googleResult?.name ?? yelpMatch?.name ?? (name as string),
      address: googleResult?.address ?? yelpMatch?.address ?? '',
      latitude: googleResult?.latitude ?? yelpMatch?.latitude ?? latitude,
      longitude: googleResult?.longitude ?? yelpMatch?.longitude ?? longitude,
      cuisineTags: googleResult
        ? mapTypesToCuisine(googleResult.types)
        : (yelpMatch?.categories ?? []).map((c) => c.replace(/_/g, '-')),
      dietaryTags: inferDietaryTags(googleResult?.types ?? [], yelpMatch?.categories ?? []),
      priceRange: googleResult?.priceLevel ?? priceStringToLevel(yelpMatch?.price),
      photos: dedupeUrls([
        ...(googleResult?.photos ?? []),
        ...(yelpDetails?.photos ?? yelpMatch?.photos ?? []),
      ]).slice(0, 10),
      rating: googleResult?.rating ?? yelpMatch?.rating,
      reviewCount: googleResult?.reviewCount ?? yelpMatch?.reviewCount,
      reviews: mergeReviews(googleResult?.reviews ?? [], yelpDetails?.reviews ?? []),
      hours: googleResult?.hours ?? [],
      phone: googleResult?.phone ?? yelpMatch?.phone,
      website: googleResult?.website ?? yelpMatch?.url,
      reservationSource: await detectReservationSource(
        name as string,
        latitude,
        longitude
      ),
    };

    logger.success('places.enrich.complete', {
      name: merged.name,
      reservationSource: merged.reservationSource?.platform ?? 'none',
      photoCount: merged.photos.length,
    });

    return res.status(200).json(ok(merged));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Enrichment failed';
    logger.error('places.enrich.failed', e, { name, lat, lng });
    return res.status(500).json(err(message, 'ENRICH_ERROR'));
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function dedupeUrls(urls: string[]): string[] {
  return [...new Set(urls)].filter(Boolean);
}

function mergeReviews(google: ReviewDTO[], yelp: ReviewDTO[]): ReviewDTO[] {
  // Take up to 3 from each, interleaved
  const result: ReviewDTO[] = [];
  const max = Math.max(google.length, yelp.length);
  for (let i = 0; i < max && result.length < 6; i++) {
    if (i < google.length) result.push(google[i]);
    if (i < yelp.length) result.push(yelp[i]);
  }
  return result.slice(0, 6);
}

function inferDietaryTags(types: string[], yelpCategories: string[]): string[] {
  const tags: string[] = [];
  const all = [...types, ...yelpCategories].map((t) => t.toLowerCase());

  if (all.some((t) => t.includes('vegan'))) tags.push('vegan', 'vegetarian');
  else if (all.some((t) => t.includes('vegetarian'))) tags.push('vegetarian');
  if (all.some((t) => t.includes('halal'))) tags.push('halal');
  if (all.some((t) => t.includes('kosher'))) tags.push('kosher');
  if (all.some((t) => t.includes('gluten'))) tags.push('gluten_free');

  return tags;
}

async function detectReservationSource(
  name: string,
  lat: number,
  lng: number
): Promise<EnrichedRestaurant['reservationSource']> {
  // Try Resy first
  try {
    const match = await resyLib.findVenue(name, lat, lng);
    if (match && match.bookingUrl) {
      logger.success('places.enrich.reservation_source_detected', {
        name, platform: 'resy', venueId: match.venueId, bookingUrl: match.bookingUrl,
      });
      return {
        platform: 'resy',
        venueId: match.venueId,
        directBookingURL: match.bookingUrl,
      };
    }
  } catch {
    logger.warn('places.enrich.resy_lookup_failed', { name });
  }

  // Try OpenTable
  try {
    const otMatch = await opentableLib.findVenue(name);
    if (otMatch) {
      logger.success('places.enrich.reservation_source_detected', {
        name, platform: 'opentable', rid: otMatch.rid, bookingUrl: otMatch.bookingUrl,
      });
      return {
        platform: 'opentable',
        venueId: String(otMatch.rid),
        directBookingURL: otMatch.bookingUrl,
      };
    }
  } catch {
    logger.warn('places.enrich.opentable_lookup_failed', { name });
  }

  return undefined;
}
export default withRequestLogging(handler);
