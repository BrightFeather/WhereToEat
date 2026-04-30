import { verifyIdentityToken, VerifiedClaims } from './jwtVerify';

const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Verify a Google Sign-In ID token. `aud` must be the iOS OAuth client id from
 * Google Cloud Console (the one configured in the iOS app's GIDSignIn).
 *
 * Expected env:
 *   GOOGLE_IOS_CLIENT_IDS  Comma-separated list of accepted audiences.
 */
export async function verifyGoogleIdToken(token: string): Promise<VerifiedClaims> {
  const raw = process.env.GOOGLE_IOS_CLIENT_IDS ?? '';
  const audiences = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (audiences.length === 0) {
    throw new Error('GOOGLE_IOS_CLIENT_IDS env var is not set');
  }
  return verifyIdentityToken(token, GOOGLE_JWKS, {
    issuers: GOOGLE_ISSUERS,
    audiences
  });
}
