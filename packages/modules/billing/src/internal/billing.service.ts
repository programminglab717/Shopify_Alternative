import {
  PlanAllowance,
  PublicSite,
  actorColumnsOf,
  failOne,
  shopProfile,
  type MutationResult,
  type PlanLimit,
  type PlanLimitKind,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { toPublicId, tryFromPublicId } from '@hatti/ids';
import { formatMoney, money } from '@hatti/money';
import type {
  GatewayAccount,
  GatewayPayment,
  GatewayWebhook,
  PaymentGateway,
} from '@hatti/payments/public';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BillingEvents, type InvoicePayload, type SubscriptionChangedPayload } from './events.js';
import {
  BILLING_CURRENCY,
  BILLING_INTERVALS,
  BILLING_LIMITS,
  PLANS,
  PLAN_CODES,
  beginsAtOnce,
  invoiceName,
  periodEndOf,
  type BillingIntervalValue,
  type Plan,
  type PlanCode,
} from './plans.js';

/** Hatti's own account with a payment gateway, which shops pay their plans through (ADR-154). */
export interface HattiGateway {
  gateway: PaymentGateway;
  account: GatewayAccount;
}

/** The host's {@link HattiGateway}, or null where none is set up. */
export const BILLING_GATEWAY = Symbol('BILLING_GATEWAY');

/** Where invoices' pages are, on the API's own address, and where Hatti's gateway's webhook is. */
export const BILLING_PATH = 'billing/invoices';
export const BILLING_WEBHOOK_PATH = 'webhooks/billing';

const DAY_MS = 24 * 3_600_000;

export const INVOICE_STATUSES = ['open', 'paid', 'void'] as const;
export type InvoiceStatusValue = (typeof INVOICE_STATUSES)[number];
export type InvoiceReasonValue = 'change' | 'renewal';

/** An invoice of Hatti's to the shop, as the Admin API shows it. */
export interface InvoiceRecord {
  id: string;
  number: number;
  /** "HB-000123". */
  name: string;
  /** A plan chosen now, or the plan's next period. */
  reason: InvoiceReasonValue;
  plan: Plan;
  interval: BillingIntervalValue;
  /** Paisa: the plan's price for the period, less what was left of the period it cut short. */
  price: bigint;
  credit: bigint;
  amount: bigint;
  status: InvoiceStatusValue;
  /** The gateway's reference for its payment, once paid. */
  reference: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

/** The plan the shop pays Hatti for, as the Admin API shows it. */
export interface SubscriptionRecord {
  plan: Plan;
  /** How a paid plan is paid for; null on Free. */
  interval: BillingIntervalValue | null;
  /** The period paid for; null on Free. */
  periodStart: Date | null;
  periodEnd: Date | null;
  /** The period ended unpaid: the plan stays for a week, then the shop is on Free. */
  pastDue: boolean;
  /** A smaller plan, or Free, chosen to begin when the period ends. */
  nextPlan: Plan | null;
  nextInterval: BillingIntervalValue | null;
  /** The invoice waiting to be paid, if one is. */
  openInvoice: InvoiceRecord | null;
}

/** What an invoice's page shows, on the API's own address. */
export interface InvoicePageView {
  shopName: string;
  invoice: InvoiceRecord;
  /** When the plan it paid for runs until, once paid. */
  periodEnd: Date | null;
}

type SubscriptionRow = {
  plan: PlanCode;
  billing_interval: BillingIntervalValue | null;
  period_start: string | Date | null;
  period_end: string | Date | null;
  next_plan: PlanCode | null;
  next_interval: BillingIntervalValue | null;
};

type InvoiceRow = {
  id: string;
  number: string;
  reason: InvoiceReasonValue;
  plan: Exclude<PlanCode, 'free'>;
  billing_interval: BillingIntervalValue;
  price: string;
  credit: string;
  amount: string;
  status: InvoiceStatusValue;
  reference: string | null;
  paid_at: string | Date | null;
  created_at: string | Date;
};

type PaymentRow = { id: string; invoice_id: string; amount: string };

const INVOICE_COLUMNS = sql.raw(
  `id, number::text, reason, plan, billing_interval, price::text, credit::text, amount::text,
   status, reference, paid_at, created_at`,
);

/** A payment recorded, to start with Hatti's gateway; or what to answer at once. */
type Begun =
  { done: MutationResult<{ url: string }> } | { payment: string; invoice: InvoiceRecord };

/**
 * What shops pay Hatti (BIL-01, ADR-154): a plan, Free or one paid for by the month or the year,
 * through Hatti's own payment gateway account. A plan chosen bigger begins once its invoice is
 * paid, less what was left of the period it cuts short; a smaller one, or Free, when the period
 * ends. Each period's renewal is invoiced a week ahead; unpaid a week past its end, the shop is on
 * Free. It keeps the limits each plan sets, which other modules ask through {@link PlanAllowance}.
 */
@Injectable()
export class BillingService extends PlanAllowance {
  constructor(
    private readonly db: Database,
    private readonly site: PublicSite,
    @Optional() @Inject(BILLING_GATEWAY) private readonly hatti?: HattiGateway | null,
  ) {
    super();
  }

  /** The plans shops choose from, the smallest first. */
  plans(): Plan[] {
    return PLAN_CODES.map((code) => PLANS[code]);
  }

  async limitOf(shopId: string, kind: PlanLimitKind): Promise<PlanLimit> {
    const plan = await this.db.tenant(shopId, async (tx) => {
      const row = await subscriptionIn(tx, shopId, false);
      return PLANS[row?.plan ?? 'free'];
    });
    return { limit: kind === 'staff' ? plan.staff : plan.locations, plan: plan.name };
  }

  async subscriptionOf(shopId: string): Promise<SubscriptionRecord> {
    return this.db.tenant(shopId, (tx) => this.#subscriptionRecordIn(tx, shopId));
  }

  /** The shop's invoices, the newest first. */
  async invoicesOf(shopId: string, first: number = 20): Promise<InvoiceRecord[]> {
    const limit = Math.max(1, Math.min(first, BILLING_LIMITS.invoices));
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<InvoiceRow>(sql`
        SELECT ${INVOICE_COLUMNS} FROM billing.invoices
         WHERE shop_id = ${shopId}
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit}`);
      return rows.map(toInvoiceRecord);
    });
  }

  /**
   * Chooses the shop's plan (ADR-154). A bigger plan, or Free's next one, is invoiced now, less
   * what is left of the current period, and begins once paid; a smaller plan, or Free, begins when
   * the period ends. Choosing the current plan again keeps it, dropping a change chosen for later.
   * Another invoice waiting to be paid gives way to the new choice.
   */
  async changePlan(
    tenant: TenantContext,
    input: { plan: string; interval?: string | null },
  ): Promise<MutationResult<{ subscription: SubscriptionRecord; invoice: InvoiceRecord | null }>> {
    type Result = MutationResult<{
      subscription: SubscriptionRecord;
      invoice: InvoiceRecord | null;
    }>;
    const target = input.plan as PlanCode;
    if (!PLAN_CODES.includes(target)) {
      return failOne(['input', 'plan'], 'INVALID', `Plan must be one of ${PLAN_CODES.join(', ')}`);
    }
    const asked = input.interval ?? null;
    if (asked !== null && !BILLING_INTERVALS.includes(asked as BillingIntervalValue)) {
      return failOne(['input', 'interval'], 'INVALID', 'Interval must be monthly or yearly');
    }
    if (target === 'free' && asked !== null) {
      return failOne(
        ['input', 'interval'],
        'INVALID',
        'Free is paid for neither monthly nor yearly',
      );
    }
    if (target !== 'free' && asked === null) {
      return failOne(['input', 'interval'], 'BLANK', 'A paid plan is paid for monthly or yearly');
    }
    const interval = asked as BillingIntervalValue | null;
    const { shopId } = tenant;
    const actor = actorColumnsOf(tenant.actor);
    return this.db.tenant(shopId, async (tx): Promise<Result> => {
      const now = new Date();
      const row = await subscriptionIn(tx, shopId, true);
      const current = { plan: row?.plan ?? 'free', interval: row?.billing_interval ?? null };
      const pastDue = row !== null && row.plan !== 'free' && toDate(row.period_end!) <= now;
      const audit = (when: 'now' | 'period_end' | 'kept') =>
        recordAudit(tx, shopId, {
          action: 'billing.plan_chosen',
          subjectType: 'shop',
          subjectId: shopId,
          ...actor,
          details: { plan: target, interval, begins: when },
        });
      const done = async (invoice: InvoiceRecord | null): Promise<Result> => ({
        ok: true,
        value: { subscription: await this.#subscriptionRecordIn(tx, shopId), invoice },
      });

      if (current.plan === target && current.interval === interval) {
        if (!row?.next_plan) {
          return failOne(
            ['input', 'plan'],
            'INVALID',
            `The shop is on ${PLANS[target].name} already`,
          );
        }
        // The plan kept: the change chosen for later is dropped, and so is its renewal's invoice.
        await voidOpenInvoices(tx, shopId);
        await this.#schedule(tx, shopId, null, null);
        await audit('kept');
        return done(null);
      }
      if (target === 'free' && !pastDue) {
        await voidOpenInvoices(tx, shopId);
        await this.#schedule(tx, shopId, 'free', null);
        await audit('period_end');
        return done(null);
      }
      if (target === 'free') {
        await voidOpenInvoices(tx, shopId);
        await this.#toFree(tx, shopId, 'ended');
        await audit('now');
        return done(null);
      }
      const chosen = { plan: target, interval: interval! };
      if (!pastDue && !beginsAtOnce(current, chosen)) {
        await voidOpenInvoices(tx, shopId);
        await this.#schedule(tx, shopId, target, interval);
        await audit('period_end');
        return done(null);
      }
      // At once, once paid: the plan's price, less what is left of the period it cuts short, in
      // whole rupees.
      const price = PLANS[target].prices[chosen.interval];
      let credit = 0n;
      if (row && row.plan !== 'free' && !pastDue) {
        const start = toDate(row.period_start!).getTime();
        const end = toDate(row.period_end!).getTime();
        const paid = PLANS[row.plan].prices[row.billing_interval!];
        const left = BigInt(Math.max(0, end - now.getTime()));
        credit = ((paid * left) / BigInt(end - start) / 100n) * 100n;
        if (credit >= price) credit = price - 100n;
      }
      await voidOpenInvoices(tx, shopId);
      const invoice = await insertInvoice(tx, shopId, {
        reason: 'change',
        plan: target,
        interval: chosen.interval,
        price,
        credit,
      });
      await audit('now');
      return done(invoice);
    });
  }

  /**
   * Starts paying an invoice through Hatti's gateway: its page to send the shop's owner to, which
   * sends them back to the invoice's page on the API's address. The payment is recorded first, as
   * orders' are (ADR-151); asked again within half an hour, the same page.
   */
  async pay(tenant: TenantContext, invoiceId: string): Promise<MutationResult<{ url: string }>> {
    const hatti = this.hatti;
    if (!hatti) return failOne(['id'], 'INVALID', "Paying Hatti online isn't set up here");
    const { shopId } = tenant;
    const begun = await this.db.tenant(shopId, async (tx): Promise<Begun> => {
      const { rows } = await tx.execute<InvoiceRow>(sql`
        SELECT ${INVOICE_COLUMNS} FROM billing.invoices
         WHERE shop_id = ${shopId} AND id = ${invoiceId}
           FOR UPDATE`);
      if (!rows[0]) return { done: failOne(['id'], 'NOT_FOUND', 'Invoice not found') };
      const invoice = toInvoiceRecord(rows[0]);
      if (invoice.status !== 'open') {
        return { done: failOne(['id'], 'INVALID', `Invoice ${invoice.name} is ${invoice.status}`) };
      }
      const { rows: recent } = await tx.execute<{ checkout_url: string }>(sql`
        SELECT checkout_url FROM billing.payments
         WHERE shop_id = ${shopId} AND invoice_id = ${invoiceId} AND status = 'open'
           AND gateway = ${hatti.gateway.info.gateway} AND amount = ${invoice.amount}
           AND checkout_url IS NOT NULL
           AND created_at > now() - ${`${BILLING_LIMITS.reuseMinutes} minutes`}::interval
         ORDER BY created_at DESC
         LIMIT 1`);
      if (recent[0]) return { done: { ok: true, value: { url: recent[0].checkout_url } } };
      const { rows: counts } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM billing.payments
         WHERE shop_id = ${shopId} AND invoice_id = ${invoiceId}`);
      if (counts[0]!.count >= BILLING_LIMITS.paymentsPerInvoice) {
        return {
          done: failOne(
            ['id'],
            'INVALID',
            "The invoice started as many payments as it may: ask Hatti's support",
          ),
        };
      }
      const { rows: inserted } = await tx.execute<{ id: string }>(sql`
        INSERT INTO billing.payments (shop_id, invoice_id, gateway, environment, amount)
        VALUES (${shopId}, ${invoiceId}, ${hatti.gateway.info.gateway},
                ${hatti.account.environment}, ${invoice.amount})
        RETURNING id`);
      return { payment: inserted[0]!.id, invoice };
    });
    if ('done' in begun) return begun.done;

    const { payment, invoice } = begun;
    const page = this.site.url(`/${BILLING_PATH}/${toPublicId('billingInvoice', invoice.id)}`);
    const checkout = await hatti.gateway.checkout(hatti.account, {
      amount: invoice.amount,
      currency: BILLING_CURRENCY,
      orderName: invoice.name,
      returnUrl: `${page}/paid`,
      cancelUrl: page,
    });
    return this.db.tenant(shopId, async (tx): Promise<MutationResult<{ url: string }>> => {
      if (!checkout.ok) {
        await tx.execute(sql`
          UPDATE billing.payments
             SET status = 'failed', error = ${checkout.message.slice(0, 1_000)}, updated_at = now()
           WHERE shop_id = ${shopId} AND id = ${payment}`);
        return failOne(
          ['id'],
          'INVALID',
          `Paying online isn't working right now: ${checkout.message.slice(0, 500)}`,
        );
      }
      await tx.execute(sql`
        UPDATE billing.payments
           SET gateway_ref = ${checkout.value.ref}, checkout_url = ${checkout.value.url},
               updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${payment}`);
      return { ok: true, value: { url: checkout.value.url } };
    });
  }

  /**
   * The shop's owner came back from Hatti's gateway to the invoice's page with `form`, as the
   * gateway sent them: the payment it vouches for, signed with Hatti's secret, pays the invoice,
   * once. The page's view either way; null for an invoice not found.
   */
  async returned(
    invoiceId: string,
    form: Readonly<Record<string, string>>,
  ): Promise<InvoicePageView | null> {
    const id = tryFromPublicId(invoiceId, 'billingInvoice');
    if (!id) return null;
    const { rows: found } = await this.db.app.execute<{ shop_id: string }>(
      sql`SELECT shop_id FROM billing.resolve_invoice(${id})`,
    );
    const shopId = found[0]?.shop_id;
    if (!shopId) return null;
    const hatti = this.hatti;
    return this.db.tenant(shopId, async (tx) => {
      const said = hatti ? hatti.gateway.returned(hatti.account, form) : null;
      if (hatti && said) {
        const { rows } = await tx.execute<PaymentRow>(sql`
          SELECT id, invoice_id, amount::text FROM billing.payments
           WHERE shop_id = ${shopId} AND invoice_id = ${id}
             AND gateway = ${hatti.gateway.info.gateway} AND gateway_ref = ${said.ref}`);
        if (rows[0]) await this.#complete(tx, shopId, rows[0], said);
      }
      return this.#pageViewIn(tx, shopId, id);
    });
  }

  /** An invoice's page as it is: paid, waiting, or no longer due; null for one not found. */
  async pageOf(invoiceId: string): Promise<InvoicePageView | null> {
    return this.returned(invoiceId, {});
  }

  /**
   * A request to Hatti's gateway's webhook, checked with Hatti's own secret: the payment it says
   * is made pays its invoice, once. Payments not started here are left alone.
   */
  async webhook(request: GatewayWebhook): Promise<'not_found' | 'unsigned' | 'ignored' | 'paid'> {
    const hatti = this.hatti;
    if (!hatti) return 'not_found';
    const said = hatti.gateway.webhook(hatti.account, request);
    if (said === 'unsigned') return 'unsigned';
    if (!said) return 'ignored';
    const { rows: found } = await this.db.app.execute<{ shop_id: string }>(
      sql`SELECT shop_id FROM billing.resolve_payment(${hatti.gateway.info.gateway}, ${said.ref})`,
    );
    const shopId = found[0]?.shop_id;
    if (!shopId) return 'ignored';
    return this.db.tenant(shopId, async (tx) => {
      const { rows } = await tx.execute<PaymentRow>(sql`
        SELECT id, invoice_id, amount::text FROM billing.payments
         WHERE shop_id = ${shopId} AND gateway = ${hatti.gateway.info.gateway}
           AND gateway_ref = ${said.ref}`);
      if (!rows[0]) return 'ignored';
      await this.#complete(tx, shopId, rows[0], said);
      return 'paid';
    });
  }

  /**
   * One round of renewals, for the worker: each paid plan whose period ends within a week has its
   * next period invoiced, once; a smaller plan chosen for later, once the period has ended. A
   * period that ended with Free chosen next, or a week unpaid, leaves the shop on Free. What it
   * did; a shop that failed is tried again next round.
   */
  async sweep(at: Date = new Date()): Promise<{ invoiced: number; ended: number; failed: number }> {
    const horizon = new Date(at.getTime() + BILLING_LIMITS.renewalDays * DAY_MS);
    const { rows: due } = await this.db.system((tx) =>
      tx.execute<{ shop_id: string }>(sql`
        SELECT shop_id FROM billing.subscriptions
         WHERE plan <> 'free' AND period_end <= ${horizon.toISOString()}
         ORDER BY period_end
         LIMIT 200`),
    );
    let invoiced = 0;
    let ended = 0;
    let failed = 0;
    for (const { shop_id: shopId } of due) {
      const outcome = await this.db
        .tenant(shopId, async (tx) => {
          const row = await subscriptionIn(tx, shopId, true);
          if (!row || row.plan === 'free') return null;
          const end = toDate(row.period_end!).getTime();
          if (end <= at.getTime() && row.next_plan === 'free') {
            await voidOpenInvoices(tx, shopId);
            await this.#toFree(tx, shopId, 'ended');
            return 'ended';
          }
          if (end + BILLING_LIMITS.graceDays * DAY_MS <= at.getTime()) {
            // Its renewal's invoice stays open: paying it later begins the plan again.
            await this.#toFree(tx, shopId, 'lapsed');
            return 'ended';
          }
          // A smaller plan chosen for later is invoiced once the period ends, so that paying it
          // early never cuts short the plan paid for.
          if (row.next_plan !== null && end > at.getTime()) return null;
          const { rows: open } = await tx.execute<{ id: string }>(sql`
          SELECT id FROM billing.invoices WHERE shop_id = ${shopId} AND status = 'open'`);
          if (open.length > 0 || row.next_plan === 'free') return null;
          const plan = (row.next_plan ?? row.plan) as Exclude<PlanCode, 'free'>;
          const interval = row.next_interval ?? row.billing_interval!;
          await insertInvoice(tx, shopId, {
            reason: 'renewal',
            plan,
            interval,
            price: PLANS[plan].prices[interval],
            credit: 0n,
          });
          return 'invoiced';
        })
        .catch(() => 'failed' as const);
      if (outcome === 'invoiced') invoiced++;
      if (outcome === 'ended') ended++;
      if (outcome === 'failed') failed++;
    }
    return { invoiced, ended, failed };
  }

  /**
   * Records the payment paid, if it was not already, with what the gateway signed or else what it
   * asked for; and, if that covers its invoice, the invoice paid and its plan begun: a renewal of
   * the plan still running carries on from its period's end, anything else from now.
   */
  async #complete(
    tx: Tx,
    shopId: string,
    payment: PaymentRow,
    said: GatewayPayment,
  ): Promise<void> {
    const amount =
      said.amount !== null && (said.currency ?? BILLING_CURRENCY) === BILLING_CURRENCY
        ? said.amount
        : BigInt(payment.amount);
    const { rows: claimed } = await tx.execute<{ id: string }>(sql`
      UPDATE billing.payments
         SET status = 'paid', paid_amount = ${amount}, paid_at = now(), error = NULL,
             updated_at = now()
       WHERE shop_id = ${shopId} AND id = ${payment.id} AND status = 'open'
      RETURNING id`);
    if (claimed.length === 0) return;
    const { rows } = await tx.execute<InvoiceRow>(sql`
      SELECT ${INVOICE_COLUMNS} FROM billing.invoices
       WHERE shop_id = ${shopId} AND id = ${payment.invoice_id}
         FOR UPDATE`);
    const invoice = toInvoiceRecord(rows[0]!);
    // Paid by another payment already, or short of it: the payment stays recorded, for Hatti.
    if (invoice.status === 'paid' || amount < invoice.amount) return;
    // A payment that comes for an invoice set aside meanwhile still pays it: the shop paid.
    await tx.execute(sql`
      UPDATE billing.invoices
         SET status = 'paid', paid_at = now(), reference = ${said.reference}, updated_at = now()
       WHERE shop_id = ${shopId} AND id = ${invoice.id}`);
    await voidOpenInvoices(tx, shopId);
    const now = new Date();
    const row = await subscriptionIn(tx, shopId, true);
    const carries =
      invoice.reason === 'renewal' &&
      row !== null &&
      row.plan !== 'free' &&
      toDate(row.period_end!).getTime() + BILLING_LIMITS.graceDays * DAY_MS > now.getTime();
    const start = carries ? toDate(row!.period_end!) : now;
    const end = periodEndOf(start, invoice.interval);
    await tx.execute(sql`
      INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
      VALUES (${shopId}, ${invoice.plan.code}, ${invoice.interval}, ${start.toISOString()},
              ${end.toISOString()})
      ON CONFLICT (shop_id) DO UPDATE
         SET plan = EXCLUDED.plan, billing_interval = EXCLUDED.billing_interval,
             period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
             next_plan = NULL, next_interval = NULL,
             version = billing.subscriptions.version + 1, updated_at = now()`);
    await appendEvent<InvoicePayload>(tx, shopId, {
      type: BillingEvents.InvoicePaid,
      aggregateType: 'billing_invoice',
      aggregateId: invoice.id,
      payload: invoicePayloadOf(invoice),
    });
    await appendEvent<SubscriptionChangedPayload>(tx, shopId, {
      type: BillingEvents.SubscriptionChanged,
      aggregateType: 'shop',
      aggregateId: shopId,
      payload: {
        plan: invoice.plan.code,
        interval: invoice.interval,
        periodEnd: end.toISOString(),
        nextPlan: null,
        reason: 'paid',
      },
    });
  }

  /** Chooses `plan` to begin when the period ends; null for none. */
  async #schedule(
    tx: Tx,
    shopId: string,
    plan: PlanCode | null,
    interval: BillingIntervalValue | null,
  ): Promise<void> {
    const { rows } = await tx.execute<SubscriptionRow>(sql`
      UPDATE billing.subscriptions
         SET next_plan = ${plan}, next_interval = ${interval},
             version = version + 1, updated_at = now()
       WHERE shop_id = ${shopId}
      RETURNING plan, billing_interval, period_end`);
    const row = rows[0]!;
    await appendEvent<SubscriptionChangedPayload>(tx, shopId, {
      type: BillingEvents.SubscriptionChanged,
      aggregateType: 'shop',
      aggregateId: shopId,
      payload: {
        plan: row.plan,
        interval: row.billing_interval,
        periodEnd: row.period_end === null ? null : toDate(row.period_end).toISOString(),
        nextPlan: plan,
        reason: 'scheduled',
      },
    });
  }

  /** Puts the shop on Free now. */
  async #toFree(tx: Tx, shopId: string, reason: 'ended' | 'lapsed'): Promise<void> {
    await tx.execute(sql`
      UPDATE billing.subscriptions
         SET plan = 'free', billing_interval = NULL, period_start = NULL, period_end = NULL,
             next_plan = NULL, next_interval = NULL, version = version + 1, updated_at = now()
       WHERE shop_id = ${shopId}`);
    await appendEvent<SubscriptionChangedPayload>(tx, shopId, {
      type: BillingEvents.SubscriptionChanged,
      aggregateType: 'shop',
      aggregateId: shopId,
      payload: { plan: 'free', interval: null, periodEnd: null, nextPlan: null, reason },
    });
  }

  async #subscriptionRecordIn(tx: Tx, shopId: string): Promise<SubscriptionRecord> {
    const row = await subscriptionIn(tx, shopId, false);
    const { rows: open } = await tx.execute<InvoiceRow>(sql`
      SELECT ${INVOICE_COLUMNS} FROM billing.invoices
       WHERE shop_id = ${shopId} AND status = 'open'`);
    const periodEnd = row?.period_end ? toDate(row.period_end) : null;
    return {
      plan: PLANS[row?.plan ?? 'free'],
      interval: row?.billing_interval ?? null,
      periodStart: row?.period_start ? toDate(row.period_start) : null,
      periodEnd,
      pastDue: periodEnd !== null && periodEnd.getTime() <= Date.now(),
      nextPlan: row?.next_plan ? PLANS[row.next_plan] : null,
      nextInterval: row?.next_interval ?? null,
      openInvoice: open[0] ? toInvoiceRecord(open[0]) : null,
    };
  }

  async #pageViewIn(tx: Tx, shopId: string, invoiceId: string): Promise<InvoicePageView | null> {
    const { rows } = await tx.execute<InvoiceRow>(sql`
      SELECT ${INVOICE_COLUMNS} FROM billing.invoices
       WHERE shop_id = ${shopId} AND id = ${invoiceId}`);
    if (!rows[0]) return null;
    const invoice = toInvoiceRecord(rows[0]);
    const row = await subscriptionIn(tx, shopId, false);
    return {
      shopName: (await shopProfile(tx, shopId)).name,
      invoice,
      periodEnd:
        invoice.status === 'paid' && row?.period_end && row.plan === invoice.plan.code
          ? toDate(row.period_end)
          : null,
    };
  }
}

async function subscriptionIn(
  tx: Tx,
  shopId: string,
  lock: boolean,
): Promise<SubscriptionRow | null> {
  const { rows } = await tx.execute<SubscriptionRow>(sql`
    SELECT plan, billing_interval, period_start, period_end, next_plan, next_interval
      FROM billing.subscriptions
     WHERE shop_id = ${shopId}
     ${lock ? sql`FOR UPDATE` : sql``}`);
  return rows[0] ?? null;
}

async function voidOpenInvoices(tx: Tx, shopId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE billing.invoices SET status = 'void', updated_at = now()
     WHERE shop_id = ${shopId} AND status = 'open'`);
}

async function insertInvoice(
  tx: Tx,
  shopId: string,
  invoice: {
    reason: InvoiceReasonValue;
    plan: Exclude<PlanCode, 'free'>;
    interval: BillingIntervalValue;
    price: bigint;
    credit: bigint;
  },
): Promise<InvoiceRecord> {
  const { rows } = await tx.execute<InvoiceRow>(sql`
    INSERT INTO billing.invoices (shop_id, reason, plan, billing_interval, price, credit)
    VALUES (${shopId}, ${invoice.reason}, ${invoice.plan}, ${invoice.interval}, ${invoice.price},
            ${invoice.credit})
    RETURNING ${INVOICE_COLUMNS}`);
  const record = toInvoiceRecord(rows[0]!);
  await appendEvent<InvoicePayload>(tx, shopId, {
    type: BillingEvents.InvoiceCreated,
    aggregateType: 'billing_invoice',
    aggregateId: record.id,
    payload: invoicePayloadOf(record),
  });
  return record;
}

function invoicePayloadOf(invoice: InvoiceRecord): InvoicePayload {
  return {
    number: invoice.name,
    reason: invoice.reason,
    plan: invoice.plan.code,
    interval: invoice.interval,
    amount: invoice.amount.toString(),
  };
}

function toInvoiceRecord(row: InvoiceRow): InvoiceRecord {
  const number = Number(row.number);
  return {
    id: row.id,
    number,
    name: invoiceName(number),
    reason: row.reason,
    plan: PLANS[row.plan],
    interval: row.billing_interval,
    price: BigInt(row.price),
    credit: BigInt(row.credit),
    amount: BigInt(row.amount),
    status: row.status,
    reference: row.reference,
    paidAt: row.paid_at === null ? null : toDate(row.paid_at),
    createdAt: toDate(row.created_at),
  };
}

/** An amount in rupees as invoices say it: "Rs 6,999". */
export function rupees(amount: bigint): string {
  return formatMoney(money(amount, BILLING_CURRENCY));
}
