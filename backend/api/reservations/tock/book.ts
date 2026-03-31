import { VercelRequest, VercelResponse } from '@vercel/node';
import { bookSlot } from '../../_lib/tock';
import { ok, err } from '../../_lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const { venueId, slotId, partySize } = req.body as {
    venueId: string;
    slotId: string;
    partySize: number;
  };

  if (!venueId || !slotId) {
    return res.status(400).json(err('Missing venueId or slotId', 'BAD_REQUEST'));
  }

  try {
    const confirmation = await bookSlot(venueId, slotId, partySize ?? 2);
    return res.status(200).json(ok(confirmation));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Tock booking failed';
    return res.status(500).json(err(message, 'TOCK_BOOK_ERROR'));
  }
}
