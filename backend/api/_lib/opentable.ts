import axios from 'axios';
import { TimeSlot, BookingConfirmation } from './types';

// OpenTable has a public availability widget API
const BASE = 'https://www.opentable.com/restref/api';

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
