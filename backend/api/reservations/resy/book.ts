import { VercelRequest, VercelResponse } from '@vercel/node';
import { bookSlot } from '../../_lib/resy';
import { ok, err } from '../../_lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const { venueId, configId, partySize, paymentMethodId } = req.body as {
    venueId: string;
    configId: string;
    partySize: number;
    paymentMethodId?: string;
  };

  if (!venueId || !configId) {
    return res.status(400).json(err('Missing venueId or configId', 'BAD_REQUEST'));
  }

  try {
    const confirmation = await bookSlot(venueId, configId, partySize ?? 2, paymentMethodId);
    return res.status(200).json(ok(confirmation));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Booking failed';
    console.error('Resy book error:', e);
    return res.status(500).json(err(message, 'RESY_BOOK_ERROR'));
  }
}
