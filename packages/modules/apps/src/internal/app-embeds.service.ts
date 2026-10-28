import {
  deniedToRole,
  failOne,
  hasCapability,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppEvents } from './events.js';

// App embeds (DEV-06, ADR-852): a script an app, custom or public, offers the shop's storefront,
// as Shopify's theme app embeds are offered: a reviews widget, a chat, a size finder. The app
// names it and gives its https address; the shop's owner or a manager turns it on, never the app
// itself. The storefront loads the scripts turned on of the apps the shop still has.

export const APP_EMBED_LIMITS = { perApp: 10, name: 100, handle: 50, src: 500 } as const;

export interface AppEmbedRecord {
  id: string;
  /** The app offering it: its access token's ID. */
  appId: string;
  appName: string;
  handle: string;
  name: string;
  src: string;
  enabled: boolean;
  updatedAt: Date;
}

export interface AppEmbedInput {
  handle: string;
  name: string;
  src: string;
}

type EmbedRow = {
  id: string;
  token_id: string;
  app_name: string;
  handle: string;
  name: string;
  src: string;
  enabled: boolean;
  updated_at: Date | string;
};

const toRecord = (row: EmbedRow): AppEmbedRecord => ({
  id: row.id,
  appId: row.token_id,
  appName: row.app_name,
  handle: row.handle,
  name: row.name,
  src: row.src,
  enabled: row.enabled,
  updatedAt: toDate(row.updated_at),
});

const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The app calling, by its token; staff are refused, as an app offers its own scripts alone. */
function callingApp(tenant: TenantContext): string {
  if (tenant.actor.kind !== 'app') {
    throw deniedToRole('Access denied. Apps offer their own storefront scripts.');
  }
  return tenant.actor.tokenId;
}

/** Of the shop's apps' embeds, those an app still installed offers. */
const LIVE = sql`JOIN apps.access_tokens t ON t.shop_id = e.shop_id AND t.id = e.token_id
                  AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())`;

/** The scripts turned on, of apps the shop still has, for its storefront document. */
export async function appEmbedsIn(
  tx: Tx,
  shopId: string,
): Promise<{ src: string; app: string; handle: string }[]> {
  const { rows } = await tx.execute<{ src: string; app_name: string; handle: string }>(sql`
    SELECT e.src, t.name AS app_name, e.handle FROM apps.app_embeds e ${LIVE}
     WHERE e.shop_id = ${shopId} AND e.enabled
     ORDER BY e.created_at, e.id`);
  return rows.map((row) => ({ src: row.src, app: row.app_name, handle: row.handle }));
}

@Injectable()
export class AppEmbedService {
  constructor(private readonly db: Database) {}

  /** An app's own embeds; for staff, every app's the shop still has. */
  async list(tenant: TenantContext): Promise<AppEmbedRecord[]> {
    const own = tenant.actor.kind === 'app' ? tenant.actor.tokenId : null;
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<EmbedRow>(sql`
        SELECT e.id, e.token_id, t.name AS app_name, e.handle, e.name, e.src, e.enabled,
               e.updated_at
          FROM apps.app_embeds e ${LIVE}
         WHERE e.shop_id = ${tenant.shopId} ${own ? sql`AND e.token_id = ${own}` : sql``}
         ORDER BY t.name, e.created_at, e.id`),
    );
    return rows.map(toRecord);
  }

  /**
   * Offers the calling app's script `handle`, or changes it: off until the shop turns it on, and
   * off again when its address changes, for the shop to look at what it now loads.
   */
  async set(tenant: TenantContext, input: AppEmbedInput): Promise<MutationResult<AppEmbedRecord>> {
    const tokenId = callingApp(tenant);
    const handle = input.handle.trim();
    const name = input.name.trim();
    const src = input.src.trim();
    if (!HANDLE.test(handle) || handle.length > APP_EMBED_LIMITS.handle) {
      return failOne(['input', 'handle'], 'INVALID', 'Use lowercase letters, digits and dashes');
    }
    if (!name || name.length > APP_EMBED_LIMITS.name) {
      return failOne(
        ['input', 'name'],
        'INVALID',
        `Name it in ${APP_EMBED_LIMITS.name} characters at most`,
      );
    }
    if (!isHttps(src) || src.length > APP_EMBED_LIMITS.src) {
      return failOne(
        ['input', 'src'],
        'INVALID',
        `Give an https address of ${APP_EMBED_LIMITS.src} characters at most`,
      );
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: counted } = await tx.execute<{ count: number; mine: boolean }>(sql`
        SELECT count(*)::int AS count, bool_or(handle = ${handle}) AS mine FROM apps.app_embeds
         WHERE shop_id = ${tenant.shopId} AND token_id = ${tokenId}`);
      if (!counted[0]?.mine && (counted[0]?.count ?? 0) >= APP_EMBED_LIMITS.perApp) {
        return failOne<AppEmbedRecord>(
          ['input', 'handle'],
          'TOO_MANY',
          `An app offers ${APP_EMBED_LIMITS.perApp} scripts at most`,
        );
      }
      await tx.execute(sql`
        INSERT INTO apps.app_embeds (shop_id, token_id, handle, name, src)
        VALUES (${tenant.shopId}, ${tokenId}, ${handle}, ${name}, ${src})
        ON CONFLICT (shop_id, token_id, handle) DO UPDATE
           SET name = EXCLUDED.name, src = EXCLUDED.src, updated_at = now(),
               enabled = apps.app_embeds.enabled AND apps.app_embeds.src = EXCLUDED.src`);
      await this.#changed(tx, tenant.shopId, tokenId);
      return {
        ok: true,
        value: (await this.#one(
          tx,
          tenant.shopId,
          sql`e.token_id = ${tokenId} AND e.handle = ${handle}`,
        ))!,
      };
    });
  }

  /** Takes back the calling app's script `handle`. */
  async remove(tenant: TenantContext, handle: string): Promise<MutationResult<string>> {
    const tokenId = callingApp(tenant);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        DELETE FROM apps.app_embeds
         WHERE shop_id = ${tenant.shopId} AND token_id = ${tokenId} AND handle = ${handle}
        RETURNING id`);
      if (!rows[0])
        return failOne<string>(['handle'], 'NOT_FOUND', 'The app offers no such script');
      await this.#changed(tx, tenant.shopId, tokenId);
      return { ok: true, value: rows[0].id };
    });
  }

  /** Turns an app's script on or off on the storefront: the owner's and managers' to do. */
  async enable(
    tenant: TenantContext,
    id: string,
    enabled: boolean,
  ): Promise<MutationResult<AppEmbedRecord>> {
    if (tenant.actor.kind !== 'staff' || !hasCapability(tenant.actor, 'manage_apps')) {
      throw deniedToRole("Access denied. The owner and managers turn apps' scripts on.");
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const found = await this.#one(tx, tenant.shopId, sql`e.id = ${id}`);
      if (!found) return failOne<AppEmbedRecord>(['id'], 'NOT_FOUND', 'No app offers this script');
      await tx.execute(sql`
        UPDATE apps.app_embeds SET enabled = ${enabled}, updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      await this.#changed(tx, tenant.shopId, found.appId);
      return { ok: true, value: { ...found, enabled } };
    });
  }

  async #one(
    tx: Tx,
    shopId: string,
    where: ReturnType<typeof sql>,
  ): Promise<AppEmbedRecord | null> {
    const { rows } = await tx.execute<EmbedRow>(sql`
      SELECT e.id, e.token_id, t.name AS app_name, e.handle, e.name, e.src, e.enabled,
             e.updated_at
        FROM apps.app_embeds e ${LIVE}
       WHERE e.shop_id = ${shopId} AND ${where}`);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async #changed(tx: Tx, shopId: string, tokenId: string): Promise<void> {
    await appendEvent(tx, shopId, {
      type: AppEvents.EmbedsUpdated,
      aggregateType: 'app',
      aggregateId: tokenId,
      payload: {},
    });
  }
}

function isHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}
