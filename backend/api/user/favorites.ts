import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../_lib/db';
import { logger, withRequestLogging } from '../_lib/logger';
import { ok, err } from '../_lib/types';
import { withUser } from '../_lib/withUser';

/**
 * Single-route favorites endpoint — GET / POST / DELETE in one file so we
 * stay under the Hobby 12-function cap. The previous split between
 * `index.ts` (GET/POST) and `[restaurantId].ts` (DELETE) is consolidated
 * here; DELETE now reads `?restaurantId=…` from the query string.
 *
 * Schema:
 *   user_favorites(user_id, restaurant_id, saved_at, snapshot_json JSONB)
 * `snapshot_json` carries the full iOS `Restaurant` payload at save time so
 * custom-list imports (paste-link / share-sheet — restaurants that aren't
 * in `xhs_restaurants`) round-trip across devices. Weekly-deck restaurants
 * may pass `snapshot_json: null` and the iOS client re-hydrates from the
 * weekly cache when an id matches.
 */
async function handler(req: VercelRequest, res: VercelResponse, userId: string) {
  if (req.method === 'GET') {
    const rows = await sql`
      SELECT
        restaurant_id AS "restaurantId",
        saved_at      AS "savedAt",
        snapshot_json AS "snapshot"
      FROM user_favorites
      WHERE user_id = ${userId}
      ORDER BY saved_at DESC
    `;
    return res.status(200).json(ok({ favorites: rows }));
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as { restaurantId?: string; snapshot?: unknown };
    const restaurantId = body.restaurantId;
    if (!restaurantId || typeof restaurantId !== 'string') {
      return res.status(400).json(err('Missing restaurantId', 'INVALID_BODY'));
    }
    // Stringify defensively — Neon's tagged template handles JSONB but only
    // when the value is a JSON string. Pass `null` through unchanged.
    const snapshot = body.snapshot == null ? null : JSON.stringify(body.snapshot);

    await sql`
      INSERT INTO user_favorites (user_id, restaurant_id, snapshot_json)
      VALUES (${userId}, ${restaurantId}, ${snapshot})
      ON CONFLICT(user_id, restaurant_id)
        DO UPDATE SET snapshot_json = EXCLUDED.snapshot_json
    `;

    logger.success('user.favorite.saved', { userId, restaurantId, hasSnapshot: snapshot != null });
    return res.status(200).json(ok({ restaurantId }));
  }

  if (req.method === 'DELETE') {
    const restaurantId = (req.query.restaurantId as string | undefined)
      ?? (req.body && (req.body as { restaurantId?: string }).restaurantId);
    if (!restaurantId || typeof restaurantId !== 'string') {
      return res.status(400).json(err('Missing restaurantId', 'INVALID_QUERY'));
    }
    await sql`
      DELETE FROM user_favorites
      WHERE user_id = ${userId} AND restaurant_id = ${restaurantId}
    `;
    logger.success('user.favorite.removed', { userId, restaurantId });
    return res.status(200).json(ok({ restaurantId }));
  }

  return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
}

export default withRequestLogging(withUser(handler));
