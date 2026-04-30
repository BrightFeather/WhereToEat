import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../_lib/db';
import { logger, withRequestLogging } from '../../_lib/logger';
import { ok, err } from '../../_lib/types';
import { withUser } from '../../_lib/withUser';

async function handler(req: VercelRequest, res: VercelResponse, userId: string) {
  if (req.method !== 'DELETE') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const restaurantId = req.query.restaurantId;
  if (!restaurantId || typeof restaurantId !== 'string') {
    return res.status(400).json(err('Missing restaurantId', 'MISSING_ID'));
  }

  await sql`
    DELETE FROM user_favorites WHERE user_id = ${userId} AND restaurant_id = ${restaurantId}
  `;

  logger.success('user.favorite.removed', { userId, restaurantId });
  return res.status(200).json(ok({ restaurantId }));
}

export default withRequestLogging(withUser(handler));
