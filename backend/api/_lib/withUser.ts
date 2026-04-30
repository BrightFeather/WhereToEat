import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql, nowIso } from './db';
import { err } from './types';

export type UserHandler = (
  req: VercelRequest,
  res: VercelResponse,
  userId: string
) => Promise<void | VercelResponse>;

/**
 * Reads `X-User-Id` from the request, upserts the user row, and forwards
 * the id to the wrapped handler. The id is a device-scoped UUID produced
 * by the iOS client (Keychain-backed). When Apple/Google sign-in lands,
 * this middleware becomes the single point where we'd validate a real
 * identity token and map it to a user row.
 */
export function withUser(handler: UserHandler) {
  return async (req: VercelRequest, res: VercelResponse) => {
    const raw = req.headers['x-user-id'];
    const userId = Array.isArray(raw) ? raw[0] : raw;

    if (!userId || typeof userId !== 'string' || userId.length < 8) {
      return res.status(400).json(err('Missing X-User-Id header', 'MISSING_USER_ID'));
    }

    await sql`
      INSERT INTO users (id, last_seen_at) VALUES (${userId}, ${nowIso()})
      ON CONFLICT(id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
    `;

    return handler(req, res, userId);
  };
}
