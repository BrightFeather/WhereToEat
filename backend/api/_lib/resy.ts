import axios from 'axios';
import { TimeSlot, BookingConfirmation } from './types';

const BASE = 'https://api.resy.com';

let sessionToken: string | null = null;
let tokenExpiry: Date | null = null;

async function getToken(): Promise<string> {
  if (sessionToken && tokenExpiry && tokenExpiry > new Date()) {
    return sessionToken;
  }

  const res = await axios.post(
    `${BASE}/3/auth/password`,
    new URLSearchParams({
      email: process.env.RESY_EMAIL!,
      password: process.env.RESY_PASSWORD!,
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'ResyAPI api_key="VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5"',
        'X-Resy-Auth-Token': '',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      },
    }
  );

  sessionToken = res.data.token;
  // Tokens typically valid for 24h
  tokenExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000);
  return sessionToken!;
}

function resyHeaders(token: string) {
  return {
    'Authorization': 'ResyAPI api_key="VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5"',
    'X-Resy-Auth-Token': token,
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

export interface ResyVenueMatch {
  venueId: string;
  name: string;
  urlSlug: string;
  citySlug: string;
  bookingUrl: string;
  neighborhood?: string;
  address?: string;
}

export async function findVenue(name: string, lat: number, lng: number): Promise<ResyVenueMatch | null> {
  const token = await getToken();
  const today = new Date().toISOString().split('T')[0];
  try {
    const res = await axios.get(`${BASE}/4/find`, {
      headers: {
        ...resyHeaders(token),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://resy.com',
        'Referer': 'https://resy.com/',
        'X-Origin': 'https://resy.com',
        'Cache-Control': 'no-cache',
      },
      params: { lat, long: lng, day: today, party_size: 2 },
    });
    const venues = res.data.results?.venues ?? [];
    const nameLower = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = venues.find((v: any) => {
      const vName = (v.venue?.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return vName === nameLower || vName.includes(nameLower) || nameLower.includes(vName);
    });
    if (!match) return null;
    const venue = match.venue;
    const venueId = typeof venue.id === 'object' ? venue.id.resy : venue.id;
    const urlSlug = venue.url_slug ?? '';
    const citySlug = venue.location?.url_slug ?? '';
    return {
      venueId: String(venueId),
      name: venue.name,
      urlSlug,
      citySlug,
      bookingUrl: urlSlug && citySlug
        ? `https://resy.com/cities/${citySlug}/venues/${urlSlug}`
        : `https://resy.com/cities/new-york-ny/venues/${venueId}`,
      neighborhood: venue.neighborhood,
      address: venue.location?.address_1,
    };
  } catch {
    return null;
  }
}

/** @deprecated Use findVenue instead */
export async function findVenueId(name: string, lat: number, lng: number): Promise<string | null> {
  const match = await findVenue(name, lat, lng);
  return match?.venueId ?? null;
}

export async function searchAvailability(
  venueId: string,
  dates: string[],
  partySize: number
): Promise<TimeSlot[]> {
  const token = await getToken();
  const slots: TimeSlot[] = [];

  for (const date of dates) {
    try {
      const res = await axios.get(`${BASE}/4/find`, {
        headers: resyHeaders(token),
        params: {
          lat: 0,
          long: 0,
          day: date,
          party_size: partySize,
          venue_id: venueId,
        },
      });

      const venues = res.data.results?.venues ?? [];
      for (const venue of venues) {
        for (const slot of venue.slots ?? []) {
          const config = slot.config;
          slots.push({
            id: JSON.stringify(config),
            datetime: `${date}T${slot.date?.start ?? '00:00:00'}`,
            partySize,
            depositRequired: !!slot.payment?.deposit_fee,
            depositAmount: slot.payment?.deposit_fee
              ? slot.payment.deposit_fee / 100
              : undefined,
            depositPolicy: slot.payment?.cancellation_policy ?? undefined,
          });
        }
      }
    } catch {
      // skip failed date
    }
  }
  return slots;
}

export async function bookSlot(
  venueId: string,
  configJson: string,
  partySize: number,
  paymentMethodId?: string
): Promise<BookingConfirmation> {
  const token = await getToken();

  const body = new URLSearchParams({
    book_token: configJson,
    struct_payment_method: JSON.stringify(
      paymentMethodId ? { id: paymentMethodId } : {}
    ),
    source_id: 'resy.com-venue-details',
  });

  const res = await axios.post(`${BASE}/3/book`, body, {
    headers: resyHeaders(token),
  });

  return {
    confirmationCode: res.data.resy_token ?? res.data.reservation_id ?? 'RESY-CONFIRMED',
    platform: 'resy',
    depositCharged: !!res.data.payment?.deposit_fee,
  };
}
