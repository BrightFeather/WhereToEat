import axios from 'axios';
import { TimeSlot, BookingConfirmation } from './types';

const BASE = 'https://www.exploretock.com';

let sessionCookie: string | null = null;

async function getSession(): Promise<string> {
  if (sessionCookie) return sessionCookie;

  const loginRes = await axios.post(
    `${BASE}/login`,
    {
      email: process.env.TOCK_EMAIL!,
      password: process.env.TOCK_PASSWORD!,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      },
      maxRedirects: 0,
      validateStatus: (s) => s < 400,
    }
  );

  const cookies = loginRes.headers['set-cookie'] ?? [];
  sessionCookie = cookies
    .map((c: string) => c.split(';')[0])
    .join('; ');
  return sessionCookie!;
}

function tockHeaders(cookie: string) {
  return {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    'X-Requested-With': 'XMLHttpRequest',
  };
}

export async function searchAvailability(
  venueSlug: string,
  dates: string[],
  partySize: number
): Promise<TimeSlot[]> {
  const cookie = await getSession();
  const slots: TimeSlot[] = [];

  for (const date of dates) {
    try {
      const res = await axios.get(
        `${BASE}/api/availability/${venueSlug}`,
        {
          headers: tockHeaders(cookie),
          params: { date, size: partySize },
        }
      );

      const available = res.data.availability ?? res.data.slots ?? [];
      for (const slot of available) {
        slots.push({
          id: slot.id ?? slot.slotId ?? `${venueSlug}-${date}-${slot.time}`,
          datetime: `${date}T${slot.time ?? '00:00:00'}`,
          partySize,
          depositRequired: !!slot.price || slot.requiresDeposit,
          depositAmount: slot.price ? slot.price / 100 : undefined,
          depositPolicy: slot.cancellationPolicy ?? undefined,
        });
      }
    } catch {
      // skip failed date
    }
  }
  return slots;
}

export async function bookSlot(
  venueSlug: string,
  slotId: string,
  partySize: number
): Promise<BookingConfirmation> {
  const cookie = await getSession();

  const res = await axios.post(
    `${BASE}/api/booking`,
    { venueSlug, slotId, size: partySize },
    { headers: tockHeaders(cookie) }
  );

  return {
    confirmationCode: res.data.confirmationCode ?? res.data.id ?? 'TOCK-CONFIRMED',
    platform: 'tock',
    depositCharged: !!res.data.charged,
  };
}
