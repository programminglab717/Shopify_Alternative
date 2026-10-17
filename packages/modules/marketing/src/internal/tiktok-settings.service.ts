import {
  InputChecker,
  PlanAllowance,
  actorColumnsOf,
  failOne,
  planFeatureMessage,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  MarketingEvents,
  type TikTokEventsDeletedPayload,
  type TikTokEventsUpdatedPayload,
} from './events.js';
import type { ConversionMomentValue } from './meta.js';
import type { TikTokPixel } from './tiktok-client.js';

/** How long what the shop gives may be. */
export const TIKTOK_LIMITS = { accessToken: 1_000, testEventCode: 64 } as const;

/** The shop's TikTok pixel, as the Admin API shows it: never its token. */
export interface TikTokEventsRecord {
  pixelCode: string;
  /** The token's last four characters. */
  tokenHint: string;
  testEventCode: string | null;
  purchaseAt: ConversionMomentValue;
  updatedAt: Date;
}

/** Fields left out stay as they are. Connecting needs the pixel's code and a token. */
export interface TikTokEventsInput {
  pixelCode?: string | null;
  accessToken?: string | null;
  /** Blank or null takes it away. */
  testEventCode?: string | null;
  purchaseAt?: ConversionMomentValue | null;
}

/** The pixel the worker sends the shop's events to, its token opened. */
export interface TikTokPixelSettings extends TikTokPixel {
  purchaseAt: ConversionMomentValue;
}

type SettingsRow = {
  pixel_code: string;
  access_token: string;
  token_hint: string;
  test_event_code: string | null;
  purchase_at: ConversionMomentValue;
  updated_at: string | Date;
};

/** What the shop's sealed token is bound to: it opens for that shop alone. */
function sealedFor(shopId: string): string {
  return `tiktok-events:${shopId}`;
}

/**
 * The shop's TikTok pixel (MKT-10, ADR-541): its code, the access token TikTok's Events Manager
 * gave it for the Events API, kept sealed and never shown again, a code for test events while the
 * shop tries it out, and which moment of an order is its purchase. Changes are audited, the token
 * never: connecting sends customers' details to TikTok, hashed. A plan without the conversions
 * API connects nothing, as for Meta's (ADR-523).
 */
@Injectable()
export class TikTokEventsService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    @Optional() private readonly allowance?: PlanAllowance,
  ) {}

  async get(tenant: TenantContext): Promise<TikTokEventsRecord | null> {
    const row = await this.db.tenant(tenant.shopId, (tx) => settingsIn(tx, tenant.shopId));
    return row && toRecord(row);
  }

  /** Connects the shop's pixel, or changes what is given, for moments sent from now on. */
  async update(
    tenant: TenantContext,
    input: TikTokEventsInput,
  ): Promise<MutationResult<TikTokEventsRecord>> {
    const check = new InputChecker();
    const pixelCode =
      input.pixelCode === undefined || input.pixelCode === null
        ? undefined
        : checkPixelCode(check, input.pixelCode);
    const accessToken =
      input.accessToken === undefined || input.accessToken === null
        ? undefined
        : checkAccessToken(check, input.accessToken);
    const testEventCode =
      input.testEventCode === undefined
        ? undefined
        : checkTestEventCode(check, input.testEventCode);
    if (!check.ok) return { ok: false, errors: check.errors };
    const existing = await this.get(tenant);
    if (!existing) {
      const plan = await this.allowance?.excludes(tenant.shopId, 'conversionsApi');
      if (plan) {
        return failOne(
          ['input'],
          'INVALID',
          planFeatureMessage(plan, "TikTok's Events API", 'connect it'),
        );
      }
    }

    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await settingsIn(tx, tenant.shopId, { lock: true });
      if (!current && pixelCode === undefined) {
        return failOne(['input', 'pixelCode'], 'BLANK', "Connecting TikTok needs the pixel's code");
      }
      if (!current && accessToken === undefined) {
        return failOne(
          ['input', 'accessToken'],
          'BLANK',
          'Connecting TikTok needs the access token Events Manager gave',
        );
      }
      const opened = current && this.box.decrypt(current.access_token, sealedFor(tenant.shopId));
      const next = {
        pixelCode: pixelCode ?? current!.pixel_code,
        testEventCode:
          testEventCode === undefined ? (current?.test_event_code ?? null) : testEventCode,
        purchaseAt: input.purchaseAt ?? current?.purchase_at ?? 'placed',
      };
      const changed = [
        ...(next.pixelCode !== current?.pixel_code ? ['pixelCode'] : []),
        ...(accessToken !== undefined && accessToken !== opened?.toString('utf8')
          ? ['accessToken']
          : []),
        ...(next.testEventCode !== (current?.test_event_code ?? null) ? ['testEventCode'] : []),
        ...(next.purchaseAt !== (current?.purchase_at ?? 'placed') ? ['purchaseAt'] : []),
      ];
      if (current && changed.length === 0) return { ok: true, value: toRecord(current) };
      const sealed =
        accessToken === undefined
          ? current!.access_token
          : this.box.encrypt(accessToken, sealedFor(tenant.shopId));
      const hint = accessToken === undefined ? current!.token_hint : accessToken.slice(-4);
      await tx.execute(sql`
        INSERT INTO marketing.tiktok_settings
               (shop_id, pixel_code, access_token, token_hint, test_event_code, purchase_at)
        VALUES (${tenant.shopId}, ${next.pixelCode}, ${sealed}, ${hint}, ${next.testEventCode},
                ${next.purchaseAt})
            ON CONFLICT (shop_id) DO UPDATE
                   SET pixel_code = excluded.pixel_code, access_token = excluded.access_token,
                       token_hint = excluded.token_hint,
                       test_event_code = excluded.test_event_code,
                       purchase_at = excluded.purchase_at,
                       version = marketing.tiktok_settings.version + 1, updated_at = now()`);
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<TikTokEventsUpdatedPayload>(tx, tenant.shopId, {
        type: MarketingEvents.TikTokEventsUpdated,
        aggregateType: 'tiktok_events',
        aggregateId: tenant.shopId,
        payload: { changed, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'tiktok_events.updated',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: {
          changed,
          pixelCode: next.pixelCode,
          tokenHint: hint,
          testEventCode: next.testEventCode,
          purchaseAt: next.purchaseAt,
          before: current && {
            pixelCode: current.pixel_code,
            tokenHint: current.token_hint,
            testEventCode: current.test_event_code,
            purchaseAt: current.purchase_at,
          },
        },
      });
      return { ok: true, value: toRecord((await settingsIn(tx, tenant.shopId))!) };
    });
  }

  /**
   * Disconnects the shop's pixel: its token is forgotten, and moments still waiting for TikTok are
   * not sent. The pixel's code it had, or null when none was connected.
   */
  async delete(tenant: TenantContext): Promise<string | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ pixel_code: string }>(sql`
        DELETE FROM marketing.tiktok_settings WHERE shop_id = ${tenant.shopId}
        RETURNING pixel_code`);
      const pixelCode = rows[0]?.pixel_code;
      if (!pixelCode) return null;
      await tx.execute(sql`
        UPDATE marketing.conversions
           SET status = 'skipped', error = 'Not sent: the shop disconnected TikTok'
         WHERE shop_id = ${tenant.shopId} AND platform = 'tiktok' AND status = 'pending'`);
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<TikTokEventsDeletedPayload>(tx, tenant.shopId, {
        type: MarketingEvents.TikTokEventsDeleted,
        aggregateType: 'tiktok_events',
        aggregateId: tenant.shopId,
        payload: { pixelCode, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'tiktok_events.deleted',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: { pixelCode },
      });
      return pixelCode;
    });
  }

  /** The pixel the worker sends the shop's events to, its token opened; null if none. */
  async pixelOf(shopId: string): Promise<TikTokPixelSettings | null> {
    const row = await this.db.tenant(shopId, (tx) => settingsIn(tx, shopId));
    if (!row) return null;
    return {
      pixelCode: row.pixel_code,
      accessToken: this.box.decrypt(row.access_token, sealedFor(shopId)).toString('utf8'),
      testEventCode: row.test_event_code,
      purchaseAt: row.purchase_at,
    };
  }
}

/**
 * The shop's TikTok pixel's code while it has TikTok connected, for its storefront's pages to load
 * the pixel (ADR-543), in the caller's transaction; null while it has none.
 */
export async function tiktokPixelCodeIn(tx: Tx, shopId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ pixel_code: string }>(sql`
    SELECT pixel_code FROM marketing.tiktok_settings WHERE shop_id = ${shopId}`);
  return rows[0]?.pixel_code ?? null;
}

async function settingsIn(
  tx: Tx,
  shopId: string,
  options: { lock?: boolean } = {},
): Promise<SettingsRow | null> {
  const { rows } = await tx.execute<SettingsRow>(sql`
    SELECT pixel_code, access_token, token_hint, test_event_code, purchase_at, updated_at
      FROM marketing.tiktok_settings
     WHERE shop_id = ${shopId}
     ${options.lock ? sql`FOR UPDATE` : sql``}`);
  return rows[0] ?? null;
}

function toRecord(row: SettingsRow): TikTokEventsRecord {
  return {
    pixelCode: row.pixel_code,
    tokenHint: row.token_hint,
    testEventCode: row.test_event_code,
    purchaseAt: row.purchase_at,
    updatedAt: toDate(row.updated_at),
  };
}

/** A pixel's code, as TikTok's Events Manager shows it: capital letters and digits. */
function checkPixelCode(check: InputChecker, value: string): string | undefined {
  const pixelCode = value.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z0-9]{10,40}$/.test(pixelCode)) {
    check.add(
      ['input', 'pixelCode'],
      'INVALID',
      "must be the pixel's code: 10 to 40 letters and digits",
    );
    return undefined;
  }
  return pixelCode;
}

/** A token as Events Manager makes it: letters, digits and marks, without spaces. */
function checkAccessToken(check: InputChecker, value: string): string | undefined {
  const token = value.trim();
  if (token.length < 20 || token.length > TIKTOK_LIMITS.accessToken || !/^[!-~]+$/.test(token)) {
    check.add(
      ['input', 'accessToken'],
      'INVALID',
      'must be the access token Events Manager gave, as it gave it',
    );
    return undefined;
  }
  return token;
}

/** Events Manager's code for test events, "TEST12345"; null when blank. */
function checkTestEventCode(check: InputChecker, value: string | null): string | null {
  const code = value?.trim() ?? '';
  if (code === '') return null;
  if (!/^[A-Za-z0-9_-]+$/.test(code) || code.length > TIKTOK_LIMITS.testEventCode) {
    check.add(['input', 'testEventCode'], 'INVALID', 'must be the code Events Manager shows');
    return null;
  }
  return code;
}
