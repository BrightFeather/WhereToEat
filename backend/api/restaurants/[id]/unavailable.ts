import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../_lib/db';
import { logger, withRequestLogging } from '../../_lib/logger';
import { ok, err } from '../../_lib/types';

async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PATCH') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json(err('Missing restaurant id', 'MISSING_ID'));
  }

  const [row] = await sql`
    SELECT id FROM xhs_restaurants WHERE id = ${id}
  `;
  if (!row) {
    return res.status(404).json(err('Restaurant not found', 'NOT_FOUND'));
  }

  await sql`
    UPDATE xhs_restaurants
    SET is_available_this_week = 0
    WHERE id = ${id}
  `;

  logger.success('restaurant.marked_unavailable', { id });
  return res.status(200).json(ok({ id, isAvailableThisWeek: false }));
}

export default withRequestLogging(handler);
