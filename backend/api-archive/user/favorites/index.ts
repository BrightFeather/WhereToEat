import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../_lib/db';
import { logger, withRequestLogging } from '../../_lib/logger';
import { ok, err } from '../../_lib/types';
import { withUser } from '../../_lib/withUser';

async function handler(req: VercelRequest, res: VercelResponse, userId: string) {
  if (req.method === 'GET') {
    const rows = await sql`
      SELECT restaurant_id AS "restaurantId", saved_at AS "savedAt"
      FROM user_favorites
      WHERE user_id = ${userId}
      ORDER BY saved_at DESC
    `;
    return res.status(200).json(ok({ favorites: rows }));
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as { restaurantId?: string };
    const restaurantId = body.restaurantId;
    if (!restaurantId) {
      return res.status(400).json(err('Missing restaurantId', 'INVALID_BODY'));
    }

    await sql`
      INSERT INTO user_favorites (user_id, restaurant_id)
      VALUES (${userId}, ${restaurantId})
      ON CONFLICT(user_id, restaurant_id) DO NOTHING
    `;

    logger.success('user.favorite.added', { userId, restaurantId });
    return res.status(200).json(ok({ restaurantId }));
  }

  return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
}

export default withRequestLogging(withUser(handler));
