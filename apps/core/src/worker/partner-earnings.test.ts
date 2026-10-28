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

    const paid = (
      reason: string,
      plan: string | null,
      amount: string,
      id = newId(),
      tax?: string,
      themeId?: string,
    ) => ({
      id: newId(),
      type: BillingEvents.InvoicePaid,
      shopId,
      aggregateType: 'billing_invoice',
      aggregateId: id,
      payload: { number: 'HB-001234', reason, plan, interval: 'monthly', amount, tax, themeId },
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
      // A taxed invoice: the share is of what Hatti earns, without the sales tax (ADR-512).
      const taxed = newId();
      await earnings.handle(paid('renewal', 'growth', '347884', taxed, '47984'));
      const { rows } = await admin.query(
        `SELECT partner_id, invoice_id, invoice_number::text, plan, invoice_amount::text,
              share_percent, amount::text
         FROM identity.partner_earnings ORDER BY invoice_id`,
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
        {
          partner_id: partnerId,
          invoice_id: taxed,
          invoice_number: '1234',
          plan: 'growth',
          invoice_amount: '299900',
          share_percent: 20,
          amount: '59980',
        },
      ]);
    });

    it("records a designer's share of each theme of theirs a shop buys, once (ADR-853)", async () => {
      const designer = newId();
      await admin.query(
        `INSERT INTO identity.users (id, name, email) VALUES ($1, 'Hira', 'hira@rang.pk')`,
        [designer],
      );
      await admin.query(
        `INSERT INTO identity.partners (user_id, business_name, referral_code)
         VALUES ($1, 'Rang Studio', 'r4ngst2d')`,
        [designer],
      );
      const studio = newId();
      await admin.query(
        `INSERT INTO control.shops (id, name, handle, development) VALUES ($1, 'Rang lab', 'rang-lab', true)`,
        [studio],
      );
      const { rows: themes } = await admin.query<{ id: string }>(
        `INSERT INTO identity.partner_themes
                (partner_id, source_shop, source_theme, name, base, files, price)
         VALUES ($1, $2, $3, 'Basant', 'hatti-base', '{}', 500000) RETURNING id`,
        [designer, studio, newId()],
      );
      const earnings = new PartnerEarnings(database);
      const invoice = newId();
      // Rs 5,000 and its sales tax: the share is of what Hatti earns.
      const sold = paid('theme', null, '580000', invoice, '80000', themes[0]!.id);
      await earnings.handle(sold);
      await earnings.handle(sold);
      const { rows } = await admin.query(
        `SELECT partner_id, plan, invoice_amount::text, share_percent, amount::text
           FROM identity.partner_earnings WHERE invoice_id = $1`,
        [invoice],
      );
      expect(rows).toEqual([
        {
          partner_id: designer,
          plan: 'theme',
          invoice_amount: '500000',
          share_percent: 80,
          amount: '400000',
        },
      ]);
    });
  },
);
