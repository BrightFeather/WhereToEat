import axios from 'axios';
import { logger } from './logger';
import type { ExtractedRestaurant } from './llmExtractor';
import type { CuisineKey } from './cuisines';
import {
  canonicalizeFeatures,
  featuresFromPlacesServes,
  featuresFromPlacesType,
  type FeatureKey,
} from './features';

export interface PlacesResult {
  googlePlaceId: string;
  googleMapsUrl: string;
  googleDisplayName: string;
  address: string | null;
  borough: string | null;         // Manhattan / Brooklyn / Queens / Bronx / Staten Island
  neighborhood: string | null;    // specific NYC neighborhood (e.g. Long Island City, Chinatown)
  websiteUrl: string | null;
  reservable: boolean;
  photoUrl: string | null;        // first photo (kept for backward compat)
  photoUrls: string[];            // up to 5 photos
  /** Cuisine key derived from Places primaryType when Places recognises one
   *  of its `<foo>_restaurant` buckets. Null for generic `restaurant`. */
  cuisineKey: CuisineKey | null;
  /** Feature keys derived from Places primaryType + serves* flags. */
  features: FeatureKey[];
  /** Google Maps overall rating, e.g. 4.7. Null when Places returns no rating
   *  (rare — usually only for very-new listings with zero reviews). */
  googleRating: number | null;
  /** Number of user reviews backing the rating — useful to avoid surfacing
   *  "5.0★ (3 reviews)" as if it were equivalent to "4.6★ (2k reviews)". */
  googleUserRatingCount: number | null;
  /** Best-effort Instagram profile URL scraped from `websiteUri`. Null when
   *  the website doesn't link to IG or the fetch failed (we never block
   *  enrichment on this — it's purely additive). */
  instagramUrl: string | null;
  /** WGS84 latitude in degrees. Drives the Find-tab map pin. Null when
   *  Places returns no `location` field (rare). */
  latitude: number | null;
  /** WGS84 longitude in degrees. */
  longitude: number | null;
  /** Places New API `priceLevel` enum (e.g. `PRICE_LEVEL_VERY_EXPENSIVE`)
   *  when set; otherwise null. Maps to $ / $$ / $$$ / $$$$ on the card. */
  priceLevel: string | null;
}

interface AddressComponent {
  longText: string;
  shortText: string;
  types: string[];
}

const NYC_BOROUGHS = new Set(['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island']);

// Extracts a neighborhood-like label from Google addressComponents.
// Preference: neighborhood > sublocality_level_2 > sublocality (excluding borough-level).
export function extractNeighborhood(components: AddressComponent[] | undefined): string | null {
  if (!components?.length) return null;
  const byType = (type: string) => components.find((c) => c.types?.includes(type))?.longText;
  const candidates = [
    byType('neighborhood'),
    byType('sublocality_level_2'),
    byType('sublocality'),
  ].filter((v): v is string => !!v && !NYC_BOROUGHS.has(v));
  return candidates[0] ?? null;
}

// Extracts NYC borough from Google addressComponents.
// In NYC's Google data, sublocality_level_1 is the borough ("Manhattan", "Brooklyn", etc.).
export function extractBorough(components: AddressComponent[] | undefined): string | null {
  if (!components?.length) return null;
  const byType = (type: string) => components.find((c) => c.types?.includes(type))?.longText;
  const subloc = byType('sublocality_level_1');
  if (subloc && NYC_BOROUGHS.has(subloc === 'The Bronx' ? 'Bronx' : subloc)) {
    return subloc === 'The Bronx' ? 'Bronx' : subloc;
  }
  return null;
}

const PLACES_API_BASE = 'https://places.googleapis.com/v1/places:searchText';
const FIELDS = [
  'places.id',
  'places.googleMapsUri',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.websiteUri',
  'places.reservable',
  'places.photos',
  // New-API signals used to classify cuisine + features without an LLM call.
  'places.primaryType',
  'places.types',
  'places.servesBrunch',
  'places.servesBreakfast',
  'places.servesCoffee',
  'places.servesDessert',
  'places.servesCocktails',
  // Rating signals — surface "4.7★ · 1,200 reviews" on the card.
  'places.rating',
  'places.userRatingCount',
  // Coordinates power the Find tab map pins.
  'places.location',
  // Pricing — `priceLevel` enum drives $/$$/$$$/$$$$ on the card. Null on
  // listings Google hasn't classified. We also pull `priceRange` so we can
  // synthesise a tier from the numeric range when the enum is missing —
  // e.g. HYUN exposes "$100+" via priceRange but no priceLevel.
  'places.priceLevel',
  'places.priceRange',
].join(',');

/**
 * Map a `priceRange` start-price (USD) to the same enum the Places API
 * uses for `priceLevel`. Buckets calibrated to NYC dining tiers and the
 * Places convention (≤$10 = inexpensive, $10–25 moderate, $25–50 expensive,
 * ≥$50 very expensive). Returns null on missing/zero inputs.
 */
function priceLevelFromRangeStart(units: number | null): string | null {
  if (units == null || units <= 0) return null;
  if (units < 11) return 'PRICE_LEVEL_INEXPENSIVE';
  if (units < 26) return 'PRICE_LEVEL_MODERATE';
  if (units < 51) return 'PRICE_LEVEL_EXPENSIVE';
  return 'PRICE_LEVEL_VERY_EXPENSIVE';
}

/** Extract `priceRange.startPrice.units` from a Places (New) place object.
 *  The API returns `units` either as a string or a number depending on size. */
export function extractPriceRangeStartUnits(place: Record<string, unknown> | null | undefined): number | null {
  const range = place?.priceRange as { startPrice?: { units?: unknown } } | undefined;
  const raw = range?.startPrice?.units;
  if (raw == null) return null;
  const n = typeof raw === 'string' ? parseInt(raw, 10) : (typeof raw === 'number' ? raw : NaN);
  return Number.isFinite(n) ? n : null;
}

/** Best-effort `priceLevel`: prefer the explicit enum; fall back to a tier
 *  synthesised from `priceRange.startPrice` when the enum is missing. */
export function resolvePriceLevel(place: Record<string, unknown> | null | undefined): string | null {
  const explicit = typeof place?.priceLevel === 'string' ? place!.priceLevel as string : null;
  if (explicit && explicit !== 'PRICE_LEVEL_UNSPECIFIED') return explicit;
  return priceLevelFromRangeStart(extractPriceRangeStartUnits(place));
}

const INSTAGRAM_HANDLE_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{1,30})/i;
const INSTAGRAM_FETCH_TIMEOUT_MS = 8000;

/**
 * Best-effort Instagram URL extraction. Fetches the restaurant's website,
 * scans the HTML for the first `instagram.com/<handle>` link. Skips known
 * non-profile paths (`/p/`, `/reel/`, `/explore`, `/accounts`). Returns
 * null on any failure — we never block enrichment on this.
 */
async function extractInstagramUrl(websiteUrl: string | null): Promise<string | null> {
  if (!websiteUrl) return null;
  try {
    const res = await axios.get(websiteUrl, {
      timeout: INSTAGRAM_FETCH_TIMEOUT_MS,
      maxContentLength: 1_500_000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = typeof res.data === 'string' ? res.data : '';
    if (!html) return null;
    const match = html.match(INSTAGRAM_HANDLE_RE);
    if (!match) return null;
    const handle = match[1];
    if (['p', 'reel', 'explore', 'accounts', 'tv', 'stories'].includes(handle.toLowerCase())) {
      return null;
    }
    return `https://www.instagram.com/${handle}`;
  } catch {
    return null;
  }
}

/**
 * Map a Places (New) `primaryType` / `types` value to a CuisineKey. Places
 * publishes `chinese_restaurant`, `japanese_restaurant`, etc. which line up
 * almost 1:1 with our enum. Returns null for generic `restaurant`, `food`,
 * or anything we don't classify.
 */
function cuisineFromPlacesType(type: string | null | undefined): CuisineKey | null {
  if (!type) return null;
  switch (type) {
    case 'chinese_restaurant': return 'chinese';
    case 'japanese_restaurant': return 'japanese';
    case 'korean_restaurant': return 'korean';
    case 'italian_restaurant': return 'italian';
    case 'french_restaurant': return 'french';
    case 'mexican_restaurant': return 'mexican';
    case 'american_restaurant': return 'american';
    case 'thai_restaurant': return 'thai';
    case 'indian_restaurant': return 'indian';
    case 'vietnamese_restaurant': return 'vietnamese';
    case 'spanish_restaurant': return 'spanish';
    case 'mediterranean_restaurant': return 'mediterranean';
    case 'middle_eastern_restaurant': return 'middle_eastern';
    case 'greek_restaurant': return 'mediterranean';
    case 'turkish_restaurant': return 'mediterranean';
    case 'lebanese_restaurant': return 'middle_eastern';
    // Format-restaurant types (pizza, ramen, sushi, steakhouse, seafood) roll
    // up to their parent cuisine — features handle the specialty separately.
    case 'pizza_restaurant': return 'italian';
    case 'ramen_restaurant':
    case 'sushi_restaurant': return 'japanese';
    case 'bbq_restaurant':
    case 'barbecue_restaurant': return 'american';
    default: return null;
  }
}

/**
 * Whitelist of food-establishment Places types we accept. Without this guard
 * Places will happily return a NYC government office or library when a
 * restaurant name happens to be a common word ("Oti" → Office of Technology
 * and Innovation, "Bibliotheque" → New York Public Library, etc.). We try
 * each in order and accept the first hit whose primaryType matches — same
 * effect as `strictTypeFiltering` but works across multiple food categories.
 */
const FOOD_TYPE_FALLBACKS = ['restaurant', 'bar', 'cafe', 'bakery', 'meal_takeaway', 'meal_delivery'];
const FOOD_PRIMARY_TYPES = new Set([
  'restaurant', 'bar', 'cafe', 'coffee_shop', 'bakery', 'meal_takeaway', 'meal_delivery',
  'fast_food_restaurant', 'fine_dining_restaurant', 'pizza_restaurant', 'sushi_restaurant',
  'ramen_restaurant', 'bbq_restaurant', 'barbecue_restaurant', 'seafood_restaurant',
  'steak_house', 'sandwich_shop', 'ice_cream_shop', 'dessert_shop', 'donut_shop',
  'wine_bar', 'pub', 'breakfast_restaurant', 'brunch_restaurant', 'tea_house',
  'american_restaurant', 'italian_restaurant', 'french_restaurant', 'chinese_restaurant',
  'japanese_restaurant', 'korean_restaurant', 'thai_restaurant', 'vietnamese_restaurant',
  'indian_restaurant', 'mexican_restaurant', 'spanish_restaurant', 'mediterranean_restaurant',
  'middle_eastern_restaurant', 'greek_restaurant', 'turkish_restaurant', 'lebanese_restaurant',
  'romanian_restaurant', 'vegetarian_restaurant', 'vegan_restaurant', 'asian_restaurant',
  'latin_american_restaurant', 'african_restaurant', 'caribbean_restaurant',
  'brazilian_restaurant', 'argentinian_restaurant', 'peruvian_restaurant',
  'food_court', 'hamburger_restaurant', 'fried_chicken_restaurant', 'taco_restaurant',
]);

async function searchPlace(query: string): Promise<PlacesResult | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY not set');

  // First pass: strict food-type filter prevents non-restaurant collisions.
  // If every food type returns nothing we fall through to the unfiltered
  // search as a last resort (some legitimate venues — coffee bars without a
  // food program — surface only there). Any unfiltered match still has to
  // pass the FOOD_PRIMARY_TYPES post-check.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let place: any;
  for (const includedType of FOOD_TYPE_FALLBACKS) {
    const r = await axios.post(
      PLACES_API_BASE,
      { textQuery: query, languageCode: 'en', includedType, strictTypeFiltering: true },
      { headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELDS } }
    );
    const candidates = r.data?.places;
    if (candidates && candidates.length > 0) { place = candidates[0]; break; }
  }
  if (!place) {
    const r = await axios.post(
      PLACES_API_BASE,
      { textQuery: query, languageCode: 'en' },
      { headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELDS } }
    );
    const candidates = r.data?.places;
    if (!candidates || candidates.length === 0) return null;
    const top = candidates[0];
    const pt = top?.primaryType;
    if (typeof pt === 'string' && FOOD_PRIMARY_TYPES.has(pt)) {
      place = top;
    } else {
      logger.warn('places.rejected_non_food', { query, primaryType: pt, displayName: top?.displayName?.text });
      return null;
    }
  }
  if (!place) return null;
  const photos: string[] = (place.photos ?? [])
    .slice(0, 5)
    .map((p: { name: string }) =>
      `https://places.googleapis.com/v1/${p.name}/media?maxWidthPx=800&key=${apiKey}`
    );
  const photoUrl = photos[0] ?? null;

  // Cuisine inference from Places types: prefer primaryType; fall back to
  // the first match in the broader `types` array.
  const cuisineKey =
    cuisineFromPlacesType(place.primaryType)
    ?? (Array.isArray(place.types)
      ? (place.types.map(cuisineFromPlacesType).find(Boolean) ?? null)
      : null)
    ?? null;

  // Feature inference: primaryType + serves* booleans.
  const typeFeatures: (FeatureKey | null)[] = [
    featuresFromPlacesType(place.primaryType),
    ...(Array.isArray(place.types) ? place.types.map(featuresFromPlacesType) : []),
  ];
  const features = canonicalizeFeatures([
    ...typeFeatures,
    ...featuresFromPlacesServes({
      servesBrunch: place.servesBrunch,
      servesBreakfast: place.servesBreakfast,
      servesCoffee: place.servesCoffee,
      servesDessert: place.servesDessert,
      servesCocktails: place.servesCocktails,
    }),
  ]);

  const websiteUrl = place.websiteUri ?? null;
  const instagramUrl = await extractInstagramUrl(websiteUrl);

  return {
    googlePlaceId: place.id,
    googleMapsUrl: place.googleMapsUri,
    googleDisplayName: place.displayName?.text ?? '',
    address: place.formattedAddress ?? null,
    borough: extractBorough(place.addressComponents),
    neighborhood: extractNeighborhood(place.addressComponents),
    websiteUrl,
    reservable: place.reservable ?? false,
    photoUrl,
    photoUrls: photos,
    cuisineKey,
    features,
    googleRating: typeof place.rating === 'number' ? place.rating : null,
    googleUserRatingCount:
      typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
    instagramUrl,
    latitude:  typeof place.location?.latitude  === 'number' ? place.location.latitude  : null,
    longitude: typeof place.location?.longitude === 'number' ? place.location.longitude : null,
    priceLevel: resolvePriceLevel(place),
  };
}

// Try multiple query strategies, most specific first
export async function enrichWithPlaces(
  restaurant: ExtractedRestaurant
): Promise<PlacesResult | null> {
  const name = restaurant.restaurantName;

  const queries: string[] = [];

  if (restaurant.address) {
    queries.push(`${name} ${restaurant.address}`);
  }
  if (restaurant.locationHint) {
    queries.push(`${name} ${restaurant.locationHint} New York`);
  }
  queries.push(`${name} New York City`);

  for (const query of queries) {
    try {
      const result = await searchPlace(query);
      if (result) {
        logger.success('places.enriched', { name, query, placeId: result.googlePlaceId });
        return result;
      }
    } catch (e) {
      logger.warn('places.search.failed', { name, query, error: String(e) });
    }
  }

  logger.warn('places.not_found', { name });
  return null;
}
