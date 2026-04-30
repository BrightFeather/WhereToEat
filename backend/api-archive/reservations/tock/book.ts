import { VercelRequest, VercelResponse } from '@vercel/node';
import { bookSlot } from '../../_lib/tock';
import { ok, err } from '../../_lib/types';
import { logger, withRequestLogging } from '../../_lib/logger';

async function handler(req: VercelRequest, res: VercelResponse) {
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

  logger.request('POST', '/api/reservations/tock/book', { venueId, slotId, partySize });

  try {
    const confirmation = await bookSlot(venueId, slotId, partySize ?? 2);
    logger.success('tock.book.confirmed', { venueId, slotId, confirmationId: (confirmation as any)?.reservationId });
    return res.status(200).json(ok(confirmation));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Tock booking failed';
    logger.error('tock.book.failed', e, { venueId, slotId });
    return res.status(500).json(err(message, 'TOCK_BOOK_ERROR'));
  }
}
export default withRequestLogging(handler);
