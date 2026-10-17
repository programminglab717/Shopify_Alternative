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
  type GoogleAnalyticsDeletedPayload,
  type GoogleAnalyticsUpdatedPayload,
} from './events.js';
import type { GoogleStream } from './google-client.js';
import type { ConversionMomentValue } from './meta.js';

/** How long what the shop gives may be. */
export const GOOGLE_LIMITS = { apiSecret: 200 } as const;

/** The shop's Google Analytics stream, as the Admin API shows it: never its secret. */
export interface GoogleAnalyticsRecord {
  measurementId: string;
  /** The secret's last four characters. */
  secretHint: string;
  purchaseAt: ConversionMomentValue;
  updatedAt: Date;
}

/** Fields left out stay as they are. Connecting needs the measurement ID and a secret. */
export interface GoogleAnalyticsInput {
  measurementId?: string | null;
  apiSecret?: string | null;
  purchaseAt?: ConversionMomentValue | null;
}

/** The stream the worker sends the shop's events to, its secret opened. */
export interface GoogleStreamSettings extends GoogleStream {
  purchaseAt: ConversionMomentValue;
}

type SettingsRow = {
  measurement_id: string;
  api_secret: string;
  secret_hint: string;
  purchase_at: ConversionMomentValue;
  updated_at: string | Date;
};

/** What the shop's sealed secret is bound to: it opens for that shop alone. */
function sealedFor(shopId: string): string {
  return `google-analytics:${shopId}`;
}

/**
 * The shop's Google Analytics web stream (MKT-10, ADR-547): its measurement ID, and the
 * Measurement Protocol's API secret Google Analytics made for it, kept sealed and never shown
 * again, and which moment of an order is its purchase. Changes are audited, the secret never:
 * connecting sends customers' details to Google, hashed. A plan without the conversions API
 * connects nothing, as for Meta's and TikTok's (ADR-523).
 */
@Injectable()
export class GoogleAnalyticsService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    @Optional() private readonly allowance?: PlanAllowance,
  ) {}

  async get(tenant: TenantContext): Promise<GoogleAnalyticsRecord | null> {
    const row = await this.db.tenant(tenant.shopId, (tx) => settingsIn(tx, tenant.shopId));
    return row && toRecord(row);
  }

  /** Connects the shop's stream, or changes what is given, for moments sent from now on. */
  async update(
    tenant: TenantContext,
    input: GoogleAnalyticsInput,
  ): Promise<MutationResult<GoogleAnalyticsRecord>> {
    const check = new InputChecker();
    const measurementId =
      input.measurementId === undefined || input.measurementId === null
        ? undefined
        : checkMeasurementId(check, input.measurementId);
    const apiSecret =
      input.apiSecret === undefined || input.apiSecret === null
        ? undefined
        : checkApiSecret(check, input.apiSecret);
    if (!check.ok) return { ok: false, errors: check.errors };
    const existing = await this.get(tenant);
    if (!existing) {
      const plan = await this.allowance?.excludes(tenant.shopId, 'conversionsApi');
      if (plan) {
        return failOne(
          ['input'],
          'INVALID',
          planFeatureMessage(plan, 'Google Analytics for ads', 'connect it'),
        );
      }
    }

    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await settingsIn(tx, tenant.shopId, { lock: true });
      if (!current && measurementId === undefined) {
        return failOne(
          ['input', 'measurementId'],
          'BLANK',
          "Connecting Google needs the web stream's measurement ID",
        );
      }
      if (!current && apiSecret === undefined) {
        return failOne(
          ['input', 'apiSecret'],
          'BLANK',
          'Connecting Google needs a Measurement Protocol API secret',
        );
      }
      const opened = current && this.box.decrypt(current.api_secret, sealedFor(tenant.shopId));
      const next = {
        measurementId: measurementId ?? current!.measurement_id,
        purchaseAt: input.purchaseAt ?? current?.purchase_at ?? 'placed',
      };
      const changed = [
        ...(next.measurementId !== current?.measurement_id ? ['measurementId'] : []),
        ...(apiSecret !== undefined && apiSecret !== opened?.toString('utf8') ? ['apiSecret'] : []),
        ...(next.purchaseAt !== (current?.purchase_at ?? 'placed') ? ['purchaseAt'] : []),
      ];
      if (current && changed.length === 0) return { ok: true, value: toRecord(current) };
      const sealed =
        apiSecret === undefined
          ? current!.api_secret
          : this.box.encrypt(apiSecret, sealedFor(tenant.shopId));
      const hint = apiSecret === undefined ? current!.secret_hint : apiSecret.slice(-4);
      await tx.execute(sql`
        INSERT INTO marketing.google_settings
               (shop_id, measurement_id, api_secret, secret_hint, purchase_at)
        VALUES (${tenant.shopId}, ${next.measurementId}, ${sealed}, ${hint}, ${next.purchaseAt})
            ON CONFLICT (shop_id) DO UPDATE
                   SET measurement_id = excluded.measurement_id,
                       api_secret = excluded.api_secret, secret_hint = excluded.secret_hint,
                       purchase_at = excluded.purchase_at,
                       version = marketing.google_settings.version + 1, updated_at = now()`);
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<GoogleAnalyticsUpdatedPayload>(tx, tenant.shopId, {
        type: MarketingEvents.GoogleAnalyticsUpdated,
        aggregateType: 'google_analytics',
        aggregateId: tenant.shopId,
        payload: { changed, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'google_analytics.updated',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: {
          changed,
          measurementId: next.measurementId,
          secretHint: hint,
          purchaseAt: next.purchaseAt,
          before: current && {
            measurementId: current.measurement_id,
            secretHint: current.secret_hint,
            purchaseAt: current.purchase_at,
          },
        },
      });
      return { ok: true, value: toRecord((await settingsIn(tx, tenant.shopId))!) };
    });
  }

  /**
   * Disconnects the shop's stream: its secret is forgotten, and moments still waiting for Google
   * are not sent. The measurement ID it had, or null when none was connected.
   */
  async delete(tenant: TenantContext): Promise<string | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows } = await tx.execute<{ measurement_id: string }>(sql`
        DELETE FROM marketing.google_settings WHERE shop_id = ${tenant.shopId}
        RETURNING measurement_id`);
      const measurementId = rows[0]?.measurement_id;
      if (!measurementId) return null;
      await tx.execute(sql`
        UPDATE marketing.conversions
           SET status = 'skipped', error = 'Not sent: the shop disconnected Google'
         WHERE shop_id = ${tenant.shopId} AND platform = 'google' AND status = 'pending'`);
      const actor = actorColumnsOf(tenant.actor);
      await appendEvent<GoogleAnalyticsDeletedPayload>(tx, tenant.shopId, {
        type: MarketingEvents.GoogleAnalyticsDeleted,
        aggregateType: 'google_analytics',
        aggregateId: tenant.shopId,
        payload: { measurementId, actorKind: actor.actorKind, actorId: actor.actorId },
      });
      await recordAudit(tx, tenant.shopId, {
        action: 'google_analytics.deleted',
        subjectType: 'shop',
        subjectId: tenant.shopId,
        ...actor,
        details: { measurementId },
      });
      return measurementId;
    });
  }

  /** The stream the worker sends the shop's events to, its secret opened; null if none. */
  async streamOf(shopId: string): Promise<GoogleStreamSettings | null> {
    const row = await this.db.tenant(shopId, (tx) => settingsIn(tx, shopId));
    if (!row) return null;
    return {
      measurementId: row.measurement_id,
      apiSecret: this.box.decrypt(row.api_secret, sealedFor(shopId)).toString('utf8'),
      purchaseAt: row.purchase_at,
    };
  }
}

/**
 * The shop's Google Analytics measurement ID while it has Google connected, for its storefront's
 * pages to load Google's tag (ADR-548), in the caller's transaction; null while it has none.
 */
export async function googleMeasurementIdIn(tx: Tx, shopId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ measurement_id: string }>(sql`
    SELECT measurement_id FROM marketing.google_settings WHERE shop_id = ${shopId}`);
  return rows[0]?.measurement_id ?? null;
}

async function settingsIn(
  tx: Tx,
  shopId: string,
  options: { lock?: boolean } = {},
): Promise<SettingsRow | null> {
  const { rows } = await tx.execute<SettingsRow>(sql`
    SELECT measurement_id, api_secret, secret_hint, purchase_at, updated_at
      FROM marketing.google_settings
     WHERE shop_id = ${shopId}
     ${options.lock ? sql`FOR UPDATE` : sql``}`);
  return rows[0] ?? null;
}

function toRecord(row: SettingsRow): GoogleAnalyticsRecord {
  return {
    measurementId: row.measurement_id,
    secretHint: row.secret_hint,
    purchaseAt: row.purchase_at,
    updatedAt: toDate(row.updated_at),
  };
}

/** A web stream's measurement ID, as Google Analytics shows it: "G-" and letters and digits. */
function checkMeasurementId(check: InputChecker, value: string): string | undefined {
  const measurementId = value.replace(/\s/g, '').toUpperCase();
  if (!/^G-[A-Z0-9]{4,20}$/.test(measurementId)) {
    check.add(
      ['input', 'measurementId'],
      'INVALID',
      'must be the web stream\'s measurement ID, as "G-" and 4 to 20 letters and digits',
    );
    return undefined;
  }
  return measurementId;
}

/** A secret as Google Analytics makes it: letters, digits and marks, without spaces. */
function checkApiSecret(check: InputChecker, value: string): string | undefined {
  const secret = value.trim();
  if (secret.length < 10 || secret.length > GOOGLE_LIMITS.apiSecret || !/^[!-~]+$/.test(secret)) {
    check.add(
      ['input', 'apiSecret'],
      'INVALID',
      'must be the API secret Google Analytics made, as it made it',
    );
    return undefined;
  }
  return secret;
}
