import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { tryFromPublicId } from '@hatti/ids';
import type { CurrencyCode } from '@hatti/money';
import {
  OnlinePayments,
  orderPaymentFactsIn,
  receiveOnlinePaymentIn,
  type OnlineGateway,
  type OrderPaymentFacts,
} from '@hatti/orders/public';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PaymentEvents, type PaymentSessionPayload } from './events.js';
import {
  GatewayAccountService,
  PAYMENT_GATEWAYS,
  gatewayAccountIn,
  liveGatewayAccountIn,
  type OpenedGatewayAccount,
} from './gateway-accounts.service.js';
import type {
  GatewayEnvironmentValue,
  GatewayPayment,
  GatewayWebhook,
  PaymentGateway,
  PaymentGateways,
} from './gateways.js';

/** How many payments an order starts, and how long one is offered again. */
export const SESSION_LIMITS = {
  /** Sessions an order starts at most, those the gateway refused included. */
  perOrder: 50,
  /** A session's checkout is offered again for this long, rather than a new one started. */
  reuseMinutes: 30,
} as const;

export const SESSION_STATUSES = ['open', 'paid', 'failed'] as const;
export type SessionStatusValue = (typeof SESSION_STATUSES)[number];

/** How Hatti heard that a session is paid: the customer coming back, or the gateway's webhook. */
export type PaidThroughValue = 'return' | 'webhook';

/** A payment session, as the Admin API shows it. */
export interface PaymentSessionRecord {
  id: string;
  orderId: string;
  accountId: string;
  gateway: string;
  gatewayName: string;
  environment: GatewayEnvironmentValue;
  /** Minor units: what the customer was asked to pay. */
  amount: bigint;
  currency: CurrencyCode;
  status: SessionStatusValue;
  /** The gateway's name for the payment, such as Safepay's tracker. */
  gatewayRef: string | null;
  /** Once paid: what was paid, and what of it went towards what the order owed. */
  paidAmount: bigint | null;
  applied: bigint | null;
  /** The gateway's reference for the payment. */
  reference: string | null;
  paidThrough: PaidThroughValue | null;
  paidAt: Date | null;
  /** Why the gateway would not start it. */
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type SessionRow = {
  id: string;
  account_id: string;
  order_id: string;
  environment: GatewayEnvironmentValue;
  amount: string;
  currency: string;
  status: SessionStatusValue;
  gateway_ref: string | null;
  checkout_url: string | null;
  paid_amount: string | null;
  applied: string | null;
  reference: string | null;
  paid_through: PaidThroughValue | null;
  paid_at: string | Date | null;
  error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  gateway: string;
};

const SESSION_COLUMNS = sql.raw(
  `s.id, s.account_id, s.order_id, s.environment, s.amount::text, s.currency, s.status,
   s.gateway_ref, s.checkout_url, s.paid_amount::text, s.applied::text, s.reference,
   s.paid_through, s.paid_at, s.error, s.created_at, s.updated_at, a.gateway`,
);
const SESSION_FROM = sql.raw(
  `payments.sessions s
   JOIN payments.gateway_accounts a ON a.shop_id = s.shop_id AND a.id = s.account_id`,
);

/** A session recorded, to start with its gateway; or what to answer at once. */
type Begun =
  | { url: string }
  | { error: string }
  | {
      session: string;
      account: OpenedGatewayAccount;
      gateway: PaymentGateway;
      order: OrderPaymentFacts;
    };

/** What became of a webhook's request. */
export type WebhookOutcome = 'not_found' | 'unsigned' | 'ignored' | 'paid';

/**
 * Paying orders online through the shop's own gateway account (PAY-01, PAY-04, ADR-151): a
 * session for what the order waits for, started before the customer is sent to the gateway's
 * page; then the gateway's signed return, or its signed webhook, whichever comes first, records
 * it paid, once, and pays what the order owes of it. A sandbox's payments pay nothing.
 */
@Injectable()
export class OnlinePaymentService extends OnlinePayments {
  constructor(
    private readonly db: Database,
    private readonly accounts: GatewayAccountService,
    @Inject(PAYMENT_GATEWAYS) private readonly gateways: PaymentGateways,
  ) {
    super();
  }

  async gatewayOf(tx: Tx, shopId: string, currency: CurrencyCode): Promise<OnlineGateway | null> {
    const account = await liveGatewayAccountIn(tx, shopId);
    const gateway = account && this.gateways.of(account.gateway);
    if (!account || !gateway || !gateway.info.currencies.includes(currency)) return null;
    const { name } = gateway.info;
    return {
      name: account.environment === 'sandbox' ? `${name} (test)` : name,
      origin: gateway.checkoutOrigin(account.environment),
    };
  }

  async start(
    shopId: string,
    orderId: string,
    urls: { returnUrl: string; cancelUrl: string },
  ): Promise<{ url: string } | { error: string }> {
    const begun = await this.db.tenant(shopId, async (tx): Promise<Begun> => {
      const order = await orderPaymentFactsIn(tx, shopId, orderId);
      if (!order || order.awaited <= 0n) return { error: 'The order waits for no payment' };
      const account = await liveGatewayAccountIn(tx, shopId);
      const gateway = account && this.gateways.of(account.gateway);
      if (!account || !gateway || !gateway.info.currencies.includes(order.currency)) {
        return { error: 'The shop takes no payments online' };
      }
      // The checkout started lately for the same amount, offered again.
      const { rows: recent } = await tx.execute<{ checkout_url: string }>(sql`
        SELECT checkout_url FROM payments.sessions
         WHERE shop_id = ${shopId} AND order_id = ${orderId} AND account_id = ${account.id}
           AND status = 'open' AND amount = ${order.awaited} AND checkout_url IS NOT NULL
           AND created_at > now() - ${`${SESSION_LIMITS.reuseMinutes} minutes`}::interval
         ORDER BY created_at DESC
         LIMIT 1`);
      if (recent[0]) return { url: recent[0].checkout_url };
      const { rows: counts } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM payments.sessions
         WHERE shop_id = ${shopId} AND order_id = ${orderId}`);
      if (counts[0]!.count >= SESSION_LIMITS.perOrder) {
        return { error: 'The order started as many payments as it may' };
      }
      // Recorded before the customer leaves for the gateway, whatever the gateway answers.
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO payments.sessions (shop_id, account_id, order_id, environment, amount,
                                       currency)
        VALUES (${shopId}, ${account.id}, ${orderId}, ${account.environment}, ${order.awaited},
                ${order.currency})
        RETURNING id`);
      return {
        session: rows[0]!.id,
        account: this.accounts.openedIn(shopId, account),
        gateway,
        order,
      };
    });
    if (!('session' in begun)) return begun;

    const { session, account, gateway, order } = begun;
    const checkout = await gateway.checkout(account, {
      amount: order.awaited,
      currency: order.currency,
      orderName: order.name,
      returnUrl: urls.returnUrl,
      cancelUrl: urls.cancelUrl,
    });
    return this.db.tenant(shopId, async (tx) => {
      const payload: PaymentSessionPayload = {
        orderId,
        accountId: account.id,
        gateway: gateway.info.gateway,
        amount: order.awaited.toString(),
      };
      if (!checkout.ok) {
        await tx.execute(sql`
          UPDATE payments.sessions
             SET status = 'failed', error = ${checkout.message.slice(0, 1_000)}, updated_at = now()
           WHERE shop_id = ${shopId} AND id = ${session}`);
        await appendEvent<PaymentSessionPayload>(tx, shopId, {
          type: PaymentEvents.PaymentSessionFailed,
          aggregateType: 'payment_session',
          aggregateId: session,
          payload: { ...payload, error: checkout.message.slice(0, 1_000) },
        });
        return { error: checkout.message };
      }
      await tx.execute(sql`
        UPDATE payments.sessions
           SET gateway_ref = ${checkout.value.ref}, checkout_url = ${checkout.value.url},
               updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${session}`);
      await appendEvent<PaymentSessionPayload>(tx, shopId, {
        type: PaymentEvents.PaymentSessionStarted,
        aggregateType: 'payment_session',
        aggregateId: session,
        payload,
      });
      return { url: checkout.value.url };
    });
  }

  async returned(
    shopId: string,
    orderId: string,
    form: Readonly<Record<string, string>>,
  ): Promise<'paid' | 'test' | null> {
    return this.db.tenant(shopId, async (tx) => {
      // The order's sessions with the gateway, each account asked whether the form is its own.
      const { rows: sessions } = await tx.execute<SessionRow>(sql`
        SELECT ${SESSION_COLUMNS}
          FROM ${SESSION_FROM}
         WHERE s.shop_id = ${shopId} AND s.order_id = ${orderId} AND s.gateway_ref IS NOT NULL
         ORDER BY s.created_at DESC
         LIMIT ${SESSION_LIMITS.perOrder}`);
      const accountIds = [...new Set(sessions.map((session) => session.account_id))];
      for (const accountId of accountIds) {
        const row = await gatewayAccountIn(tx, shopId, accountId);
        const gateway = row && this.gateways.of(row.gateway);
        if (!row || !gateway) continue;
        const payment = gateway.returned(this.accounts.openedIn(shopId, row), form);
        const session =
          payment &&
          sessions.find(
            (each) => each.account_id === accountId && each.gateway_ref === payment.ref,
          );
        if (!payment || !session) continue;
        const paid = await this.#complete(tx, shopId, session, gateway, payment, 'return');
        return paid.environment === 'sandbox' ? 'test' : 'paid';
      }
      return null;
    });
  }

  /**
   * A request to the webhook of the account `accountId` names, by its public ID: checked with
   * the account's secret, as its shop, and the payment it says is made recorded, once. Payments
   * not started here are left alone, as the shop's account may take others.
   */
  async webhook(accountId: string, request: GatewayWebhook): Promise<WebhookOutcome> {
    const id = tryFromPublicId(accountId, 'paymentGatewayAccount');
    if (!id) return 'not_found';
    const { rows: found } = await this.db.app.execute<{ shop_id: string }>(
      sql`SELECT shop_id FROM payments.resolve_gateway_account(${id})`,
    );
    const shopId = found[0]?.shop_id;
    if (!shopId) return 'not_found';
    return this.db.tenant(shopId, async (tx): Promise<WebhookOutcome> => {
      const row = await gatewayAccountIn(tx, shopId, id);
      const gateway = row && this.gateways.of(row.gateway);
      if (!row || !gateway) return 'not_found';
      const said = gateway.webhook(this.accounts.openedIn(shopId, row), request);
      if (said === 'unsigned') return 'unsigned';
      if (!said) return 'ignored';
      const { rows } = await tx.execute<SessionRow>(sql`
        SELECT ${SESSION_COLUMNS}
          FROM ${SESSION_FROM}
         WHERE s.shop_id = ${shopId} AND s.account_id = ${id} AND s.gateway_ref = ${said.ref}`);
      if (!rows[0]) return 'ignored';
      await this.#complete(tx, shopId, rows[0], gateway, said, 'webhook');
      return 'paid';
    });
  }

  /** An order's sessions, the latest first. */
  async sessionsOf(shopId: string, orderId: string): Promise<PaymentSessionRecord[]> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<SessionRow>(sql`
        SELECT ${SESSION_COLUMNS}
          FROM ${SESSION_FROM}
         WHERE s.shop_id = ${shopId} AND s.order_id = ${orderId}
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT ${SESSION_LIMITS.perOrder}`);
      return rows.map((row) => this.#toRecord(row));
    });
  }

  /**
   * Records the session paid, if it was not already, and what was paid on its order: the amount
   * the gateway signed, or the session's own when it signed none. Hearing it again changes
   * nothing. A sandbox's payment pays nothing on the order; its timeline says so.
   */
  async #complete(
    tx: Tx,
    shopId: string,
    session: SessionRow,
    gateway: PaymentGateway,
    payment: GatewayPayment,
    through: PaidThroughValue,
  ): Promise<SessionRow> {
    // The tracker's own amount when the gateway signed none, or signed it in another currency.
    const amount =
      payment.amount !== null && (payment.currency ?? session.currency) === session.currency
        ? payment.amount
        : BigInt(session.amount);
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE payments.sessions
         SET status = 'paid', paid_amount = ${amount}, reference = ${payment.reference},
             paid_through = ${through}, paid_at = now(), error = NULL, updated_at = now()
       WHERE shop_id = ${shopId} AND id = ${session.id} AND status = 'open'
      RETURNING id`);
    if (rows.length > 0) {
      const test = session.environment === 'sandbox';
      const receipt = await receiveOnlinePaymentIn(tx, shopId, {
        orderId: session.order_id,
        amount,
        gateway: gateway.info.name,
        reference: payment.reference,
        test,
      });
      const applied = receipt?.applied ?? 0n;
      await tx.execute(sql`
        UPDATE payments.sessions SET applied = ${applied}
         WHERE shop_id = ${shopId} AND id = ${session.id}`);
      await appendEvent<PaymentSessionPayload>(tx, shopId, {
        type: PaymentEvents.PaymentSessionPaid,
        aggregateType: 'payment_session',
        aggregateId: session.id,
        payload: {
          orderId: session.order_id,
          accountId: session.account_id,
          gateway: gateway.info.gateway,
          amount: session.amount,
          paidAmount: amount.toString(),
          applied: applied.toString(),
          test,
        },
      });
    }
    return session;
  }

  #toRecord(row: SessionRow): PaymentSessionRecord {
    return {
      id: row.id,
      orderId: row.order_id,
      accountId: row.account_id,
      gateway: row.gateway,
      gatewayName: this.gateways.of(row.gateway)?.info.name ?? row.gateway,
      environment: row.environment,
      amount: BigInt(row.amount),
      currency: row.currency as CurrencyCode,
      status: row.status,
      gatewayRef: row.gateway_ref,
      paidAmount: row.paid_amount === null ? null : BigInt(row.paid_amount),
      applied: row.applied === null ? null : BigInt(row.applied),
      reference: row.reference,
      paidThrough: row.paid_through,
      paidAt: row.paid_at === null ? null : toDate(row.paid_at),
      error: row.error,
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
    };
  }
}
