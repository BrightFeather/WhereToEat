import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql, nowIso } from '../../_lib/db';
import { logger, withRequestLogging } from '../../_lib/logger';
import { ok, err } from '../../_lib/types';
import { withUser } from '../../_lib/withUser';

interface BlockBody {
  restaurantId?: string;
  /** ISO8601 timestamp. Null / omitted = block forever. */
  blockedUntil?: string | null;
}

async function handler(req: VercelRequest, res: VercelResponse, userId: string) {
  if (req.method === 'GET') {
    // Active blocks only: blocked_until is null (forever) or still in the future.
    const now = nowIso();
    const rows = await sql`
      SELECT restaurant_id AS "restaurantId",
             blocked_until AS "blockedUntil",
             created_at    AS "createdAt"
      FROM user_blocked_restaurants
      WHERE user_id = ${userId}
        AND (blocked_until IS NULL OR blocked_until > ${now})
      ORDER BY created_at DESC
    `;
    return res.status(200).json(ok({ blocks: rows }));
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as BlockBody;
    const restaurantId = body.restaurantId;
    if (!restaurantId) {
      return res.status(400).json(err('Missing restaurantId', 'INVALID_BODY'));
    }

    const blockedUntil =
      typeof body.blockedUntil === 'string' && body.blockedUntil.length > 0
        ? body.blockedUntil
        : null;

    await sql`
      INSERT INTO user_blocked_restaurants (user_id, restaurant_id, blocked_until, created_at)
      VALUES (${userId}, ${restaurantId}, ${blockedUntil}, ${nowIso()})
      ON CONFLICT(user_id, restaurant_id) DO UPDATE SET
        blocked_until = excluded.blocked_until
    `;

    logger.success('user.block.added', { userId, restaurantId, blockedUntil });
    return res.status(200).json(ok({ restaurantId, blockedUntil }));
  }

  return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
}

export default withRequestLogging(withUser(handler));
