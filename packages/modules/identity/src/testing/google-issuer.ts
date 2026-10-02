import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWTVerifyGetKey,
} from 'jose';

/** The claims of an ID token a {@link GoogleTestIssuer} makes. */
export interface GoogleTestClaims {
  sub: string;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  given_name?: string;
  family_name?: string;
  /** Google's own unless given. */
  iss?: string;
  /** The issuer's client ID unless given. */
  aud?: string;
}

/**
 * Plays Google for tests of signing in with it (ADR-164): keys of its own, given to the identity
 * module in place of Google's, and ID tokens signed with them, as Google's sign-in gives apps.
 */
export class GoogleTestIssuer {
  private constructor(
    /** The client ID its tokens are for, unless told otherwise. */
    readonly clientId: string,
    /** Its public keys, for `google.keys`. */
    readonly keys: JWTVerifyGetKey,
    private readonly privateKey: CryptoKey,
  ) {}

  static async create(
    clientId = '123456789012-hatti-admin.apps.googleusercontent.com',
  ): Promise<GoogleTestIssuer> {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' };
    return new GoogleTestIssuer(clientId, createLocalJWKSet({ keys: [jwk] }), privateKey);
  }

  /**
   * An ID token saying `claims`, issued `at` (now unless given) and good for an hour, as Google's
   * are; signed by `signedBy` where given, under this one's key ID.
   */
  idToken(
    claims: GoogleTestClaims,
    options: { at?: Date; lifetimeSeconds?: number; signedBy?: GoogleTestIssuer } = {},
  ): Promise<string> {
    const { iss = 'https://accounts.google.com', aud = this.clientId, ...rest } = claims;
    const issuedAt = Math.floor((options.at ?? new Date()).getTime() / 1000);
    return new SignJWT({ ...rest, azp: aud })
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + (options.lifetimeSeconds ?? 3_600))
      .sign((options.signedBy ?? this).privateKey);
  }
}

const KEY_ID = 'hatti-test-key';
