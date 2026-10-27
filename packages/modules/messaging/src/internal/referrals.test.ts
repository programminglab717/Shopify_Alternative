import 'reflect-metadata';
import { PlanAllowance, type MutationResult, type TenantContext } from '@hatti/api';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MESSAGING_CUSTOMER_DATA } from './customer-data.js';
import {
  ReferralProgramService,
  recordReferralIn,
  referralProgramIn,
  referrerOfIn,
} from './referrals.service.js';

/** A plan that leaves out every feature it is asked about (ADR-523). */
class Free extends PlanAllowance {
  async limitOf(): Promise<null> {
    return null;
  }

  async limitIn(): Promise<null> {
    return null;
  }

  async excludes(): Promise<string> {
    return 'Free';
  }
}

const server = testDatabaseServer();

function unwrap<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

const A: TenantContext = {
  shopId: newId(),
  currency: 'PKR',
  actor: { kind: 'app', tokenId: newId() },
  scopes: new Set(['write_marketing_events']),
};

describe.skipIf(!server)("A shop's referral programme (MKT-07, ADR-807)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let admin: pg.Client;
  let referrals: ReferralProgramService;

  const customer = async (phone: string) => {
    const id = newId();
    await admin.query(
      `WITH added AS (
         INSERT INTO customers.customers (shop_id, id, phone, name)
         VALUES ($1, $2, $3, 'Ayesha Khan')
         RETURNING shop_id, id, phone)
       INSERT INTO customers.customer_phones (shop_id, phone, customer_id)
       SELECT shop_id, phone, id FROM added`,
      [A.shopId, id, phone],
    );
    return id;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(server!);
    db = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'referrals-test',
    });
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, 'Zari')`, [A.shopId]);
    referrals = new ReferralProgramService(db);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it('is off until the shop turns it on, its credit and days within bounds, audited', async () => {
    expect(await referrals.get(A)).toEqual({
      enabled: false,
      referrerCredit: 200_00n,
      friendCredit: 200_00n,
      creditDays: 90,
      minimumOrder: 0n,
      updatedAt: null,
    });
    const code = async (result: Promise<MutationResult<unknown>>) => {
      const done = await result;
      return done.ok ? 'ok' : `${done.errors[0]!.field.join('.')}: ${done.errors[0]!.message}`;
    };
    expect(await code(referrals.update(A, { referrerCredit: '5' }))).toBe(
      'input.referrerCredit: Give the referrer between Rs 10 and Rs 10,000 in store credit',
    );
    expect(await code(referrals.update(A, { friendCredit: '10,001' }))).toBe(
      'input.friendCredit: Give the friend up to Rs 10,000 in store credit',
    );
    expect(await code(referrals.update(A, { minimumOrder: '1,000,001' }))).toBe(
      "input.minimumOrder: A friend's order may ask for up to Rs 1,000,000",
    );
    expect(await code(referrals.update(A, { creditDays: 6 }))).toBe(
      'input.creditDays: The credit lasts between 7 and 365 days',
    );
    // Without a plan with loyalty, it stays off.
    expect(
      await code(new ReferralProgramService(db, new Free()).update(A, { enabled: true })),
    ).toBe(
      "input.enabled: The Free plan doesn't include referrals: choose a bigger plan to turn them on",
    );
    expect(await db.tenant(A.shopId, (tx) => referralProgramIn(tx, A.shopId))).toBeNull();

    expect(
      unwrap(
        await referrals.update(A, {
          enabled: true,
          referrerCredit: '300',
          friendCredit: '0',
          creditDays: 60,
          minimumOrder: '1,500',
        }),
      ),
    ).toMatchObject({
      enabled: true,
      referrerCredit: 300_00n,
      friendCredit: 0n,
      creditDays: 60,
      minimumOrder: 1_500_00n,
    });
    expect(await db.tenant(A.shopId, (tx) => referralProgramIn(tx, A.shopId))).toMatchObject({
      referrerCredit: 300_00n,
    });
    // Left out, as it was.
    expect(unwrap(await referrals.update(A, { enabled: false }))).toMatchObject({
      enabled: false,
      referrerCredit: 300_00n,
    });
    const { rows } = await admin.query(
      `SELECT details ->> 'referrerCredit' AS credit FROM platform.audit_log
        WHERE shop_id = $1 AND action = 'referral_program.updated' ORDER BY id`,
      [A.shopId],
    );
    expect(rows).toEqual([{ credit: '30000' }, { credit: '30000' }]);
  });

  it('gives each customer one code of their own, found by it whatever its case', async () => {
    const sana = await customer('+923001110001');
    const hina = await customer('+923001110002');
    const code = (await referrals.codeOf(A.shopId, sana))!;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(await referrals.codeOf(A.shopId, sana)).toBe(code);
    expect(await referrals.codeOf(A.shopId, hina)).not.toBe(code);
    expect(await referrals.codeOf(A.shopId, newId())).toBeNull();
    expect(await db.tenant(A.shopId, (tx) => referrerOfIn(tx, A.shopId, code.toLowerCase()))).toBe(
      sana,
    );
    expect(await db.tenant(A.shopId, (tx) => referrerOfIn(tx, A.shopId, 'ABCDEFGH'))).toBeNull();
  });

  it("lists referrals, latest first; a merged customer's become the other's, an erased one's go", async () => {
    const sana = await customer('+923001110011');
    const twin = await customer('+923001110012');
    const friend = await customer('+923001110013');
    const twinCode = (await referrals.codeOf(A.shopId, twin))!;
    const keep = (orderId: string, at: Date) =>
      db.tenant(A.shopId, (tx) =>
        recordReferralIn(
          tx,
          A.shopId,
          {
            orderId,
            referrerId: twin,
            friendId: friend,
            outcome: 'refused',
            reason: 'same_device',
            referrerCredit: 0n,
            friendCredit: 0n,
          },
          at,
        ),
      );
    const [first, second] = [newId(), newId()];
    expect(await keep(first, new Date('2026-10-01T10:00:00Z'))).toBe(true);
    expect(await keep(first, new Date('2026-10-01T10:00:00Z'))).toBe(false);
    expect(await keep(second, new Date('2026-10-02T10:00:00Z'))).toBe(true);
    expect((await referrals.referrals(A)).map((each) => each.orderId)).toEqual([second, first]);

    // Twin merged into Sana, who had no code: theirs becomes Sana's, with their referrals.
    await db.tenant(A.shopId, (tx) => MESSAGING_CUSTOMER_DATA.merge(tx, A.shopId, twin, sana));
    expect(await referrals.codeOf(A.shopId, sana)).toBe(twinCode);
    expect((await referrals.referrals(A)).map((each) => each.referrerId)).toEqual([sana, sana]);

    await db.tenant(A.shopId, (tx) =>
      MESSAGING_CUSTOMER_DATA.erase(
        tx,
        A.shopId,
        { id: friend, phones: ['+923001110013'], email: null } as never,
        'system',
      ),
    );
    expect(await referrals.referrals(A)).toEqual([]);
    expect(await db.tenant(A.shopId, (tx) => referrerOfIn(tx, A.shopId, twinCode))).toBe(sana);
  });
});
