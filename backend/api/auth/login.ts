import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { sql, nowIso } from '../_lib/db';
import { logger, withRequestLogging } from '../_lib/logger';
import { ok, err } from '../_lib/types';
import { verifyAppleIdToken } from '../_lib/appleAuth';
import { verifyGoogleIdToken } from '../_lib/googleAuth';

interface LoginBody {
  provider?: 'apple' | 'google';
  idToken?: string;
  /**
   * Pre-auth anonymous Keychain UUID. If present, we'll migrate any
   * reservations + favorites owned by that id over to the verified user row
   * before returning. The client then swaps the Keychain value for the
   * verified id so all future `X-User-Id` headers match.
   */
  anonymousUserId?: string;
  /**
   * Optional display name from the client. Apple only returns the user's
   * name on the *first* sign-in via `ASAuthorizationAppleIDCredential`; the
   * client forwards it here so we can persist it.
   */
  displayName?: string;
}

async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
  }

  const body = (req.body ?? {}) as LoginBody;
  const provider = body.provider;
  const idToken = body.idToken;

  if (!provider || (provider !== 'apple' && provider !== 'google')) {
    return res.status(400).json(err('Invalid provider', 'INVALID_PROVIDER'));
  }
  if (!idToken || typeof idToken !== 'string') {
    return res.status(400).json(err('Missing idToken', 'MISSING_TOKEN'));
  }

  // Verify the identity token against the provider's JWKS.
  let claims;
  try {
    claims = provider === 'apple'
      ? await verifyAppleIdToken(idToken)
      : await verifyGoogleIdToken(idToken);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('auth.verify_failed', { provider, reason: msg });
    return res.status(401).json(err(`Token verification failed: ${msg}`, 'TOKEN_INVALID'));
  }

  const sub = claims.sub;
  const email = typeof claims.email === 'string' ? claims.email : null;
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';

  // Look up existing user by provider sub. Two explicit branches because the
  // Neon/SQLite tagged-template can't interpolate identifiers portably.
  const rows = provider === 'apple'
    ? await sql`SELECT id, display_name AS "displayName", email FROM users WHERE apple_sub  = ${sub} LIMIT 1`
    : await sql`SELECT id, display_name AS "displayName", email FROM users WHERE google_sub = ${sub} LIMIT 1`;

  let userId: string;
  let displayName: string | null = (rows[0]?.displayName as string | null) ?? body.displayName ?? null;

  if (rows[0]) {
    userId = rows[0].id as string;
    // Refresh metadata from the token.
    await sql`
      UPDATE users
      SET email          = ${email ?? (rows[0].email as string | null)},
          email_verified = ${emailVerified ? 1 : 0},
          display_name   = ${displayName},
          last_seen_at   = ${nowIso()}
      WHERE id = ${userId}
    `;
    logger.success('auth.login.existing', { provider, userId });
  } else {
    // New user. Reuse the anonymous id if the client sent one and no other
    // provider-sub row already claims it — that way all the reservations
    // they booked pre-login stay on the same primary key.
    let candidateId = body.anonymousUserId && typeof body.anonymousUserId === 'string'
      ? body.anonymousUserId
      : null;

    if (candidateId) {
      const conflict = await sql`SELECT id FROM users WHERE id = ${candidateId} LIMIT 1`;
      if (conflict[0]) {
        // The anonymous row exists. Good — we'll promote it in place.
      } else {
        // The anonymous id was never ensured on the server; create the row.
        await sql`
          INSERT INTO users (id, auth_provider, created_at, last_seen_at)
          VALUES (${candidateId}, 'anonymous', ${nowIso()}, ${nowIso()})
        `;
      }
    } else {
      candidateId = crypto.randomUUID();
      await sql`
        INSERT INTO users (id, auth_provider, created_at, last_seen_at)
        VALUES (${candidateId}, 'anonymous', ${nowIso()}, ${nowIso()})
      `;
    }
    userId = candidateId;

    // Promote the row to an authenticated user keyed by provider sub.
    if (provider === 'apple') {
      await sql`
        UPDATE users
        SET auth_provider = 'apple',
            apple_sub     = ${sub},
            email         = ${email},
            email_verified= ${emailVerified ? 1 : 0},
            display_name  = ${displayName},
            last_seen_at  = ${nowIso()}
        WHERE id = ${userId}
      `;
    } else {
      await sql`
        UPDATE users
        SET auth_provider = 'google',
            google_sub    = ${sub},
            email         = ${email},
            email_verified= ${emailVerified ? 1 : 0},
            display_name  = ${displayName},
            last_seen_at  = ${nowIso()}
        WHERE id = ${userId}
      `;
    }

    logger.success('auth.login.new', { provider, userId });
  }

  // Migrate any records still keyed to the anonymous id (separate from
  // `userId`) over to the verified userId — covers the case where the user
  // had one anonymous id pre-login but an existing auth record already owned
  // a different userId for this provider.
  if (body.anonymousUserId && body.anonymousUserId !== userId) {
    await sql`UPDATE user_reservations SET user_id = ${userId} WHERE user_id = ${body.anonymousUserId}`;
    await sql`UPDATE user_favorites    SET user_id = ${userId} WHERE user_id = ${body.anonymousUserId}`;
    // Best-effort: remove the now-orphaned anonymous row. Ignore FK errors.
    try {
      await sql`DELETE FROM users WHERE id = ${body.anonymousUserId} AND auth_provider = 'anonymous'`;
    } catch { /* intentionally ignored */ }
    logger.success('auth.login.migrated', {
      from: body.anonymousUserId, to: userId
    });
  }

  return res.status(200).json(ok({
    userId,
    displayName,
    email,
    emailVerified,
    provider
  }));
}

export default withRequestLogging(handler);
