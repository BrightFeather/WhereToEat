import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../_lib/db';
import { logger, withRequestLogging } from '../../_lib/logger';
import { ok, err } from '../../_lib/types';
import { withUser } from '../../_lib/withUser';

async function handler(req: VercelRequest, res: VercelResponse, userId: string) {
  if (req.method !== 'DELETE') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const id = req.query.id;
  if (!id || typeof id !== 'string') {
    return res.status(400).json(err('Missing reservation id', 'MISSING_ID'));
  }

  await sql`
    DELETE FROM user_reservations WHERE id = ${id} AND user_id = ${userId}
  `;

  logger.success('user.reservation.deleted', { userId, id });
  return res.status(200).json(ok({ id }));
}

export default withRequestLogging(withUser(handler));
