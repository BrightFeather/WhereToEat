import axios from 'axios';
import { ReviewDTO } from './types';

const BASE = 'https://api.yelp.com/v3';

// Simple in-memory rate limit counter (resets after 24h)
let dailyRequestCount = 0;
let lastResetDate = new Date().toDateString();
const DAILY_LIMIT = 490; // keep buffer below 500

function checkRateLimit(): void {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    dailyRequestCount = 0;
    lastResetDate = today;
  }
  if (dailyRequestCount >= DAILY_LIMIT) {
    throw new Error('Yelp daily rate limit reached');
  }
  dailyRequestCount++;
}

function headers() {
  return { Authorization: `Bearer ${process.env.YELP_API_KEY}` };
}

export interface YelpBusiness {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  rating?: number;
  reviewCount?: number;
  categories: string[];
  photos: string[];
  phone?: string;
  url: string;
  price?: string;
}

export async function searchBusinesses(
  lat: number,
  lng: number,
  categories?: string[],
  limit = 20
): Promise<YelpBusiness[]> {
  checkRateLimit();
  try {
    const res = await axios.get(`${BASE}/businesses/search`, {
      headers: headers(),
      params: {
        latitude: lat,
        longitude: lng,
        categories: categories?.join(',') ?? 'restaurants',
        limit,
        sort_by: 'best_match',
      },
    });
    return (res.data.businesses ?? []).map(mapBusiness);
  } catch {
    return [];
  }
}

export async function getBusinessDetails(id: string): Promise<{
  reviews: ReviewDTO[];
  photos: string[];
} | null> {
  checkRateLimit();
  try {
    const [detailsRes, reviewsRes] = await Promise.all([
      axios.get(`${BASE}/businesses/${id}`, { headers: headers() }),
      axios.get(`${BASE}/businesses/${id}/reviews`, { headers: headers() }),
    ]);
    dailyRequestCount++; // second request

    const reviews: ReviewDTO[] = (reviewsRes.data.reviews ?? []).map(
      (r: { text: string; rating: number; time_created: string; user: { name: string } }) => ({
        platform: 'yelp' as const,
        text: r.text,
        rating: r.rating,
        date: r.time_created,
        authorName: r.user?.name,
      })
    );

    return {
      reviews,
      photos: detailsRes.data.photos ?? [],
    };
  } catch {
    return null;
  }
}

function mapBusiness(b: {
  id: string;
  name: string;
  location: { display_address: string[] };
  coordinates: { latitude: number; longitude: number };
  rating?: number;
  review_count?: number;
  categories: Array<{ alias: string }>;
  photos?: string[];
  phone?: string;
  url: string;
  price?: string;
}): YelpBusiness {
  return {
    id: b.id,
    name: b.name,
    address: b.location?.display_address?.join(', ') ?? '',
    latitude: b.coordinates?.latitude ?? 0,
    longitude: b.coordinates?.longitude ?? 0,
    rating: b.rating,
    reviewCount: b.review_count,
    categories: (b.categories ?? []).map((c) => c.alias),
    photos: b.photos ?? [],
    phone: b.phone,
    url: b.url,
    price: b.price,
  };
}

export function priceStringToLevel(price?: string): number | undefined {
  if (!price) return undefined;
  return price.length as 1 | 2 | 3 | 4;
}
