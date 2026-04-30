import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../_lib/db';
import { logger, withRequestLogging } from '../_lib/logger';
import { ok, err } from '../_lib/types';
import { withUser } from '../_lib/withUser';

async function handler(req: VercelRequest, res: VercelResponse, userId: string) {
  if (req.method !== 'POST') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const displayName =
    req.body && typeof req.body === 'object' && typeof (req.body as { displayName?: unknown }).displayName === 'string'
      ? ((req.body as { displayName: string }).displayName || '').slice(0, 80)
      : null;

  if (displayName) {
    await sql`UPDATE users SET display_name = ${displayName} WHERE id = ${userId}`;
  }

  const [row] = await sql`
    SELECT id, display_name AS "displayName", created_at AS "createdAt"
    FROM users WHERE id = ${userId}
  `;

  logger.success('user.ensure', { userId });
  return res.status(200).json(ok(row));
}

export default withRequestLogging(withUser(handler));
