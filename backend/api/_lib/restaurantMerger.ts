import type { ExtractedRestaurant } from './llmExtractor';
import type { PlacesResult } from './placesEnricher';
import type { CuisineKey } from './cuisines';
import { canonicalizeFeatures, type FeatureKey } from './features';

export interface EnrichedRestaurant extends ExtractedRestaurant {
  places: PlacesResult | null;
}

export interface MergedRestaurant {
  restaurantName: string;
  address: string | null;
  borough: string | null;
  neighborhood: string | null;
  /** Canonical cuisine key — Places-derived when available, LLM-derived otherwise. */
  cuisineKey: CuisineKey | null;
  /** Union of Places-derived + LLM-derived features, deduped. */
  features: FeatureKey[];
  /** Denormalized "best snippet" — the highest-liked post's recommendation. */
  recommendation: string | null;
  /** Denormalized "best URL" — the highest-liked post's URL. */
  postUrl: string;
  postCreatedAt: string;
  mentionCount: number;
  totalLikes: number;
  googlePlaceId: string | null;
  googleMapsUrl: string | null;
  googleDisplayName: string | null;
  websiteUrl: string | null;
  photoUrl: string | null;
  photoUrls: string[];
  /** Google Maps overall rating (e.g. 4.7) and # of reviews backing it. */
  googleRating: number | null;
  googleUserRatingCount: number | null;
  /** Best-effort Instagram profile URL — Places-derived (scrape of website) or null. */
  instagramUrl: string | null;
  /** WGS84 coordinates from the Places API; nullable when Places returned no `location`. */
  latitude: number | null;
  longitude: number | null;
  /** Per-post source evidence — one entry per XHS post that mentioned this
   *  restaurant. Written to `xhs_sources` so the card can surface multiple
   *  creator quotes instead of only the top one. */
  sources: Array<{
    postUrl: string;
    recommendation: string | null;
    likes: number;
    postCreatedAt: string | null;
  }>;
}

function normalizeRestaurantName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s\-_·•]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/(restaurant|餐厅|餐馆|饭店|cafe|bistro)$/i, '');
}

export function deduplicateAndRank(restaurants: EnrichedRestaurant[]): MergedRestaurant[] {
  const groups = new Map<string, EnrichedRestaurant[]>();

  for (const r of restaurants) {
    // Primary key: googlePlaceId when available (canonical); fallback to normalized name
    const key = r.places?.googlePlaceId ?? normalizeRestaurantName(r.restaurantName);
    if (!key) continue;
    const existing = groups.get(key) ?? [];
    existing.push(r);
    groups.set(key, existing);
  }

  const merged: MergedRestaurant[] = [];

  for (const group of groups.values()) {
    group.sort((a, b) => b.likes - a.likes);
    const best = group[0];
    const totalLikes = group.reduce((sum, r) => sum + r.likes, 0);
    const mostRecentPost = group.reduce((latest, r) =>
      r.postCreatedAt > latest.postCreatedAt ? r : latest
    );
    const recommendation =
      group.find((r) => r.creatorRecommendation)?.creatorRecommendation ?? null;

    // Prefer Places data from the highest-liked post that has it
    const placesData = group.find((r) => r.places)?.places ?? null;

    // Cuisine resolution: Places is authoritative when it recognizes a
    // `<foo>_restaurant` primaryType; otherwise take whatever the LLM voted
    // for on the highest-liked post of the group.
    const cuisineKey =
      placesData?.cuisineKey
      ?? group.map((r) => r.cuisineKey).find((c) => c !== null)
      ?? null;

    // Feature resolution: union Places-derived signals (coffee, brunch, etc.)
    // with every LLM-derived feature in the group, dedupe + sort.
    const features = canonicalizeFeatures([
      ...(placesData?.features ?? []),
      ...group.flatMap((r) => r.features ?? []),
    ]);

    // Per-post evidence — dedupe by postUrl (same post can appear twice if
    // the scraper surfaces it from two different search pages). Keep the
    // entry with the higher likes count.
    const byUrl = new Map<string, EnrichedRestaurant>();
    for (const r of group) {
      const prev = byUrl.get(r.postUrl);
      if (!prev || r.likes > prev.likes) byUrl.set(r.postUrl, r);
    }
    const sources = Array.from(byUrl.values())
      .map((r) => ({
        postUrl: r.postUrl,
        recommendation: r.creatorRecommendation ?? null,
        likes: r.likes,
        postCreatedAt: r.postCreatedAt ?? null,
      }))
      .sort((a, b) => b.likes - a.likes);

    merged.push({
      restaurantName: placesData?.googleDisplayName || best.restaurantName,
      address: placesData?.address ?? best.address,
      borough: placesData?.borough ?? null,
      neighborhood: placesData?.neighborhood ?? null,
      cuisineKey,
      features,
      recommendation,
      postUrl: best.postUrl,
      postCreatedAt: mostRecentPost.postCreatedAt,
      mentionCount: sources.length,
      totalLikes,
      googlePlaceId: placesData?.googlePlaceId ?? null,
      googleMapsUrl: placesData?.googleMapsUrl ?? null,
      googleDisplayName: placesData?.googleDisplayName ?? null,
      websiteUrl: placesData?.websiteUrl ?? null,
      photoUrl: placesData?.photoUrl ?? null,
      photoUrls: placesData?.photoUrls ?? [],
      googleRating: placesData?.googleRating ?? null,
      googleUserRatingCount: placesData?.googleUserRatingCount ?? null,
      instagramUrl: placesData?.instagramUrl ?? null,
      latitude:  placesData?.latitude  ?? null,
      longitude: placesData?.longitude ?? null,
      sources,
    });
  }

  merged.sort((a, b) => rankScore(b) - rankScore(a));

  return merged;
}

// Recency-weighted quality score.
// - Mention count is fully weighted (cross-post validation doesn't decay).
// - Likes are weighted by post age: fresh posts (≤7 days) count fully;
//   weight decays linearly to a 0.2 floor by 60 days.
export function rankScore(r: {
  mentionCount: number;
  totalLikes: number;
  postCreatedAt: string | null;
}): number {
  return r.mentionCount * 10 + r.totalLikes * recencyWeight(r.postCreatedAt);
}

export function recencyWeight(postCreatedAt: string | null): number {
  if (!postCreatedAt) return 0.4;
  const ageDays = (Date.now() - new Date(postCreatedAt).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays <= 7) return 1.0;
  if (ageDays >= 60) return 0.2;
  return 1.0 - ((ageDays - 7) / 53) * 0.8;
}
