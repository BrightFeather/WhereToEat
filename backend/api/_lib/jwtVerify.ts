/**
 * Zero-dep JWT verification for Apple + Google identity tokens.
 *
 * Both providers publish RSA public keys as JWKS. We fetch + cache the JWKS,
 * match the token's `kid`, convert the JWK's n/e to a DER SubjectPublicKeyInfo,
 * and verify with Node's built-in `crypto`. Keeping this dep-free avoids
 * pulling `jose` / `jsonwebtoken` into the 12-function Vercel bundle.
 */
import crypto from 'crypto';

interface JWKKey {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
}

interface JWKSet {
  keys: JWKKey[];
}

interface JWKSCache {
  keys: JWKKey[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour; JWKS rotate rarely
const jwksCache = new Map<string, JWKSCache>();

async function getJWKS(url: string): Promise<JWKKey[]> {
  const hit = jwksCache.get(url);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.keys;
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as JWKSet;
  jwksCache.set(url, { keys: body.keys, fetchedAt: Date.now() });
  return body.keys;
}

function base64UrlDecode(input: string): Buffer {
  const pad = '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from((input + pad).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Convert a JWK (n, e) into a PEM SPKI public key using Node's built-in JWK
 * import. Available since Node 16+ (so fine on @vercel/node runtime).
 */
function jwkToPem(jwk: JWKKey): crypto.KeyObject {
  return crypto.createPublicKey({
    key: { kty: jwk.kty, n: jwk.n, e: jwk.e } as crypto.JsonWebKey,
    format: 'jwk'
  });
}

export interface VerifiedClaims {
  sub: string;
  iss: string;
  aud: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  exp: number;
  iat: number;
  [k: string]: unknown;
}

export interface VerifyOptions {
  /** Allowed issuers — must match `iss`. */
  issuers: string[];
  /** Allowed audiences — typically the app's iOS bundle id / OAuth client id. */
  audiences: string[];
  /** Allow ~2min clock skew. */
  skewSeconds?: number;
}

/**
 * Verify a compact JWS identity token against a provider's JWKS.
 * Throws Error with a stable message on any failure (client sees a 401).
 */
export async function verifyIdentityToken(
  token: string,
  jwksUrl: string,
  opts: VerifyOptions
): Promise<VerifiedClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as {
    kid: string;
    alg: string;
  };
  if (header.alg !== 'RS256') throw new Error(`Unsupported alg: ${header.alg}`);

  const keys = await getJWKS(jwksUrl);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error(`No JWK matched kid=${header.kid}`);

  const pubKey = jwkToPem(jwk);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signature = base64UrlDecode(signatureB64);

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signingInput);
  verifier.end();
  const ok = verifier.verify(pubKey, signature);
  if (!ok) throw new Error('Bad signature');

  const claims = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as VerifiedClaims;
  const now = Math.floor(Date.now() / 1000);
  const skew = opts.skewSeconds ?? 120;

  if (typeof claims.exp !== 'number' || claims.exp + skew < now) {
    throw new Error('Token expired');
  }
  if (typeof claims.iat !== 'number' || claims.iat - skew > now) {
    throw new Error('Token issued in the future');
  }
  if (!opts.issuers.includes(claims.iss)) {
    throw new Error(`Untrusted issuer: ${claims.iss}`);
  }
  if (!opts.audiences.includes(claims.aud)) {
    throw new Error(`Untrusted audience: ${claims.aud}`);
  }
  if (!claims.sub) throw new Error('Missing sub');

  return claims;
}
