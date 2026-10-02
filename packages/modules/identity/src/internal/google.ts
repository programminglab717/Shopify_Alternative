import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

// Signing in with Google (ONB-01, ADR-164). The admin and Hatti's apps get an ID token from
// Google's own sign-in, "Sign in with Google" on the web and Google's SDKs in the apps, and send it
// here. It counts once checked against the keys Google publishes: signed by Google for one of
// Hatti's client IDs, unexpired, and carrying a nonce this API gave out. Google's `sub` names the
// account; its email counts only where Google confirmed it.

export const GOOGLE = {
  /** Who signs Google's ID tokens, as they name it. */
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
  /** Where Google publishes the keys it signs them with. */
  keysUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  /** Leeway for a clock a little off Google's, in seconds. */
  clockToleranceSeconds: 60,
} as const;

/** Where merchants sign in with Google. */
export interface GoogleSignInSettings {
  /**
   * The OAuth client IDs Hatti's admin and apps sign in with, the admin's first: a token Google
   * made for any other is refused.
   */
  clientIds: readonly string[];
  /** Google's keys: those it publishes, fetched and kept a while, unless given, as tests do. */
  keys?: JWTVerifyGetKey;
}

/** What a checked ID token says of its Google account. */
export interface GoogleAccount {
  /** Google's ID for the account (`sub`), which never changes and is never another's. */
  subject: string;
  /** Its email, where Google confirmed it is the account's; null otherwise. */
  email: string | null;
  /** Its name, as the account gives it, where it gives one. */
  name: string | null;
  /** The nonce the sign-in started with. */
  nonce: string;
}

export type GoogleCheck =
  { ok: true; account: GoogleAccount } | { ok: false; reason: 'invalid' | 'unreachable' };

/** Checks Google's ID tokens for Hatti's client IDs. */
export class GoogleIdTokens {
  readonly #clientIds: readonly string[];
  readonly #keys: JWTVerifyGetKey;

  constructor(settings: GoogleSignInSettings) {
    if (settings.clientIds.length === 0) throw new Error('Google sign-in needs a client ID');
    this.#clientIds = settings.clientIds;
    this.#keys = settings.keys ?? createRemoteJWKSet(new URL(GOOGLE.keysUrl));
  }

  /** The client ID the admin's sign-in starts with. */
  get clientId(): string {
    return this.#clientIds[0]!;
  }

  /** What `idToken` says of its account, as of `now`, where it is one of Google's for Hatti. */
  async check(idToken: string, now: Date): Promise<GoogleCheck> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.#keys, {
        issuer: [...GOOGLE.issuers],
        audience: [...this.#clientIds],
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
        currentDate: now,
        clockTolerance: GOOGLE.clockToleranceSeconds,
      }));
    } catch (error) {
      return { ok: false, reason: keysUnreachable(error) ? 'unreachable' : 'invalid' };
    }
    const { sub, nonce } = payload;
    if (typeof sub !== 'string' || !/^[!-~]{1,255}$/.test(sub) || typeof nonce !== 'string') {
      return { ok: false, reason: 'invalid' };
    }
    // Older tokens said it as a string.
    const confirmed = payload.email_verified === true || payload.email_verified === 'true';
    const email = confirmed && typeof payload.email === 'string' ? payload.email : null;
    return { ok: true, account: { subject: sub, email, name: nameOf(payload), nonce } };
  }
}

/** The account's name: its full name, else its given and family names; at most 255 characters. */
function nameOf(payload: JWTPayload): string | null {
  const parts =
    typeof payload.name === 'string' && payload.name.trim()
      ? [payload.name]
      : [payload.given_name, payload.family_name];
  const name = parts
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name ? Array.from(name).slice(0, 255).join('').trim() : null;
}

/**
 * Whether Google's keys could not be had: its endpoint down, slow, or answering with no keys. Any
 * other failure is the token's.
 */
function keysUnreachable(error: unknown): boolean {
  if (!(error instanceof errors.JOSEError)) return true;
  return (
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    error.code === errors.JOSEError.code
  );
}
