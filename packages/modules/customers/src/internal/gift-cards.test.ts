import 'reflect-metadata';
import { createHash } from 'node:crypto';
import type { MutationResult, TenantContext } from '@hatti/api';
import { pgError } from '@hatti/db';
import { testDatabaseServer } from '@hatti/db/testing';
import { listAudit } from '@hatti/events';
import { newId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GiftCardService,
  dayIn,
  formatGiftCardCode,
  normalizeGiftCardCode,
} from './gift-cards.service.js';
import { customersFixture, unwrap, type CustomersFixture } from './test-support.js';

const server = testDatabaseServer();

// 14:00 in Karachi on 1 March 2027.
const T0 = new Date('2027-03-01T09:00:00Z');
const rupees = (amount: string) => ({ amount });

/** What was refused, each error's field and message. */
const errorsOf = (result: MutationResult<unknown>): [string, string][] =>
  result.ok ? [] : result.errors.map((error) => [error.field.join('.'), error.message]);

describe.skipIf(!server)('Gift cards (CAT-12, PAY-13, ADR-448)', () => {
  let f: CustomersFixture;
  let cards: GiftCardService;

  beforeAll(async () => {
    f = await customersFixture(server!);
    cards = new GiftCardService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  async function customer(tenant: TenantContext, phone: string, name: string): Promise<string> {
    return unwrap(await f.customers.create(tenant, { phone, name })).id;
  }

  /** A card's ledger, the newest first: kind, signed amount and balance after. */
  async function ledger(tenant: TenantContext, id: string) {
    const page = await cards.transactions(tenant, id, { first: 50 });
    return page.items.map((item) => [item.kind, item.amount, item.balanceAfter]);
  }

  it('issues a card with a code made for it, given once and kept as a digest alone', async () => {
    const issued = unwrap(await cards.create(f.staff, { initialValue: '5000' }, T0));
    expect(issued.code).toMatch(/^[A-HJ-NP-Z2-9]{16}$/);
    expect(issued.giftCard).toMatchObject({
      lastCharacters: issued.code.slice(-4),
      currency: 'PKR',
      initialValue: 500_000n,
      balance: 500_000n,
      expiresOn: null,
      expired: false,
      customerId: null,
      deactivatedAt: null,
    });
    expect(formatGiftCardCode(issued.code)).toMatch(/^(\w{4} ){3}\w{4}$/);
    const { rows } = await f.admin.query<{ code_hash: Buffer; last_characters: string }>(
      'SELECT code_hash, last_characters FROM customers.gift_cards',
    );
    expect(rows).toEqual([
      {
        code_hash: createHash('sha256').update(issued.code).digest(),
        last_characters: issued.code.slice(-4),
      },
    ]);
    expect(await ledger(f.staff, issued.giftCard.id)).toEqual([['issue', 500_000n, 500_000n]]);

    // The shop's own code, as typed with spaces and dashes; the same code again is refused.
    const own = unwrap(
      await cards.create(
        f.staff,
        { initialValue: '2500', code: 'eid-gift 2027', expiresOn: '2027-03-01', note: 'Eid' },
        T0,
      ),
    );
    expect(own.code).toBe('EIDGIFT2027');
    expect(own.giftCard).toMatchObject({ lastCharacters: '2027', expiresOn: '2027-03-01' });
    expect(normalizeGiftCardCode(' eidgift-2027 ')).toBe('EIDGIFT2027');
    expect(
      errorsOf(await cards.create(f.staff, { initialValue: '1', code: 'EIDGIFT2027' }, T0)),
    ).toEqual([['input.code', 'Another gift card has this code']]);
    // Each card issued is in the activity log, its code's end alone.
    const audit = await f.db.tenant(f.a.shopId, (tx) =>
      listAudit(tx, f.a.shopId, { first: 10, subjectId: own.giftCard.id }),
    );
    expect(audit.items.map((entry) => [entry.action, entry.details])).toEqual([
      [
        'gift_card.created',
        { lastCharacters: '2027', initialValue: '2500.00', expiresOn: '2027-03-01' },
      ],
    ]);
  });

  it('refuses nothing, too much, a bad code, a day past or not a day, and no customer', async () => {
    const refused = async (input: Parameters<GiftCardService['create']>[1]) =>
      errorsOf(await cards.create(f.a, input, T0));
    expect(await refused({ initialValue: '0' })).toEqual([
      ['input.initialValue', 'It must be more than 0'],
    ]);
    expect(await refused({ initialValue: '100000.01' })).toEqual([
      ['input.initialValue', 'A gift card holds at most Rs 100,000'],
    ]);
    expect(await refused({ initialValue: '-5' })).toHaveLength(1);
    expect(await refused({ initialValue: '50', code: 'SHORT' })).toEqual([
      ['input.code', 'A code is 8 to 20 letters and digits'],
    ]);
    expect(await refused({ initialValue: '50', code: 'NO_UNDERSCORES' })).toHaveLength(1);
    expect(await refused({ initialValue: '50', expiresOn: '2027-02-28' })).toEqual([
      ['input.expiresOn', 'It must expire today or later'],
    ]);
    expect(await refused({ initialValue: '50', expiresOn: '2027-02-30' })).toEqual([
      ['input.expiresOn', 'Give a day, like 2026-12-31'],
    ]);
    expect(await refused({ initialValue: '50', customerId: newId() })).toEqual([
      ['input.customerId', 'Customer not found'],
    ]);
    // Another shop's card is not this one's.
    const { giftCard } = unwrap(await cards.create(f.b, { initialValue: '50' }, T0));
    expect(await cards.get(f.a, giftCard.id, T0)).toBeNull();
    expect(errorsOf(await cards.credit(f.a, giftCard.id, rupees('5'), T0))).toEqual([
      ['id', 'Gift card not found'],
    ]);
  });

  it('credits and debits by hand, within what it holds and up to Rs 100,000', async () => {
    const { giftCard } = unwrap(await cards.create(f.staff, { initialValue: '1000' }, T0));
    const credited = unwrap(
      await cards.credit(f.staff, giftCard.id, { amount: '500', note: 'Sorry for the delay' }, T0),
    );
    expect(credited.giftCard.balance).toBe(150_000n);
    expect(credited.transaction).toMatchObject({
      kind: 'credit',
      amount: 50_000n,
      balanceAfter: 150_000n,
      note: 'Sorry for the delay',
    });
    unwrap(await cards.debit(f.staff, giftCard.id, rupees('200'), T0));
    expect(await ledger(f.staff, giftCard.id)).toEqual([
      ['debit', -20_000n, 130_000n],
      ['credit', 50_000n, 150_000n],
      ['issue', 100_000n, 100_000n],
    ]);
    expect(errorsOf(await cards.debit(f.staff, giftCard.id, rupees('1300.01'), T0))).toEqual([
      ['debitInput.amount', 'This gift card has Rs 1,300'],
    ]);
    expect(errorsOf(await cards.credit(f.staff, giftCard.id, rupees('98700.01'), T0))).toEqual([
      ['creditInput.amount', 'A gift card holds at most Rs 100,000, and this one has Rs 1,300'],
    ]);
    unwrap(await cards.debit(f.staff, giftCard.id, rupees('1300'), T0));
    expect(errorsOf(await cards.debit(f.staff, giftCard.id, rupees('1'), T0))).toEqual([
      ['debitInput.amount', 'This gift card has nothing left'],
    ]);

    // Two debits at once spend it once: each waits for the other's lock.
    unwrap(await cards.credit(f.staff, giftCard.id, rupees('1000'), T0));
    const both = await Promise.all([
      cards.debit(f.staff, giftCard.id, rupees('600'), T0),
      cards.debit(f.staff, giftCard.id, rupees('600'), T0),
    ]);
    expect(both.filter((result) => result.ok)).toHaveLength(1);
    expect((await cards.get(f.staff, giftCard.id, T0))!.balance).toBe(40_000n);
  });

  it('changes its expiry, customer and note, expires in the shop’s time zone, and deactivates for good', async () => {
    const ayesha = await customer(f.staff, '0300 1234567', 'Ayesha Khan');
    const { giftCard } = unwrap(
      await cards.create(f.staff, { initialValue: '1000', expiresOn: '2027-03-31' }, T0),
    );
    const changed = unwrap(
      await cards.update(
        f.staff,
        giftCard.id,
        { expiresOn: '2027-03-01', customerId: ayesha, note: 'Birthday' },
        T0,
      ),
    );
    expect(changed).toMatchObject({
      expiresOn: '2027-03-01',
      customerId: ayesha,
      note: 'Birthday',
      expired: false,
    });
    // Left out stays; null takes it away.
    expect(unwrap(await cards.update(f.staff, giftCard.id, { expiresOn: null }, T0))).toMatchObject(
      { expiresOn: null, customerId: ayesha, note: 'Birthday' },
    );
    unwrap(await cards.update(f.staff, giftCard.id, { expiresOn: '2027-03-01' }, T0));
    // Its last day is the 1st in Karachi: on the 2nd there, at 19:30 UTC on the 1st, it has
    // expired.
    const lateOnThe1st = new Date('2027-03-01T19:30:00Z');
    expect(dayIn('Asia/Karachi', lateOnThe1st)).toBe('2027-03-02');
    expect((await cards.get(f.staff, giftCard.id, lateOnThe1st))!.expired).toBe(true);
    expect((await cards.get(f.staff, giftCard.id, T0))!.expired).toBe(false);

    const deactivated = unwrap(await cards.deactivate(f.staff, giftCard.id, T0));
    expect(deactivated.deactivatedAt).toBeInstanceOf(Date);
    expect(unwrap(await cards.deactivate(f.staff, giftCard.id, T0)).deactivatedAt).toEqual(
      deactivated.deactivatedAt,
    );
    for (const result of [
      await cards.credit(f.staff, giftCard.id, rupees('5'), T0),
      await cards.update(f.staff, giftCard.id, { note: 'Again' }, T0),
    ]) {
      expect(errorsOf(result)).toEqual([['id', 'A deactivated gift card can’t be changed']]);
    }

    // Found by the code's last characters, the newest first, a page at a time.
    const more = unwrap(
      await cards.create(f.staff, { initialValue: '10', code: 'ABCDEFGH1234' }, T0),
    );
    const page = await cards.list(f.staff, { first: 1 }, T0);
    expect(page.items.map((item) => item.id)).toEqual([more.giftCard.id]);
    expect(page.hasNextPage).toBe(true);
    const next = await cards.list(f.staff, { first: 1, after: page.items[0]! }, T0);
    expect(next.items.map((item) => item.id)).toEqual([giftCard.id]);
    expect((await cards.list(f.staff, { first: 5, query: 'h-1234' }, T0)).items).toHaveLength(1);
    expect((await cards.list(f.staff, { first: 5, query: '9999' }, T0)).items).toEqual([]);
  });

  it('follows its customer through a merge, stays the shop’s once they are erased, and keeps its ledger', async () => {
    const ayesha = await customer(f.staff, '0300 1234567', 'Ayesha Khan');
    const duplicate = await customer(f.staff, '0311 1234567', 'Ayesha K');
    const { giftCard } = unwrap(
      await cards.create(f.staff, { initialValue: '750', customerId: duplicate }, T0),
    );
    unwrap(await f.data.merge(f.staff, ayesha, duplicate));
    expect((await cards.get(f.staff, giftCard.id, T0))!.customerId).toBe(ayesha);
    // Their own file has it, without its code.
    const file = JSON.parse(unwrap(await f.data.export(f.staff, ayesha)).json) as {
      giftCards: unknown[];
    };
    expect(file.giftCards).toEqual([
      expect.objectContaining({
        lastCharacters: giftCard.lastCharacters,
        initialValue: '750.00',
        balance: '750.00',
        currency: 'PKR',
        expiresOn: null,
      }),
    ]);
    unwrap(await f.data.erase(f.staff, ayesha));
    expect(await cards.get(f.staff, giftCard.id, T0)).toMatchObject({
      customerId: null,
      balance: 75_000n,
    });

    for (const statement of [
      sql`UPDATE customers.gift_card_transactions SET amount = 1`,
      sql`DELETE FROM customers.gift_card_transactions`,
      sql`DELETE FROM customers.gift_cards`,
      sql`UPDATE customers.gift_cards SET code_hash = code_hash`,
      sql`UPDATE customers.gift_cards SET initial_value = 1`,
    ]) {
      const error = await f.db
        .tenant(f.a.shopId, (tx) => tx.execute(statement))
        .catch((caught: unknown) => caught);
      expect(pgError(error)?.code).toBe('42501');
    }
  });
});
