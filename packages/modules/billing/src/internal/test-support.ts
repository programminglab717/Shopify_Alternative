// Shared set-up for the billing module's database tests. Not part of the build.
import { PublicSite, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { TestGateway, type GatewayAccount } from '@hatti/payments/public';
import pg from 'pg';
import { BillingService, type HattiBankAccount, type HattiGateway } from './billing.service.js';
import { MessageWallet } from './credits.js';
import type { BillingIntervalValue, PlanCode } from './plans.js';

export interface OutboxRow {
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

export interface BillingFixture {
  testDb: TestDatabase;
  db: Database;
  admin: pg.Client;
  /** Two shops, each as its owner, so every test can check the other one sees nothing. */
  a: TenantContext;
  b: TenantContext;
  billing: BillingService;
  /** Hatti's own account with the test gateway. */
  gateway: TestGateway;
  hatti: HattiGateway;
  /** Hatti's own bank account, which invoices are paid into by transfer (ADR-254). */
  bank: HattiBankAccount;
  /** The billing service of a host that set up no gateway for Hatti, nor any bank account. */
  unpaid: BillingService;
  /** The credit shops' messages are paid from. */
  wallet: MessageWallet;
  /**
   * Puts the shop on `plan`, its period from `start` to `end`, as a payment would have; with a
   * plan chosen for later, if given.
   */
  subscribe(
    tenant: TenantContext,
    plan: Exclude<PlanCode, 'free'>,
    interval: BillingIntervalValue,
    period: { start: Date; end: Date },
    next?: { plan: PlanCode; interval: BillingIntervalValue | null },
  ): Promise<void>;
  /** The form Hatti's gateway sends the owner back with, for the page `url` it gave. */
  formOf(url: string): Record<string, string>;
  /** Events recorded so far, oldest first. */
  outbox(): Promise<OutboxRow[]>;
  /** Empties billing, the audit log and the outbox. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

function owner(shopId: string): TenantContext {
  return {
    shopId,
    currency: 'PKR',
    actor: {
      kind: 'staff',
      userId: newId(),
      sessionId: newId(),
      role: 'owner',
      authenticatedAt: new Date(),
    },
    scopes: new Set(['write_settings']),
  } as TenantContext;
}

export async function billingFixture(server: string): Promise<BillingFixture> {
  const testDb = await createTestDatabase(server);
  const db = new Database({
    appUrl: testDb.appUrl,
    systemUrl: testDb.systemUrl,
    applicationName: 'billing-test',
  });
  const admin = new pg.Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  const a = owner(newId());
  const b = owner(newId());
  await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari'), ($2, 'B')`, [
    a.shopId,
    b.shopId,
  ]);
  const site = new PublicSite('https://hatti.test');
  const gateway = new TestGateway();
  const account: GatewayAccount = { environment: 'production', credentials: { secret: 'hatti' } };
  const hatti: HattiGateway = { gateway, account };
  const bank: HattiBankAccount = {
    title: 'Hatti Technologies (Private) Limited',
    bankName: 'Standard Chartered',
    iban: 'PK36SCBL0000001123456702',
    raastId: '+923001234567',
  };
  return {
    testDb,
    db,
    admin,
    a,
    b,
    billing: new BillingService(db, site, hatti, bank),
    gateway,
    hatti,
    bank,
    unpaid: new BillingService(db, site, null, null),
    wallet: new MessageWallet(db),
    async subscribe(tenant, plan, interval, period, next) {
      await admin.query(
        `INSERT INTO billing.subscriptions
           (shop_id, plan, billing_interval, period_start, period_end, next_plan, next_interval)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (shop_id) DO UPDATE
            SET plan = EXCLUDED.plan, billing_interval = EXCLUDED.billing_interval,
                period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
                next_plan = EXCLUDED.next_plan, next_interval = EXCLUDED.next_interval`,
        [
          tenant.shopId,
          plan,
          interval,
          period.start,
          period.end,
          next?.plan ?? null,
          next?.interval ?? null,
        ],
      );
    },
    formOf(url) {
      return Object.fromEntries(new URL(url).searchParams);
    },
    async outbox() {
      const { rows } = await admin.query<OutboxRow>(
        `SELECT event_type, aggregate_id, payload
           FROM platform.outbox_events ORDER BY occurred_at, id`,
      );
      return rows;
    },
    async reset() {
      gateway.checkouts.length = 0;
      gateway.refusing = null;
      await admin.query(`
        DELETE FROM billing.wallet_entries;
        DELETE FROM billing.wallets;
        DELETE FROM billing.payments;
        DELETE FROM billing.invoices;
        DELETE FROM billing.subscriptions;
        DELETE FROM platform.audit_log;
        DELETE FROM platform.outbox_events;`);
    },
    async close() {
      await db.close();
      await admin.end();
      await testDb.drop();
    },
  };
}

/** The value of a successful result; fails the test with the errors otherwise. */
export function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

/** A failed result's errors, as [field, code]. */
export function errorsOf(result: MutationResult<unknown>): [string, string][] {
  if (result.ok) throw new Error('Expected user errors, got success');
  return result.errors.map((error) => [error.field.join('.'), error.code]);
}
