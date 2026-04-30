import { VercelRequest, VercelResponse } from '@vercel/node';
import { bookSlot } from '../../_lib/resy';
import { ok, err } from '../../_lib/types';
import { logger, withRequestLogging } from '../../_lib/logger';

async function handler(req: VercelRequest, res: VercelResponse) {
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

  logger.request('POST', '/api/reservations/resy/book', { venueId, configId, partySize, hasPayment: !!paymentMethodId });

  try {
    const confirmation = await bookSlot(venueId, configId, partySize ?? 2, paymentMethodId);
    logger.success('resy.book.confirmed', { venueId, configId, confirmationId: (confirmation as any)?.reservationId });
    return res.status(200).json(ok(confirmation));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Booking failed';
    logger.error('resy.book.failed', e, { venueId, configId });
    return res.status(500).json(err(message, 'RESY_BOOK_ERROR'));
  }
}
export default withRequestLogging(handler);
