import {
  InputChecker,
  actorColumnsOf,
  failOne,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  MarketingEvents,
  type MetaConversionsDeletedPayload,
  type MetaConversionsUpdatedPayload,
} from './events.js';
import type { MetaDataset } from './meta-client.js';
import type { ConversionMomentValue } from './meta.js';

/** How long what the shop gives may be. */
export const META_LIMITS = { accessToken: 1_000, testEventCode: 64 } as const;

/** The shop's Meta dataset, as the Admin API shows it: never its token. */
export interface MetaConversionsRecord {
  pixelId: string;
  /** The token's last four characters. */
  tokenHint: string;
  testEventCode: string | null;
  purchaseAt: ConversionMomentValue;
  updatedAt: Date;
}

/** Fields left out stay as they are; connecting needs the pixel's ID and a token. */
export interface MetaConversionsInput {
  pixelId?: string | null;
  accessToken?: string | null;
  /** Blank or null takes it away. */
  testEventCode?: string | null;
  purchaseAt?: ConversionMomentValue | null;
}

/** The dataset the worker sends the shop's events to, its token opened. */
export interface MetaDatasetSettings extends MetaDataset {
  purchaseAt: ConversionMomentValue;
}

type SettingsRow = {
  pixel_id: string;
  access_token: string;
  token_hint: string;
  test_event_code: string | null;
  purchase_at: ConversionMomentValue;
  updated_at: string | Date;
};

/** What the shop's sealed token is bound to: it opens for that shop alone. */
function sealedFor(shopId: string): string {
  return `meta-conversions:${shopId}`;
}

/**
 * The shop's Meta dataset (MKT-10, ADR-143): its pixel's ID, the access token Events Manager gave
 * it for the conversions API, kept sealed and never shown again, a code for test events while
 * the shop tries it out, and which moment of an order is its Purchase. Changes are audited, the
 * token never: connecting sends customers' details to Meta, hashed, as a stolen login might.
 */
@Injectable()
export class MetaConversionsService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
  ) {}

  async get(tenant: TenantContext): Promise<MetaConversionsRecord | null> {
    const row = await this.db.tenant(tenant.shopId, (tx) => settingsIn(tx, tenant.shopId));
    return row && toRecord(row);
  }

  /** Connects the shop's dataset, or changes what is given, for moments sent from now on. */
  async update(
    tenant: TenantContext,
    input: MetaConversionsInput,
  ): Promise<MutationResult<MetaConversionsRecord>> {
    const check = new InputChecker();
    const pixelId =
      input.pixelId === undefined || input.pixelId === null
        ? undefined
        : checkPixelId(check, input.pixelId);
    const accessToken =
      input.accessToken === undefined || input.accessToken === null
        ? undefined
        : checkAccessToken(check, input.accessToken);
    const testEventCode =
      input.testEventCode === undefined
        ? undefined
        : checkTestEventCode(check, input.testEventCode);
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await settingsIn(tx, tenant.shopId, { lock: true });
      if (!current && (pixelId === undefined || accessToken === undefined)) {
        return failOne(
          ['input', pixelId === undefined ? 'pixelId' : 'accessToken'],
          'BLANK',
          "Connecting Meta needs the pixel's ID and an access token for its conversions API",
        );
      }
      const opened = current && this.box.decrypt(current.access_token, sealedFor(tenant.shopId));
      const next = {
        pixelId: pixelId ?? current!.pixel_id,
        testEventCode:
          testEventCode === undefined ? (current?.test_event_code ?? null) : testEventCode,
        purchaseAt: input.purchaseAt ?? current?.purchase_at ?? 'placed',
      };
      const changed = [
        ...(next.pixelId !== current?.pixel_id ? ['pixelId'] : []),
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
        INSERT INTO marketing.meta_settings
               (shop_id, pixel_id, access_token, token_hint, test_event_code, purchase_at)
        VALUES (${tenant.shopId}, ${next.pixelId}, ${sealed}, ${hint}, ${next.testEventCode},
                ${next.purchaseAt})
            ON CONFLICT (shop_id) DO UPDATE
                   SET pixel_id = excluded.pixel_id, access_token = excluded.access_token,
                       token_hint = excluded.token_hint,
                       test_event_code = excluded.test_event_code,
                       purchase_at = excluded.purchase_at,
                       version = marketing.meta_settings.version + 1, updated_at = now()`);
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<MetaConversionsUpdatedPayload>(tx, tenant.shopId, {
        type: MarketingEvents.MetaConversionsUpdated,
        aggregateType: 'meta_conversions',
        aggregateId: tenant.shopId,
        payload: { changed, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'meta_conversions.updated',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: {
          changed,
          pixelId: next.pixelId,
          tokenHint: hint,
          testEventCode: next.testEventCode,
          purchaseAt: next.purchaseAt,
          before: current && {
            pixelId: current.pixel_id,
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
   * Disconnects the shop's dataset: its token is forgotten, and moments still waiting are not
   * sent. The pixel's ID it had, or null when none was connected.
   */
  async delete(tenant: TenantContext): Promise<string | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ pixel_id: string }>(sql`
        DELETE FROM marketing.meta_settings WHERE shop_id = ${tenant.shopId}
        RETURNING pixel_id`);
      const pixelId = rows[0]?.pixel_id;
      if (!pixelId) return null;
      await tx.execute(sql`
        UPDATE marketing.conversions
           SET status = 'skipped', error = 'Not sent: the shop disconnected Meta'
         WHERE shop_id = ${tenant.shopId} AND platform = 'meta' AND status = 'pending'`);
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<MetaConversionsDeletedPayload>(tx, tenant.shopId, {
        type: MarketingEvents.MetaConversionsDeleted,
        aggregateType: 'meta_conversions',
        aggregateId: tenant.shopId,
        payload: { pixelId, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'meta_conversions.deleted',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: { pixelId },
      });
      return pixelId;
    });
  }

  /** The dataset the worker sends the shop's events to, its token opened; null if none. */
  async datasetOf(shopId: string): Promise<MetaDatasetSettings | null> {
    const row = await this.db.tenant(shopId, (tx) => settingsIn(tx, shopId));
    if (!row) return null;
    return {
      pixelId: row.pixel_id,
      accessToken: this.box.decrypt(row.access_token, sealedFor(shopId)).toString('utf8'),
      testEventCode: row.test_event_code,
      purchaseAt: row.purchase_at,
    };
  }
}

async function settingsIn(
  tx: Tx,
  shopId: string,
  options: { lock?: boolean } = {},
): Promise<SettingsRow | null> {
  const { rows } = await tx.execute<SettingsRow>(sql`
    SELECT pixel_id, access_token, token_hint, test_event_code, purchase_at, updated_at
      FROM marketing.meta_settings
     WHERE shop_id = ${shopId}
     ${options.lock ? sql`FOR UPDATE` : sql``}`);
  return rows[0] ?? null;
}

function toRecord(row: SettingsRow): MetaConversionsRecord {
  return {
    pixelId: row.pixel_id,
    tokenHint: row.token_hint,
    testEventCode: row.test_event_code,
    purchaseAt: row.purchase_at,
    updatedAt: toDate(row.updated_at),
  };
}

/** A dataset's ID, as Events Manager shows it: its digits alone. */
function checkPixelId(check: InputChecker, value: string): string | undefined {
  const pixelId = value.replace(/\s/g, '');
  if (!/^[0-9]{6,20}$/.test(pixelId)) {
    check.add(['input', 'pixelId'], 'INVALID', "must be the pixel's ID: 6 to 20 digits");
    return undefined;
  }
  return pixelId;
}

/** A token as Events Manager makes it: letters, digits and marks, without spaces. */
function checkAccessToken(check: InputChecker, value: string): string | undefined {
  const token = value.trim();
  if (token.length < 20 || token.length > META_LIMITS.accessToken || !/^[!-~]+$/.test(token)) {
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
  if (!/^[A-Za-z0-9_-]+$/.test(code) || code.length > META_LIMITS.testEventCode) {
    check.add(['input', 'testEventCode'], 'INVALID', 'must be the code Events Manager shows');
    return null;
  }
  return code;
}
