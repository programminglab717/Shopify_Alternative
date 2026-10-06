import {
  actorColumnsOf,
  failOne,
  InputChecker,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { formatMoney, money, type CurrencyCode } from '@hatti/money';
import {
  OnlinePayments,
  orderPaymentFactsIn,
  receiveOnlinePaymentIn,
  refundOnlinePaymentIn,
  type OnlineGateway,
  type OrderPaymentFacts,
} from '@hatti/orders/public';
import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { PaymentEvents, type PaymentRefundPayload, type PaymentSessionPayload } from './events.js';
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

/** How many refunds a payment takes, and how long one waits for its answer. */
export const REFUND_LIMITS = {
  /** Refunds of one payment at most, those refused included. */
  perSession: 20,
  /** A refund still pending this long has lost its answer: staff settle it by hand. */
  answerMinutes: 5,
} as const;

/** How many payments an order starts, and how long one is offered again. */
export const SESSION_LIMITS = {
  /** Sessions an order starts at most, those the gateway refused included. */
  perOrder: 50,
  /** A session's checkout is offered again for this long, rather than a new one started. */
  reuseMinutes: 30,
} as const;

/**
 * When a payment started online whose customer never came back is asked after (ADR-208): from a
 * quarter of an hour after it began, at most once an hour, for two days, as a voucher paid at a
 * shop may take a day; a shop's oldest first, so many a sweep.
 */
export const PAYMENT_INQUIRIES = {
  afterMs: 15 * 60_000,
  everyMs: 3_600_000,
  withinMs: 2 * 86_400_000,
  batch: 50,
} as const;

export const SESSION_STATUSES = ['open', 'paid', 'failed'] as const;
export type SessionStatusValue = (typeof SESSION_STATUSES)[number];

/** How Hatti heard that a session is paid: the customer coming back, or the gateway's webhook. */
export type PaidThroughValue = 'return' | 'webhook' | 'inquiry';

export const REFUND_STATUSES = ['pending', 'refunded', 'refused', 'unknown'] as const;
export type RefundStatusValue = (typeof REFUND_STATUSES)[number];

/** Money given back of a payment through its gateway (ADR-153), as the Admin API shows it. */
export interface PaymentRefundRecord {
  id: string;
  sessionId: string;
  orderId: string;
  /** Minor units, in the payment's currency. */
  amount: bigint;
  currency: CurrencyCode;
  status: RefundStatusValue;
  /** The gateway's reference for it, once refunded. */
  reference: string | null;
  /** The order's refund it was written as, once refunded. */
  refundId: string | null;
  /** Why the gateway refused it, or why no answer came. */
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

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
  /** What was given back of it through the gateway, or asked to be, the oldest first. */
  refunds: PaymentRefundRecord[];
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

type RefundRow = {
  id: string;
  session_id: string;
  order_id: string;
  amount: string;
  currency: string;
  status: RefundStatusValue;
  reference: string | null;
  refund_id: string | null;
  error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

const REFUND_COLUMNS = sql.raw(
  `r.id, r.session_id, r.order_id, r.amount::text, s.currency, r.status, r.reference,
   r.refund_id, r.error, r.created_at, r.updated_at`,
);

/** A refund recorded, to ask its gateway for; or what to answer at once. */
type RefundBegun =
  | { done: MutationResult<{ refundId: string | null }> }
  | {
      refund: string;
      session: SessionRow;
      account: OpenedGatewayAccount;
      gateway: PaymentGateway;
      give: NonNullable<PaymentGateway['refund']>;
      order: OrderPaymentFacts;
    };

/** What staff found in the gateway's dashboard of a refund whose answer never came. */
export interface RefundSettleInput {
  /** Whether the gateway gave it back. */
  refunded: boolean;
  /** The gateway's reference for it, as its dashboard shows it. */
  reference?: string | null;
}

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
  ): Promise<{ url: string; form?: Readonly<Record<string, string>> } | { error: string }> {
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
      // A checkout by form keeps no address to offer again: its form carries the account's
      // password, which is kept sealed alone (ADR-163). A new one is started each time.
      const { form } = checkout.value;
      await tx.execute(sql`
        UPDATE payments.sessions
           SET gateway_ref = ${checkout.value.ref},
               checkout_url = ${form ? null : checkout.value.url}, updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${session}`);
      await appendEvent<PaymentSessionPayload>(tx, shopId, {
        type: PaymentEvents.PaymentSessionStarted,
        aggregateType: 'payment_session',
        aggregateId: session,
        payload,
      });
      return form ? { url: checkout.value.url, form } : { url: checkout.value.url };
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

  /**
   * The shops with payments started online to ask their gateways after (ADR-208), found with the
   * system role, which sees every shop.
   */
  async shopsWithInquiriesDue(at: Date = new Date()): Promise<string[]> {
    const gateways = this.gateways.inquirable;
    if (gateways.length === 0) return [];
    const { rows } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT DISTINCT s.shop_id FROM ${SESSION_FROM} WHERE ${inquiryDue(at, gateways)}`),
    );
    return rows.map((row) => row.shop_id);
  }

  /**
   * Asks the gateways after the shop's payments started online whose customers never came back
   * (ADR-208): sessions still open, from {@link PAYMENT_INQUIRIES}' quarter of an hour after they
   * began to two days, each at most once an hour, through gateways that can be asked. Each is
   * asked outside any transaction, as a gateway may take its time; one it says is paid is recorded
   * paid through the inquiry, as its return would have been. How many it asked, and found paid.
   */
  async inquireDue(
    shopId: string,
    at: Date = new Date(),
  ): Promise<{ asked: number; paid: number }> {
    const gateways = this.gateways.inquirable;
    if (gateways.length === 0) return { asked: 0, paid: 0 };
    const { rows: due } = await this.db.tenant(shopId, (tx) =>
      tx.execute<SessionRow>(sql`
        SELECT ${SESSION_COLUMNS}
          FROM ${SESSION_FROM}
         WHERE s.shop_id = ${shopId} AND ${inquiryDue(at, gateways)}
         ORDER BY s.created_at
         LIMIT ${PAYMENT_INQUIRIES.batch}`),
    );
    let asked = 0;
    let paid = 0;
    for (const session of due) {
      const row = await this.db.tenant(shopId, (tx) =>
        gatewayAccountIn(tx, shopId, session.account_id),
      );
      const gateway = row && this.gateways.of(row.gateway);
      if (!row || !gateway?.inquire || !session.gateway_ref) continue;
      const answer = await gateway.inquire(
        this.accounts.openedIn(shopId, row),
        session.gateway_ref,
      );
      asked += 1;
      const found = await this.db.tenant(shopId, async (tx) => {
        await tx.execute(sql`
          UPDATE payments.sessions SET inquired_at = ${at}
           WHERE shop_id = ${shopId} AND id = ${session.id}`);
        if (answer.status !== 'paid' || answer.payment.ref !== session.gateway_ref) return false;
        await this.#complete(tx, shopId, session, gateway, answer.payment, 'inquiry');
        return true;
      });
      if (found) paid += 1;
    }
    return { asked, paid };
  }

  /** An order's sessions, the latest first, each with its refunds. */
  async sessionsOf(shopId: string, orderId: string): Promise<PaymentSessionRecord[]> {
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<SessionRow>(sql`
        SELECT ${SESSION_COLUMNS}
          FROM ${SESSION_FROM}
         WHERE s.shop_id = ${shopId} AND s.order_id = ${orderId}
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT ${SESSION_LIMITS.perOrder}`);
      const { rows: refunds } = await tx.execute<RefundRow>(sql`
        SELECT ${REFUND_COLUMNS}
          FROM payments.refunds r
          JOIN payments.sessions s ON s.shop_id = r.shop_id AND s.id = r.session_id
         WHERE r.shop_id = ${shopId} AND r.order_id = ${orderId}
         ORDER BY r.created_at, r.id`);
      return rows.map((row) =>
        this.#toRecord(
          row,
          refunds.filter((refund) => refund.session_id === row.id).map(toRefundRecord),
        ),
      );
    });
  }

  /**
   * Gives back `amount` of what the order's customer paid online, through the gateway that took
   * it (PAY-06, ADR-153), on the latest of the order's payments that can take it: recorded first,
   * pending, with the order locked, so that nothing is given back twice; then the gateway is
   * asked, outside the transaction; then the refund is written on the order once the gateway
   * says it is sent. A refusal is recorded and said; no answer leaves it unknown, holding its
   * amount, for staff to settle from the gateway's dashboard.
   */
  async refund(
    tenant: TenantContext,
    orderId: string,
    request: { amount: bigint; note: string },
  ): Promise<MutationResult<{ refundId: string | null }>> {
    const { shopId } = tenant;
    const actor = actorColumnsOf(tenant.actor);
    const begun = await this.db.tenant(shopId, async (tx): Promise<RefundBegun> => {
      const order = await orderPaymentFactsIn(tx, shopId, orderId);
      if (!order) return { done: failOne(['id'], 'NOT_FOUND', 'Order not found') };
      const format = (value: bigint) => formatMoney(money(value, order.currency));
      if (order.refundable === 0n) {
        return { done: failOne(['id'], 'INVALID', 'Nothing paid on this order is left to refund') };
      }
      if (request.amount > order.refundable) {
        return {
          done: failOne(
            ['input', 'amount'],
            'INVALID',
            `A refund can be at most ${format(order.refundable)}: what was paid and not refunded yet`,
          ),
        };
      }
      // Its payments online that paid something on it, the latest first, with what of each is
      // given back or asked to be: refunds refused alone hold nothing.
      const { rows } = await tx.execute<SessionRow & { held: string; tries: number }>(sql`
        SELECT ${SESSION_COLUMNS},
               coalesce((SELECT sum(r.amount) FROM payments.refunds r
                          WHERE r.shop_id = s.shop_id AND r.session_id = s.id
                            AND r.status <> 'refused'), 0)::text AS held,
               (SELECT count(*) FROM payments.refunds r
                 WHERE r.shop_id = s.shop_id AND r.session_id = s.id)::int AS tries
          FROM ${SESSION_FROM}
         WHERE s.shop_id = ${shopId} AND s.order_id = ${orderId} AND s.status = 'paid'
           AND s.environment = 'production' AND s.applied > 0
         ORDER BY s.paid_at DESC, s.id DESC`);
      if (rows.length === 0) {
        return {
          done: failOne(
            ['input', 'method'],
            'INVALID',
            'Nothing was paid online on this order: refund it another way, then record it',
          ),
        };
      }
      // Why none of them could take it, the most useful said.
      let most = 0n;
      let whole: string | null = null;
      let none: string | null = null;
      for (const row of rows) {
        const gateway = this.gateways.of(row.gateway);
        const name = gateway?.info.name ?? row.gateway;
        const applied = BigInt(row.applied!);
        const held = BigInt(row.held);
        const give = gateway?.refund?.bind(gateway);
        if (!gateway || !give || gateway.info.refunds === 'none') {
          none ??= `${name} gives nothing back through Hatti: refund it in its dashboard, then record it`;
          continue;
        }
        if (row.tries >= REFUND_LIMITS.perSession) continue;
        if (gateway.info.refunds === 'whole') {
          // Given back as it was paid, all of it paid on the order, and nothing of it yet.
          const takes = held === 0n && BigInt(row.paid_amount!) === applied;
          if (!takes || request.amount !== applied) {
            if (takes) {
              whole ??=
                `${name} gives a payment back whole through Hatti: ${format(applied)}. Refund ` +
                'part of it in its dashboard, then record it';
            }
            continue;
          }
        } else if (request.amount > applied - held) {
          if (applied - held > most) most = applied - held;
          continue;
        }
        const { rows: inserted } = await tx.execute<{ id: string }>(sql`
          INSERT INTO payments.refunds (shop_id, session_id, order_id, amount, actor_kind,
                                        actor_id)
          VALUES (${shopId}, ${row.id}, ${orderId}, ${request.amount}, ${actor.actorKind},
                  ${actor.actorId})
          RETURNING id`);
        const account = await gatewayAccountIn(tx, shopId, row.account_id);
        return {
          refund: inserted[0]!.id,
          session: row,
          account: this.accounts.openedIn(shopId, account!),
          gateway,
          give,
          order,
        };
      }
      return {
        done: failOne(
          ['input', most > 0n || whole ? 'amount' : 'method'],
          'INVALID',
          most > 0n
            ? `A refund online goes back on one payment: at most ${format(most)}`
            : (whole ??
                none ??
                'What was paid online on this order is given back, or asked to be: see its ' +
                  "payments' refunds"),
        ),
      };
    });
    if ('done' in begun) return begun.done;

    const { refund, session, account, gateway, give, order } = begun;
    const answer = await give(account, {
      ref: session.gateway_ref!,
      amount: request.amount,
      currency: order.currency,
    });
    const { name } = gateway.info;
    return this.db.tenant(shopId, async (tx) => {
      const payload: PaymentRefundPayload = {
        orderId,
        sessionId: session.id,
        gateway: gateway.info.gateway,
        amount: request.amount.toString(),
      };
      if (!answer.ok) {
        const error = answer.message.slice(0, 1_000);
        await tx.execute(sql`
          UPDATE payments.refunds
             SET status = ${answer.unknown ? 'unknown' : 'refused'}, error = ${error},
                 updated_at = now()
           WHERE shop_id = ${shopId} AND id = ${refund} AND status = 'pending'`);
        await appendEvent<PaymentRefundPayload>(tx, shopId, {
          type: PaymentEvents.PaymentRefundFailed,
          aggregateType: 'payment_refund',
          aggregateId: refund,
          payload: { ...payload, error, unknown: answer.unknown },
        });
        return failOne(
          ['input', 'method'],
          'INVALID',
          answer.unknown
            ? `${name} did not answer, so it may have given it back: check its dashboard, then ` +
                `settle the refund with what it shows (${error})`
            : `${name} would not give it back: ${error}`,
        );
      }
      // The tracker names the payment in the gateway's dashboard when it gives no reference.
      const reference = answer.reference ?? session.gateway_ref;
      const refundId = await this.#refunded(tx, tenant, refund, {
        orderId,
        amount: request.amount,
        gateway: name,
        reference,
        note: request.note,
      });
      await appendEvent<PaymentRefundPayload>(tx, shopId, {
        type: PaymentEvents.PaymentRefundRefunded,
        aggregateType: 'payment_refund',
        aggregateId: refund,
        payload: { ...payload, reference, refundId },
      });
      return { ok: true, value: { refundId } };
    });
  }

  /**
   * Settles by hand a refund whose answer never came, as staff found it in the gateway's
   * dashboard (ADR-153): given back, and written on its order then; or not, which frees what it
   * held. Only a refund left unknown, or pending past its answer's time.
   */
  async settleRefund(
    tenant: TenantContext,
    refundId: string,
    input: RefundSettleInput,
  ): Promise<MutationResult<PaymentRefundRecord>> {
    const check = new InputChecker();
    const given = check.text(['input', 'reference'], input.reference, { max: 200 });
    if (!input.refunded && given !== null) {
      check.addMessage(
        ['input', 'reference'],
        'INVALID',
        'Only a refund given back has a reference',
      );
    }
    if (!check.ok) return { ok: false, errors: check.errors };
    const { shopId } = tenant;
    return this.db.tenant(shopId, async (tx): Promise<MutationResult<PaymentRefundRecord>> => {
      const { rows } = await tx.execute<
        RefundRow & { gateway: string; gateway_ref: string | null; waiting: boolean }
      >(sql`
        SELECT ${REFUND_COLUMNS}, a.gateway, s.gateway_ref,
               r.status = 'unknown'
                 OR (r.status = 'pending'
                     AND r.created_at < now() - ${`${REFUND_LIMITS.answerMinutes} minutes`}::interval)
                 AS waiting
          FROM payments.refunds r
          JOIN ${SESSION_FROM} ON s.shop_id = r.shop_id AND s.id = r.session_id
         WHERE r.shop_id = ${shopId} AND r.id = ${refundId}
           FOR UPDATE OF r`);
      const row = rows[0];
      if (!row) return failOne(['id'], 'NOT_FOUND', 'Payment refund not found');
      if (!row.waiting) {
        return failOne(
          ['id'],
          'INVALID',
          'Only a refund whose answer never came is settled by hand: this one is ' + row.status,
        );
      }
      const name = this.gateways.of(row.gateway)?.info.name ?? row.gateway;
      const actor = actorColumnsOf(tenant.actor);
      if (input.refunded) {
        const reference = given ?? row.gateway_ref;
        const written = await this.#refunded(
          tx,
          tenant,
          row.id,
          {
            orderId: row.order_id,
            amount: BigInt(row.amount),
            gateway: name,
            reference,
            note: "Given back, as the gateway's dashboard showed",
          },
          ['pending', 'unknown'],
        );
        await appendEvent<PaymentRefundPayload>(tx, shopId, {
          type: PaymentEvents.PaymentRefundRefunded,
          aggregateType: 'payment_refund',
          aggregateId: row.id,
          payload: {
            orderId: row.order_id,
            sessionId: row.session_id,
            gateway: row.gateway,
            amount: row.amount,
            reference,
            refundId: written,
          },
        });
      } else {
        await tx.execute(sql`
          UPDATE payments.refunds
             SET status = 'refused', error = ${"Not given back, as the gateway's dashboard showed"},
                 updated_at = now()
           WHERE shop_id = ${shopId} AND id = ${row.id}`);
      }
      await recordAudit(tx, shopId, {
        action: 'payment_refund.settled',
        subjectType: 'order',
        subjectId: row.order_id,
        ...actor,
        details: {
          paymentRefundId: toPublicId('paymentRefund', row.id),
          refunded: input.refunded,
        },
      });
      const { rows: settled } = await tx.execute<RefundRow>(sql`
        SELECT ${REFUND_COLUMNS}
          FROM payments.refunds r
          JOIN payments.sessions s ON s.shop_id = r.shop_id AND s.id = r.session_id
         WHERE r.shop_id = ${shopId} AND r.id = ${row.id}`);
      return { ok: true, value: toRefundRecord(settled[0]!) };
    });
  }

  /**
   * Marks the refund `refund` given back, if it still waits (`from`), and writes it on its order:
   * the order's refund's ID, or null when the order had nothing left to refund.
   */
  async #refunded(
    tx: Tx,
    tenant: TenantContext,
    refund: string,
    given: {
      orderId: string;
      amount: bigint;
      gateway: string;
      reference: string | null;
      note: string;
    },
    from: readonly RefundStatusValue[] = ['pending'],
  ): Promise<string | null> {
    const { shopId } = tenant;
    const { rows: claimed } = await tx.execute<{ id: string }>(sql`
      UPDATE payments.refunds
         SET status = 'refunded', reference = ${given.reference?.slice(0, 200) ?? null},
             error = NULL, updated_at = now()
       WHERE shop_id = ${shopId} AND id = ${refund}
         AND status = ANY(${sql.param([...from])}::text[])
      RETURNING id`);
    if (claimed.length === 0) return null;
    const written = await refundOnlinePaymentIn(tx, tenant, given);
    const refundId = written?.refundId ?? null;
    if (refundId) {
      await tx.execute(sql`
        UPDATE payments.refunds SET refund_id = ${refundId}
         WHERE shop_id = ${shopId} AND id = ${refund}`);
    }
    return refundId;
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

  #toRecord(row: SessionRow, refunds: PaymentRefundRecord[]): PaymentSessionRecord {
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
      refunds,
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
    };
  }
}

function toRefundRecord(row: RefundRow): PaymentRefundRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    orderId: row.order_id,
    amount: BigInt(row.amount),
    currency: row.currency as CurrencyCode,
    status: row.status,
    reference: row.reference,
    refundId: row.refund_id,
    error: row.error,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

/**
 * The sessions to ask their gateways after at `at` (ADR-208), of {@link SESSION_FROM}: open, with
 * the gateway's name for them, through one of `gateways`, begun from a quarter of an hour to two
 * days before, and not asked within the hour.
 */
function inquiryDue(at: Date, gateways: readonly string[]): SQL {
  const before = (ms: number) => new Date(at.getTime() - ms);
  return sql`s.status = 'open' AND s.gateway_ref IS NOT NULL
    AND s.created_at <= ${before(PAYMENT_INQUIRIES.afterMs)}
    AND s.created_at > ${before(PAYMENT_INQUIRIES.withinMs)}
    AND (s.inquired_at IS NULL OR s.inquired_at <= ${before(PAYMENT_INQUIRIES.everyMs)})
    AND a.gateway = ANY(${sql.param([...gateways])}::text[])`;
}

/**
 * Of `orderIds`, the shop's orders with a payment started online since `since` and not paid yet:
 * its gateway may still take it, so an order never paid waits for it before it is cancelled
 * (ADR-168). In the caller's tenant transaction.
 */
export async function paymentsUnderwayIn(
  tx: Tx,
  shopId: string,
  orderIds: readonly string[],
  since: Date,
): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const { rows } = await tx.execute<{ order_id: string }>(sql`
    SELECT DISTINCT order_id FROM payments.sessions
     WHERE shop_id = ${shopId} AND status = 'open' AND created_at > ${since}
       AND order_id = ANY(${sql.param([...orderIds])}::uuid[])`);
  return new Set(rows.map((row) => row.order_id));
}
