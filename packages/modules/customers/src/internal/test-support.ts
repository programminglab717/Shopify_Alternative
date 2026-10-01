// Shared set-up for the customers module's database tests. Not part of the build.
import type { MutationResult, TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { BlocklistService } from './blocklist.service.js';
import {
  CustomerDataRegistry,
  type CustomerDataHandler,
  type CustomerIdentity,
} from './customer-data.js';
import { CustomerDataService } from './customer-data.service.js';
import { CustomerTransferService } from './customer-transfer.service.js';
import { CustomerService } from './customer.service.js';
import { SegmentFieldRegistry } from './segment-fields.js';
import { SegmentService } from './segment.service.js';

export interface OutboxRow {
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

export interface CustomersFixture {
  testDb: TestDatabase;
  db: Database;
  admin: pg.Client;
  /** Two shops, so every test can check the other one sees nothing. */
  a: TenantContext;
  b: TenantContext;
  /** A staff member of shop A. */
  staff: TenantContext;
  customers: CustomerService;
  blocklist: BlocklistService;
  /** With only the customers module's own fields. */
  registry: SegmentFieldRegistry;
  segments: SegmentService;
  transfer: CustomerTransferService;
  /** With {@link handler} registered, as the orders module registers at start-up. */
  data: CustomerDataService;
  handler: TestDataHandler;
  /** Events recorded so far, oldest first. */
  outbox(): Promise<OutboxRow[]>;
  /** Empties customers, the blocklist, segments and the outbox between tests. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const SCOPES = new Set(['write_customers', 'write_segments']);

/** Another module's customer data, standing in for orders: it records what it was asked to do. */
export class TestDataHandler implements CustomerDataHandler {
  readonly key = 'test';
  calls: string[] = [];
  /** What erasureBlockers answers. */
  blockers: string[] = [];
  /** What export answers. */
  sections: Record<string, unknown> = {};

  erasureBlockers(): Promise<string[]> {
    return Promise.resolve(this.blockers);
  }

  merge(_tx: unknown, _shopId: string, fromId: string, intoId: string): Promise<void> {
    this.calls.push(`merge ${fromId} into ${intoId}`);
    return Promise.resolve();
  }

  erase(_tx: unknown, _shopId: string, customer: CustomerIdentity): Promise<void> {
    this.calls.push(`erase ${customer.id} ${customer.phones.join(',')} ${customer.email}`);
    return Promise.resolve();
  }

  export(
    _tx: unknown,
    _shopId: string,
    customer: CustomerIdentity,
  ): Promise<Record<string, unknown>> {
    this.calls.push(`export ${customer.id} ${customer.phones.join(',')} ${customer.email}`);
    return Promise.resolve(this.sections);
  }
}

export async function customersFixture(server: string): Promise<CustomersFixture> {
  const testDb = await createTestDatabase(server);
  const db = new Database({ appUrl: testDb.appUrl, applicationName: 'customers-test' });
  const admin = new pg.Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  const app = (shopId: string): TenantContext => ({
    shopId,
    currency: 'PKR',
    actor: { kind: 'app', tokenId: newId() },
    scopes: SCOPES,
  });
  const a = app(newId());
  const b = app(newId());
  const staff: TenantContext = {
    ...a,
    actor: {
      kind: 'staff',
      userId: newId(),
      sessionId: newId(),
      authenticatedAt: new Date(),
      role: 'manager',
    },
  };
  await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'A'), ($2, 'B')`, [
    a.shopId,
    b.shopId,
  ]);
  const registry = new SegmentFieldRegistry();
  const segments = new SegmentService(db, registry);
  const handler = new TestDataHandler();
  const dataRegistry = new CustomerDataRegistry();
  dataRegistry.register(handler);
  return {
    testDb,
    db,
    admin,
    a,
    b,
    staff,
    customers: new CustomerService(db),
    blocklist: new BlocklistService(db),
    registry,
    segments,
    transfer: new CustomerTransferService(db, registry, segments),
    data: new CustomerDataService(db, dataRegistry),
    handler,
    async outbox() {
      const { rows } = await admin.query<OutboxRow>(
        `SELECT event_type, aggregate_type, aggregate_id, payload FROM platform.outbox_events
          ORDER BY occurred_at, id`,
      );
      return rows;
    },
    async reset() {
      await admin.query(`
        DELETE FROM customers.consent_events;
        DELETE FROM customers.customers;
        DELETE FROM customers.blocklist_entries;
        DELETE FROM customers.segments;
        DELETE FROM platform.outbox_events;`);
      handler.calls = [];
      handler.blockers = [];
      handler.sections = {};
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

/** The [field path, code] pairs of a failed result. */
export function errorsOf(result: MutationResult<unknown>): [string, string][] {
  if (result.ok) throw new Error('Expected user errors, got success');
  return result.errors.map((error) => [error.field.join('.'), error.code]);
}
