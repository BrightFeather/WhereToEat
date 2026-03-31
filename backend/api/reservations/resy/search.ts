import { VercelRequest, VercelResponse } from '@vercel/node';
import { searchAvailability } from '../../_lib/resy';
import { ok, err } from '../../_lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const { venueId, partySize } = req.query;
  const dates = Array.isArray(req.query['dates[]'])
    ? req.query['dates[]']
    : req.query['dates[]']
    ? [req.query['dates[]'] as string]
    : [];

  if (!venueId || !dates.length || !partySize) {
    return res.status(400).json(err('Missing required params: venueId, dates[], partySize', 'BAD_REQUEST'));
  }

  try {
    const slots = await searchAvailability(
      venueId as string,
      dates as string[],
      parseInt(partySize as string, 10)
    );
    return res.status(200).json(ok({ slots }));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Resy error';
    console.error('Resy search error:', e);
    return res.status(500).json(err(message, 'RESY_ERROR'));
  }
}
