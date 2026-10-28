import { createHmac, timingSafeEqual } from 'node:crypto';

// An embedded app's session token (DEV-06, ADR-852): opened inside Hatti's admin, an app's page
// gets `id_token` in its address, a JWT signed HS256 with the app's client secret, lasting a
// minute. The app checks it before trusting who is looking, and in which shop.

/** Who is looking, in which shop, as a checked session token says. */
export interface SessionClaims {
  /** The shop: "shop_…". */
  dest: string;
  /** The member of staff looking: "usr_…". */
  sub: string;
  /** Their session: "ses_…". */
  sid: string;
  /** The app's client ID. */
  aud: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

/**
 * The claims of `token` when it is Hatti's for this app and good now, a few seconds' clock skew
 * allowed; null otherwise.
 */
export function verifySessionToken(
  token: string | null | undefined,
  app: { clientId: string; clientSecret: string },
  now: Date = new Date(),
): SessionClaims | null {
  const parts = token?.split('.') ?? [];
  if (parts.length !== 3 || !app.clientSecret) return null;
  const [header, body, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', app.clientSecret).update(`${header}.${body}`).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: SessionClaims;
  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string };
    if (head.alg !== 'HS256') return null;
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionClaims;
  } catch {
    return null;
  }
  const seconds = Math.floor(now.getTime() / 1000);
  const skew = 5;
  if (claims.aud !== app.clientId) return null;
  if (!(claims.nbf - skew <= seconds && seconds < claims.exp + skew)) return null;
  return claims;
}
