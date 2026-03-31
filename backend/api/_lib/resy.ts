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

export async function findVenueId(name: string, lat: number, lng: number): Promise<string | null> {
  const token = await getToken();
  try {
    const res = await axios.get(`${BASE}/3/venuesearch`, {
      headers: resyHeaders(token),
      params: { query: name, lat, long: lng },
    });
    const venues = res.data.search?.hits ?? [];
    return venues[0]?.id?.resy ?? null;
  } catch {
    return null;
  }
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
