import { VercelRequest, VercelResponse } from '@vercel/node';
import { bookSlot } from '../../_lib/opentable';
import { ok, err } from '../../_lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const { venueId, slotToken, partySize, datetime } = req.body as {
    venueId: string;
    slotToken: string;
    partySize: number;
    datetime: string;
  };

  if (!venueId || !slotToken) {
    return res.status(400).json(err('Missing required params', 'BAD_REQUEST'));
  }

  try {
    const confirmation = await bookSlot(venueId, slotToken, partySize ?? 2, datetime);
    return res.status(200).json(ok(confirmation));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Booking failed';
    return res.status(500).json(err(message, 'OPENTABLE_BOOK_ERROR'));
  }
}
