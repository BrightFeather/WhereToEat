import axios from 'axios';
import { TimeSlot, BookingConfirmation } from './types';

// OpenTable has a public availability widget API
const BASE = 'https://www.opentable.com/restref/api';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface OpenTableVenueMatch {
  rid: number;
  name: string;
  bookingUrl: string;
  neighborhood?: string;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function findVenue(name: string, city: string = 'New York'): Promise<OpenTableVenueMatch | null> {
  try {
    const res = await axios.get(`${BASE}/typeahead`, {
      params: { term: name, latitude: 0, longitude: 0, city },
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      timeout: 15000,
    });

    const items = (res.data?.restaurants || res.data?.results || res.data || []) as Record<string, unknown>[];
    const nameNorm = normalize(name);

    for (const item of items) {
      const rid = (item.rid || item.id || 0) as number;
      const rName = (item.name || item.restaurantName || '') as string;
      const rNorm = normalize(rName);

      const isExact = rNorm === nameNorm;
      const shorter = Math.min(rNorm.length, nameNorm.length);
      const longer = Math.max(rNorm.length, nameNorm.length);
      const isSubstring = (rNorm.includes(nameNorm) || nameNorm.includes(rNorm))
        && shorter >= longer * 0.6;

      if ((isExact || isSubstring) && (shorter >= 4 || isExact)) {
        return {
          rid,
          name: rName,
          bookingUrl: `https://www.opentable.com/booking/experiences?rid=${rid}`,
          neighborhood: (item.neighborhood || '') as string,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function searchAvailability(
  restaurantId: string,
  dates: string[],
  partySize: number
): Promise<TimeSlot[]> {
  const slots: TimeSlot[] = [];

  for (const date of dates) {
    try {
      const res = await axios.get(`${BASE}/availability`, {
        params: {
          rid: restaurantId,
          covers: partySize,
          datetime: `${date}T19:00`,
          lang: 'en-US',
          includeNextAvailableDate: true,
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
          'Accept': 'application/json',
        },
      });

      const times = res.data.availability ?? [];
      for (const slot of times) {
        if (!slot.isAvailable) continue;
        slots.push({
          id: slot.slotId ?? slot.token ?? `ot-${restaurantId}-${slot.dateTime}`,
          datetime: slot.dateTime,
          partySize,
          depositRequired: false,
        });
      }
    } catch {
      // skip
    }
  }
  return slots;
}

export async function bookSlot(
  restaurantId: string,
  slotToken: string,
  partySize: number,
  datetime: string
): Promise<BookingConfirmation> {
  // OpenTable booking requires an authenticated session
  // For personal use, this deep-links to the OpenTable booking page
  const bookingUrl = `https://www.opentable.com/booking/experiences/select?rid=${restaurantId}&covers=${partySize}&datetime=${datetime}`;

  // Return a placeholder — the iOS app falls back to web for OpenTable
  return {
    confirmationCode: `OT-REDIRECT`,
    platform: 'opentable',
    depositCharged: false,
  };
}
