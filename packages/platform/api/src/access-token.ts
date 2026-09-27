import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '@hatti/db';
import { isCurrencyCode } from '@hatti/money';
import { sql } from 'drizzle-orm';
import type { TenantContext } from './tenant.js';

/** Distinctive prefix, so secret scanners can recognise leaked tokens. */
export const ACCESS_TOKEN_PREFIX = 'hat_';
const ACCESS_TOKEN_PATTERN = /^hat_[A-Za-z0-9_-]{43}$/;

export interface GeneratedAccessToken {
  /** Shown to the user once, never stored. */
  token: string;
  /** SHA-256 of the token: what the database stores. */
  hash: Buffer;
  /** Last four characters, to tell tokens apart in lists. */
  hint: string;
}

export function generateAccessToken(): GeneratedAccessToken {
  const token = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashAccessToken(token), hint: token.slice(-4) };
}

export function hashAccessToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

interface ResolvedToken extends Record<string, unknown> {
  shop_id: string;
  token_id: string;
  scopes: string[];
  shop_currency: string;
}

/** Resolves an Admin API access token to its tenant context. */
export class AccessTokenAuthenticator {
  constructor(private readonly db: Db) {}

  /** Returns null for missing, malformed, unknown, revoked or expired tokens and inactive shops. */
  async authenticate(token: string | undefined): Promise<TenantContext | null> {
    if (!token || !ACCESS_TOKEN_PATTERN.test(token)) return null;
    const { rows } = await this.db.execute<ResolvedToken>(
      sql`select * from platform.resolve_access_token(${hashAccessToken(token)})`,
    );
    const row = rows[0];
    if (!row || !isCurrencyCode(row.shop_currency)) return null;
    return {
      shopId: row.shop_id,
      currency: row.shop_currency,
      actor: { kind: 'app', tokenId: row.token_id },
      scopes: new Set(row.scopes),
    };
  }
}
