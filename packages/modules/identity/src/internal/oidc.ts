import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicAddress } from '@hatti/api';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { createHash, randomBytes } from 'node:crypto';

// An OpenID Connect relying party, as Hatti is one for a shop's identity provider (ADR-864) and
// for its own, which signs Hatti's people in to its console (ADR-876): the provider's
// configuration and keys read from its issuer, an authorization code traded for the ID token with
// the client's secret and the PKCE verifier, and the token checked against the provider's keys,
// for that client, with the nonce sent. Addresses are fetched only where they are on the public
// internet, unless tests allow their own.

export const OIDC_LIMITS = {
  /** How long the provider has to answer Hatti. */
  timeoutMs: 10_000,
  /** How long a provider's configuration is kept. */
  discoveryMs: 60 * 60_000,
  clockToleranceSeconds: 60,
} as const;

/** A provider's OpenID configuration, as far as Hatti uses it. */
export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

/** Why the provider's answer gave no checked ID token. */
export type OidcProblem = 'unreachable' | 'refused' | 'invalid';

const base64url = (bytes: Buffer) => bytes.toString('base64url');

/** A PKCE verifier, and the challenge sent with the sign-in for it. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

/** The email the ID token's claims vouch for, lowercased; null where the provider says it isn't confirmed. */
export function confirmedEmailOf(payload: JWTPayload): string | null {
  const claimed =
    typeof payload.email === 'string'
      ? payload.email
      : typeof payload.preferred_username === 'string'
        ? payload.preferred_username
        : null;
  // A provider that says the email isn't confirmed is believed.
  const unconfirmed = payload.email_verified === false || payload.email_verified === 'false';
  return claimed && !unconfirmed ? claimed.trim().toLowerCase() : null;
}

export class OidcRelyingParty {
  readonly #allowPrivate: boolean;
  readonly #discovered = new Map<string, { at: number; discovery: OidcDiscovery }>();
  readonly #keys = new Map<string, JWTVerifyGetKey>();

  constructor(options: { allowPrivateAddresses?: boolean } = {}) {
    this.#allowPrivate = options.allowPrivateAddresses ?? false;
  }

  /** The provider's configuration, fetched once an hour; null where it can't be had. */
  async discover(issuer: string): Promise<OidcDiscovery | null> {
    const kept = this.#discovered.get(issuer);
    if (kept && Date.now() - kept.at < OIDC_LIMITS.discoveryMs) return kept.discovery;
    const at = `${issuer}/.well-known/openid-configuration`;
    try {
      if (!(await this.reachable(at))) return null;
      const response = await fetch(at, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(OIDC_LIMITS.timeoutMs),
      });
      if (!response.ok) return null;
      const discovery = (await response.json()) as Partial<OidcDiscovery>;
      if (
        discovery.issuer?.replace(/\/+$/, '') !== issuer ||
        typeof discovery.authorization_endpoint !== 'string' ||
        typeof discovery.token_endpoint !== 'string' ||
        typeof discovery.jwks_uri !== 'string' ||
        !this.addressOk(discovery.authorization_endpoint)
      ) {
        return null;
      }
      this.#discovered.set(issuer, { at: Date.now(), discovery: discovery as OidcDiscovery });
      return discovery as OidcDiscovery;
    } catch {
      return null;
    }
  }

  /**
   * The provider's answer, `code`, traded for its ID token with the client's secret and the PKCE
   * `verifier`, then checked: the provider's signature, its issuer, this client, the `nonce` sent
   * and its age. The token's claims, or why not.
   */
  async idTokenFor(input: {
    discovery: OidcDiscovery;
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    verifier: string;
    nonce: string;
    now: Date;
  }): Promise<{ payload: JWTPayload } | { problem: OidcProblem }> {
    const { discovery } = input;
    const basic = (
      discovery.token_endpoint_auth_methods_supported ?? ['client_secret_basic']
    ).includes('client_secret_basic');
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
      ...(basic ? {} : { client_id: input.clientId, client_secret: input.clientSecret }),
    });
    let idToken: unknown;
    try {
      if (!(await this.reachable(discovery.token_endpoint))) return { problem: 'unreachable' };
      const response = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          ...(basic && {
            authorization: `Basic ${Buffer.from(
              `${encodeURIComponent(input.clientId)}:${encodeURIComponent(input.clientSecret)}`,
            ).toString('base64')}`,
          }),
        },
        body: form.toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(OIDC_LIMITS.timeoutMs),
      });
      if (!response.ok) return { problem: 'refused' };
      idToken = ((await response.json()) as { id_token?: unknown }).id_token;
    } catch {
      return { problem: 'unreachable' };
    }
    if (typeof idToken !== 'string') return { problem: 'invalid' };
    const keys = await this.#keysOf(discovery.jwks_uri);
    if (!keys) return { problem: 'unreachable' };
    try {
      const { payload } = await jwtVerify(idToken, keys, {
        issuer: discovery.issuer,
        audience: input.clientId,
        requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
        currentDate: input.now,
        clockTolerance: OIDC_LIMITS.clockToleranceSeconds,
      });
      return payload.nonce === input.nonce ? { payload } : { problem: 'invalid' };
    } catch {
      return { problem: 'invalid' };
    }
  }

  /** Whether an address may be fetched from: https on a name, unless tests allow their own. */
  addressOk(value: string): boolean {
    try {
      const url = new URL(value);
      if (url.username || url.password) return false;
      return url.protocol === 'https:' || (this.#allowPrivate && url.protocol === 'http:');
    } catch {
      return false;
    }
  }

  /** Whether `value` is an address fetched from: every address its host has on the public internet. */
  async reachable(value: string): Promise<boolean> {
    if (!this.addressOk(value)) return false;
    if (this.#allowPrivate) return true;
    const host = new URL(value).hostname.replace(/^\[|\]$/g, '');
    try {
      const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
      return addresses.length > 0 && addresses.every((each) => isPublicAddress(each.address));
    } catch {
      return false;
    }
  }

  async #keysOf(jwksUri: string): Promise<JWTVerifyGetKey | null> {
    if (!(await this.reachable(jwksUri))) return null;
    let keys = this.#keys.get(jwksUri);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: OIDC_LIMITS.timeoutMs });
      this.#keys.set(jwksUri, keys);
    }
    return keys;
  }
}
