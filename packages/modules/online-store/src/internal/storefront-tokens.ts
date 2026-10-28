import { createHash, randomBytes } from 'node:crypto';
import { failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { OnlineStoreEvents } from './events.js';

// Storefront access tokens (DEV-02, ADR-848): what the Storefront API answers headless
// storefronts and shopping apps by. A public token is sent from shoppers' browsers, so anyone may
// see it; a private one stays on the shop's own server. Each is shown once, when it is made, and
// kept as its SHA-256 digest; the shop's storefront document carries the digests, which the
// storefront checks each request against. Deleted, a token stops working once the document is
// written again, a moment later.

export const STOREFRONT_TOKEN_LIMITS = { title: 100, perShop: 100 } as const;

export type StorefrontTokenKind = 'public' | 'private';

export interface StorefrontTokenRecord {
  id: string;
  title: string;
  kind: StorefrontTokenKind;
  /** Its last four characters, to tell it by. */
  hint: string;
  createdAt: Date;
}

/** A token's digest as the storefront document carries it: SHA-256, as hex. */
export const storefrontTokenDigest = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

type TokenRow = {
  id: string;
  title: string;
  kind: StorefrontTokenKind;
  token_hint: string;
  created_at: Date | string;
};

const toRecord = (row: TokenRow): StorefrontTokenRecord => ({
  id: row.id,
  title: row.title,
  kind: row.kind,
  hint: row.token_hint,
  createdAt: new Date(row.created_at),
});

/** The shop's tokens' digests, and whether each is private, for its storefront document. */
export async function storefrontTokensIn(
  tx: Tx,
  shopId: string,
): Promise<{ digest: string; private: boolean }[]> {
  const { rows } = await tx.execute<{ digest: string; kind: StorefrontTokenKind }>(sql`
    SELECT encode(token_digest, 'hex') AS digest, kind
      FROM online_store.storefront_access_tokens
     WHERE shop_id = ${shopId}
     ORDER BY created_at, id`);
  return rows.map((row) => ({ digest: row.digest, private: row.kind === 'private' }));
}

@Injectable()
export class StorefrontTokenService {
  constructor(private readonly db: Database) {}

  /** The shop's tokens, oldest first. */
  async list(tenant: TenantContext): Promise<StorefrontTokenRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<TokenRow>(sql`
        SELECT id, title, kind, token_hint, created_at
          FROM online_store.storefront_access_tokens
         WHERE shop_id = ${tenant.shopId}
         ORDER BY created_at, id`),
    );
    return rows.map(toRecord);
  }

  /** A new token, `title` naming what uses it; the token itself given this once. */
  async create(
    tenant: TenantContext,
    input: { title: string; kind: StorefrontTokenKind },
  ): Promise<MutationResult<{ record: StorefrontTokenRecord; accessToken: string }>> {
    const title = input.title.trim();
    if (!title || title.length > STOREFRONT_TOKEN_LIMITS.title) {
      return failOne(
        ['input', 'title'],
        'INVALID',
        `Name what uses it, in ${STOREFRONT_TOKEN_LIMITS.title} characters at most`,
      );
    }
    // Told apart at a glance, as Shopify's are not: a private one is never sent from a page.
    const accessToken =
      (input.kind === 'private' ? 'hsfp_' : 'hsf_') + randomBytes(24).toString('base64url');
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: counted } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM online_store.storefront_access_tokens
         WHERE shop_id = ${tenant.shopId}`);
      if (counted[0]!.count >= STOREFRONT_TOKEN_LIMITS.perShop) {
        return failOne(
          ['base'],
          'TOO_MANY',
          `A shop has ${STOREFRONT_TOKEN_LIMITS.perShop} Storefront API tokens at most: delete one first`,
        );
      }
      const { rows } = await tx.execute<TokenRow>(sql`
        INSERT INTO online_store.storefront_access_tokens
               (shop_id, title, kind, token_digest, token_hint)
        VALUES (${tenant.shopId}, ${title}, ${input.kind},
                decode(${storefrontTokenDigest(accessToken)}, 'hex'), ${accessToken.slice(-4)})
        RETURNING id, title, kind, token_hint, created_at`);
      await this.#changed(tx, tenant.shopId);
      return { ok: true, value: { record: toRecord(rows[0]!), accessToken } };
    });
  }

  /** Deletes the token `id`; it stops working once the storefront has its document again. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<string>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        DELETE FROM online_store.storefront_access_tokens
         WHERE shop_id = ${tenant.shopId} AND id = ${id}
        RETURNING id`);
      if (rows.length === 0) return failOne(['id'], 'NOT_FOUND', 'No such token');
      await this.#changed(tx, tenant.shopId);
      return { ok: true, value: id };
    });
  }

  async #changed(tx: Tx, shopId: string): Promise<void> {
    await appendEvent(tx, shopId, {
      type: OnlineStoreEvents.StorefrontAccessTokensUpdated,
      aggregateType: 'shop',
      aggregateId: shopId,
      payload: {},
    });
  }
}
