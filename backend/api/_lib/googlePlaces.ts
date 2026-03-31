import axios from 'axios';
import { ReviewDTO, DayHoursDTO, ReservationSourceDTO } from './types';

const BASE = 'https://maps.googleapis.com/maps/api/place';

export interface PlaceDetails {
  placeId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  rating?: number;
  reviewCount?: number;
  priceLevel?: number;
  phone?: string;
  website?: string;
  photos: string[];
  reviews: ReviewDTO[];
  hours: DayHoursDTO[];
  types: string[];
}

export async function searchPlace(
  query: string,
  lat: number,
  lng: number
): Promise<PlaceDetails | null> {
  const key = process.env.GOOGLE_PLACES_API_KEY!;
  try {
    const searchRes = await axios.get(`${BASE}/textsearch/json`, {
      params: {
        query,
        location: `${lat},${lng}`,
        radius: 5000,
        type: 'restaurant',
        key,
      },
    });

    const results = searchRes.data.results;
    if (!results?.length) return null;

    const placeId = results[0].place_id;
    return getPlaceDetails(placeId);
  } catch {
    return null;
  }
}

export async function getPlaceDetails(placeId: string): Promise<PlaceDetails | null> {
  const key = process.env.GOOGLE_PLACES_API_KEY!;
  try {
    const res = await axios.get(`${BASE}/details/json`, {
      params: {
        place_id: placeId,
        fields: [
          'name',
          'formatted_address',
          'geometry',
          'rating',
          'user_ratings_total',
          'price_level',
          'photos',
          'reviews',
          'opening_hours',
          'formatted_phone_number',
          'website',
          'types',
        ].join(','),
        key,
      },
    });

    const p = res.data.result;
    if (!p) return null;

    const photos = (p.photos || [])
      .slice(0, 8)
      .map((ph: { photo_reference: string }) =>
        `${BASE}/photo?maxwidth=800&photo_reference=${ph.photo_reference}&key=${key}`
      );

    const reviews: ReviewDTO[] = (p.reviews || []).slice(0, 5).map(
      (r: { text: string; rating: number; time: number; author_name: string }) => ({
        platform: 'google' as const,
        text: r.text,
        rating: r.rating,
        date: new Date(r.time * 1000).toISOString(),
        authorName: r.author_name,
      })
    );

    const hours: DayHoursDTO[] = [];
    if (p.opening_hours?.periods) {
      for (const period of p.opening_hours.periods) {
        hours.push({
          day: period.open?.day ?? 0,
          openTime: formatTime(period.open?.time ?? '0000'),
          closeTime: formatTime(period.close?.time ?? '2359'),
          isClosed: false,
        });
      }
    }

    return {
      placeId,
      name: p.name,
      address: p.formatted_address,
      latitude: p.geometry?.location?.lat ?? 0,
      longitude: p.geometry?.location?.lng ?? 0,
      rating: p.rating,
      reviewCount: p.user_ratings_total,
      priceLevel: p.price_level,
      phone: p.formatted_phone_number,
      website: p.website,
      photos,
      reviews,
      hours,
      types: p.types ?? [],
    };
  } catch {
    return null;
  }
}

function formatTime(t: string): string {
  const padded = t.padStart(4, '0');
  return `${padded.slice(0, 2)}:${padded.slice(2)}`;
}

export function mapTypesToCuisine(types: string[]): string[] {
  const map: Record<string, string> = {
    japanese_restaurant: 'japanese',
    chinese_restaurant: 'chinese',
    korean_restaurant: 'korean',
    french_restaurant: 'french',
    italian_restaurant: 'italian',
    mexican_restaurant: 'mexican',
    american_restaurant: 'american',
    thai_restaurant: 'thai',
    indian_restaurant: 'indian',
    vietnamese_restaurant: 'vietnamese',
    mediterranean_restaurant: 'mediterranean',
    middle_eastern_restaurant: 'middle_eastern',
    spanish_restaurant: 'spanish',
  };
  return types.flatMap((t) => (map[t] ? [map[t]] : []));
}
