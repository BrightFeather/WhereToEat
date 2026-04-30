import { verifyIdentityToken, VerifiedClaims } from './jwtVerify';

const APPLE_JWKS = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';

/**
 * Verify a Sign in with Apple identity token. `aud` must be the iOS bundle id
 * (what Apple issues tokens for when "Sign in with Apple" is configured on
 * the bundle id directly — no Service ID needed for native iOS sign-in).
 *
 * Expected env:
 *   APPLE_BUNDLE_IDS  Comma-separated list of accepted audiences (bundle ids).
 *                     Defaults to ["com.wheretoeat.app"] when unset.
 */
export async function verifyAppleIdToken(token: string): Promise<VerifiedClaims> {
  const raw = process.env.APPLE_BUNDLE_IDS ?? 'com.wheretoeat.app';
  const audiences = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return verifyIdentityToken(token, APPLE_JWKS, {
    issuers: [APPLE_ISSUER],
    audiences
  });
}
