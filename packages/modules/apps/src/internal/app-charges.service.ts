import {
  InputChecker,
  deniedToRole,
  fail,
  failOne,
  shopProfile,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppEvents } from './events.js';

// Apps' one-time charges (DEV-05, ADR-854), Hatti's billing API for public apps, as Shopify's
// appPurchaseOneTimeCreate: an installed app asks the shop for a price in rupees, for something
// it names, and sends the owner to approve it in the admin. Approved, billing invoices it; paid,
// it is the app's to honour, and its partner earns their share. On a development store a charge
// is a test: approved, it is paid at once, with no money moving.

export const APP_CHARGE_LIMITS = {
  name: 100,
  /** Paisa: Rs 50 to Rs 500,000. */
  least: 5_000n,
  most: 50_000_000n,
  url: 500,
} as const;

export type AppChargeStatus = 'pending' | 'accepted' | 'paid' | 'declined';

export interface AppChargeRecord {
  id: string;
  /** The install asking: its access token's ID. */
  appId: string;
  publicAppId: string;
  appName: string;
  name: string;
  /** Paisa. */
  price: bigint;
  returnUrl: string;
  test: boolean;
  status: AppChargeStatus;
  /** The invoice paying it, once accepted; none for a test. */
  invoiceId: string | null;
  createdAt: Date;
}

type ChargeRow = {
  id: string;
  token_id: string;
  public_app_id: string;
  app_name: string;
  name: string;
  price: string;
  return_url: string;
  test: boolean;
  status: AppChargeStatus;
  invoice_id: string | null;
  created_at: Date | string;
};

const toRecord = (row: ChargeRow): AppChargeRecord => ({
  id: row.id,
  appId: row.token_id,
  publicAppId: row.public_app_id,
  appName: row.app_name,
  name: row.name,
  price: BigInt(row.price),
  returnUrl: row.return_url,
  test: row.test,
  status: row.status,
  invoiceId: row.invoice_id,
  createdAt: toDate(row.created_at),
});

const COLUMNS = sql`c.id, c.token_id, c.public_app_id, t.name AS app_name, c.name,
                    c.price::text, c.return_url, c.test, c.status, c.invoice_id, c.created_at`;

@Injectable()
export class AppChargeService {
  constructor(private readonly db: Database) {}

  /**
   * Asks the shop to pay the calling public app `input.price` once, for `input.name`: the charge,
   * waiting for the owner, a test on a development store.
   */
  async create(
    tenant: TenantContext,
    input: { name: string; price: bigint; returnUrl: string },
  ): Promise<MutationResult<AppChargeRecord>> {
    if (tenant.actor.kind !== 'app') {
      throw deniedToRole('Access denied. An app charges the shop itself.');
    }
    const tokenId = tenant.actor.tokenId;
    const check = new InputChecker();
    const name = check.text(['name'], input.name, { required: true, max: APP_CHARGE_LIMITS.name });
    if (
      input.price % 100n !== 0n ||
      input.price < APP_CHARGE_LIMITS.least ||
      input.price > APP_CHARGE_LIMITS.most
    ) {
      check.addMessage(['price'], 'INVALID', 'A charge is Rs 50 to Rs 500,000, in whole rupees');
    }
    if (!isHttps(input.returnUrl) || input.returnUrl.length > APP_CHARGE_LIMITS.url) {
      check.addMessage(
        ['returnUrl'],
        'INVALID',
        `Give an https address of ${APP_CHARGE_LIMITS.url} characters at most`,
      );
    }
    if (!check.ok || name === null) return fail(check.errors);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const { rows: apps } = await tx.execute<{ public_app_id: string | null }>(sql`
        SELECT public_app_id FROM apps.access_tokens
         WHERE shop_id = ${tenant.shopId} AND id = ${tokenId}`);
      const publicAppId = apps[0]?.public_app_id;
      if (!publicAppId) {
        return failOne<AppChargeRecord>(
          [],
          'INVALID',
          "Custom apps don't charge the shop: public apps do",
        );
      }
      const test = (await shopProfile(tx, tenant.shopId)).development;
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO apps.app_charges
               (shop_id, token_id, public_app_id, name, price, return_url, test)
        VALUES (${tenant.shopId}, ${tokenId}, ${publicAppId}, ${name}, ${input.price},
                ${input.returnUrl}, ${test})
        RETURNING id`);
      return { ok: true, value: (await this.#one(tx, tenant.shopId, rows[0]!.id))! };
    });
  }

  /** A charge of the shop's: the calling app's own alone; for staff, any app's. */
  async get(tenant: TenantContext, id: string): Promise<AppChargeRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const charge = await this.#one(tx, tenant.shopId, id);
      if (!charge) return null;
      if (tenant.actor.kind === 'app' && charge.appId !== tenant.actor.tokenId) return null;
      return charge;
    });
  }

  /** The calling app's charges, the latest first; for staff, every app's. */
  async list(tenant: TenantContext): Promise<AppChargeRecord[]> {
    const own = tenant.actor.kind === 'app' ? tenant.actor.tokenId : null;
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<ChargeRow>(sql`
        SELECT ${COLUMNS} FROM apps.app_charges c
          JOIN apps.access_tokens t ON t.shop_id = c.shop_id AND t.id = c.token_id
         WHERE c.shop_id = ${tenant.shopId} ${own ? sql`AND c.token_id = ${own}` : sql``}
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT 100`),
    );
    return rows.map(toRecord);
  }

  /**
   * The owner's answer to a charge waiting: declined, or accepted with the invoice that pays it;
   * a test paid at once. A charge accepted whose invoice gave way to another is accepted anew.
   */
  async answer(
    tenant: TenantContext,
    id: string,
    answer: { declined: true } | { invoiceId: string | null },
  ): Promise<MutationResult<AppChargeRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const charge = await this.#one(tx, tenant.shopId, id, true);
      if (!charge) return failOne<AppChargeRecord>(['id'], 'NOT_FOUND', 'No app asked this charge');
      if (charge.status === 'paid' || charge.status === 'declined') {
        return failOne<AppChargeRecord>(['id'], 'INVALID', 'The charge was answered already');
      }
      const status: AppChargeStatus =
        'declined' in answer ? 'declined' : charge.test ? 'paid' : 'accepted';
      const invoiceId = 'declined' in answer ? null : answer.invoiceId;
      await tx.execute(sql`
        UPDATE apps.app_charges SET status = ${status}, invoice_id = ${invoiceId}, updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      if (status !== 'accepted') await this.#answered(tx, tenant.shopId, id, charge.appId, status);
      return { ok: true, value: { ...charge, status, invoiceId } };
    });
  }

  /** The charge `id` paid, as billing says its invoice was: once. */
  async paid(shopId: string, id: string): Promise<boolean> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute(sql`
        UPDATE apps.app_charges SET status = 'paid', updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${id} AND status = 'accepted'
        RETURNING token_id`);
      const charged = rows[0] as { token_id: string } | undefined;
      if (!charged) return false;
      await this.#answered(tx, shopId, id, charged.token_id, 'paid');
      return true;
    });
  }

  async #one(tx: Tx, shopId: string, id: string, lock = false): Promise<AppChargeRecord | null> {
    const { rows } = await tx.execute<ChargeRow>(sql`
      SELECT ${COLUMNS} FROM apps.app_charges c
        JOIN apps.access_tokens t ON t.shop_id = c.shop_id AND t.id = c.token_id
       WHERE c.shop_id = ${shopId} AND c.id = ${id}
       ${lock ? sql`FOR UPDATE OF c` : sql``}`);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** The charge answered or paid, for the app that asked it to hear (ADR-914). */
  async #answered(
    tx: Tx,
    shopId: string,
    id: string,
    appId: string,
    status: AppChargeStatus,
  ): Promise<void> {
    await appendEvent(tx, shopId, {
      type: AppEvents.ChargeUpdated,
      aggregateType: 'app_charge',
      aggregateId: id,
      payload: { status, appId },
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
