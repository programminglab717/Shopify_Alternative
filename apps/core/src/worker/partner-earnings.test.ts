import { BillingEvents } from '@hatti/billing/public';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PartnerEarnings } from './partner-earnings.js';

const server = testDatabaseServer();

describe.skipIf(!server)(
  "Partners' share of what stores they brought pay (PRT-02, ADR-505)",
  () => {
    let testDb: TestDatabase;
    let database: Database;
    let admin: pg.Client;
    const shopId = newId();
    const partnerId = newId();

    const paid = (reason: string, plan: string | null, amount: string, id = newId()) => ({
      id: newId(),
      type: BillingEvents.InvoicePaid,
      shopId,
      aggregateType: 'billing_invoice',
      aggregateId: id,
      payload: { number: 'HB-001234', reason, plan, interval: 'monthly', amount },
      occurredAt: new Date().toISOString(),
    });

    beforeAll(async () => {
      testDb = await createTestDatabase(server!);
      database = new Database({ appUrl: testDb.appUrl, applicationName: 'partner-earnings-test' });
      admin = new pg.Client({ connectionString: testDb.adminUrl });
      await admin.connect();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`,
        [shopId],
      );
      await admin.query(
        `INSERT INTO identity.users (id, name, email) VALUES ($1, 'Bilal', 'bilal@pixel.pk')`,
        [partnerId],
      );
      await admin.query(
        `INSERT INTO identity.partners (user_id, business_name, referral_code)
       VALUES ($1, 'Pixel Media', 'k7mq2xpa')`,
        [partnerId],
      );
      await admin.query(
        `INSERT INTO identity.partner_stores (shop_id, partner_id, kind) VALUES ($1, $2, 'referred')`,
        [shopId, partnerId],
      );
    });

    afterAll(async () => {
      await database?.close();
      await admin?.end();
      await testDb?.drop();
    });

    it("records the partner's share of each plan invoice paid, once, and none of credit", async () => {
      const earnings = new PartnerEarnings(database);
      const invoice = newId();
      await earnings.handle(paid('renewal', 'growth', '299900', invoice));
      // Heard again, as the outbox may deliver it: earned once.
      await earnings.handle(paid('renewal', 'growth', '299900', invoice));
      await earnings.handle(paid('credits', null, '100000'));
      const { rows } = await admin.query(
        `SELECT partner_id, invoice_id, invoice_number::text, plan, invoice_amount::text,
              share_percent, amount::text
         FROM identity.partner_earnings`,
      );
      expect(rows).toEqual([
        {
          partner_id: partnerId,
          invoice_id: invoice,
          invoice_number: '1234',
          plan: 'growth',
          invoice_amount: '299900',
          share_percent: 20,
          amount: '59980',
        },
      ]);
    });
  },
);
