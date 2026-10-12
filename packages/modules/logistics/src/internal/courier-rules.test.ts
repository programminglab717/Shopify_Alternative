import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CourierRuleService,
  accountByRules,
  type CourierRuleRecord,
  type RuledParcel,
} from './courier-rules.service.js';
import type { RateCardRecord } from './rate-cards.service.js';
import { errorsOf, logisticsFixture, unwrap, type LogisticsFixture } from './test-support.js';

const rule = (fields: Partial<CourierRuleRecord>): CourierRuleRecord => ({
  id: newId(),
  accountId: 'acc',
  cities: [],
  codAtLeast: null,
  codBelow: null,
  accountArchived: false,
  ...fields,
});

/** The account the first rule an order to `city` with `codAmount` to collect matches chooses. */
const ruleFor = (rules: CourierRuleRecord[], city: string | null, codAmount: bigint) =>
  accountByRules(rules, { city, codAmount, weightGrams: null }, []);

const card = (accountId: string, fields: Partial<RateCardRecord>): RateCardRecord => ({
  accountId,
  originCity: 'Karachi',
  localFirst: 15_000n,
  localEach: 5_000n,
  otherFirst: 30_000n,
  otherEach: 10_000n,
  codFeeBp: 0,
  returnBp: 0,
  updatedAt: new Date(),
  ...fields,
});

describe('The first courier rule an order matches (ADR-382)', () => {
  const karachi = rule({ accountId: 'k', cities: ['Karachi'] });
  const dear = rule({ accountId: 'd', codAtLeast: 2_000_000n });
  const cheapLahore = rule({ accountId: 'l', cities: ['Lahore'], codBelow: 500_000n });

  it('matches by city as Pakistan names it, and by the cash to collect, the first winning', () => {
    const rules = [karachi, dear, cheapLahore];
    expect(ruleFor(rules, 'karachi ', 3_000_000n)?.accountId).toBe('k');
    expect(ruleFor(rules, 'Lahore', 2_000_000n)?.accountId).toBe('d');
    expect(ruleFor(rules, 'Lahore', 499_999n)?.accountId).toBe('l');
    expect(ruleFor(rules, 'Lahore', 500_000n)).toBeUndefined();
    expect(ruleFor(rules, 'Multan', 100n)).toBeUndefined();
    expect(ruleFor(rules, null, 2_000_000n)?.accountId).toBe('d');
    expect(ruleFor([rule({ accountId: 'r', cities: ['Rawalpindi'] })], 'Pindi', 0n)).toBeDefined();
  });

  it('passes over a rule whose account was archived', () => {
    expect(
      ruleFor([{ ...karachi, accountArchived: true }, dear], 'Karachi', 2_500_000n)?.accountId,
    ).toBe('d');
  });

  it('chooses the account whose card costs the parcel least, for a rule naming none (ADR-385)', () => {
    const cheapest = rule({ accountId: null });
    // Karachi's account is cheap within Karachi; Lahore's within Lahore, but takes 2% of the cash.
    const cards = [
      card('k', {}),
      card('l', { originCity: 'Lahore', localFirst: 12_000n, otherFirst: 25_000n, codFeeBp: 200 }),
    ];
    const parcel = (city: string, codAmount: bigint, weightGrams: number | null = null) =>
      accountByRules([cheapest], { city, codAmount, weightGrams }, cards)?.accountId;
    expect(parcel('Karachi', 0n)).toBe('k');
    expect(parcel('Lahore', 0n)).toBe('l');
    // To Multan Rs 300 against Rs 250 and Rs 200 of the cash, and at 1.4 kg Rs 500 against Rs 450.
    expect(parcel('Multan', 1_000_000n)).toBe('k');
    expect(parcel('Multan', 0n)).toBe('l');
    expect(parcel('Multan', 0n, 1_400)).toBe('l');
    // Equal, the first: the shop's default comes first.
    expect(parcel('Hyderabad', 250_000n)).toBe('k');

    // Without a card, a rule for the cheapest is passed over for the next.
    const parcelOf: RuledParcel = { city: 'Karachi', codAmount: 0n, weightGrams: null };
    expect(accountByRules([cheapest, dear], { ...parcelOf, codAmount: 2_000_000n }, [])).toEqual({
      rule: dear,
      accountId: 'd',
    });
    expect(accountByRules([cheapest], parcelOf, [])).toBeUndefined();
    // It keeps to the cities and cash it is for.
    const inLahore = rule({ accountId: null, cities: ['Lahore'] });
    expect(accountByRules([inLahore], parcelOf, cards)).toBeUndefined();
  });
});

const server = testDatabaseServer();

describe.skipIf(!server)("A shop's courier rules, and booking by them (ADR-382)", () => {
  let f: LogisticsFixture;
  let rules: CourierRuleService;
  let kurta: string;

  beforeAll(async () => {
    f = await logisticsFixture(server!);
    rules = new CourierRuleService(f.db);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    kurta = await f.variantOf(f.a, 'Kurta', '2,000');
  });

  const testAccount = (name: string) =>
    f.accounts.connect(f.a, {
      courier: 'test',
      name,
      credentials: [{ key: 'key', value: 'anything-9876' }],
    });

  it('keeps rules in their order, refusing what cannot be one, and records the change', async () => {
    const main = unwrap(await testAccount('Main'));
    const karachi = unwrap(await testAccount('Karachi'));
    expect(await rules.list(f.a)).toEqual([]);

    expect(
      errorsOf(
        await rules.replace(f.a, [
          { accountId: newId(), cities: ['Karachi'] },
          { accountId: karachi.id, cities: ['Atlantis'] },
          { accountId: karachi.id },
          { accountId: karachi.id, codAtLeast: '5,000', codBelow: '5,000' },
          { accountId: karachi.id, codAtLeast: 'lots' },
        ]),
      ),
    ).toEqual([
      ['rules.0.accountId', 'NOT_FOUND'],
      ['rules.1.cities.0', 'INVALID'],
      ['rules.2', 'BLANK'],
      ['rules.3.codBelow', 'INVALID'],
      ['rules.4.codAtLeast', 'INVALID'],
    ]);
    // The cheapest is chosen by rate cards, which no account has yet.
    expect(errorsOf(await rules.replace(f.a, [{ accountId: null }]))).toEqual([
      ['rules.0.accountId', 'INVALID'],
    ]);
    expect(
      errorsOf(
        await rules.replace(
          f.a,
          Array.from({ length: 51 }, () => ({ accountId: main.id, cities: ['Lahore'] })),
        ),
      ),
    ).toEqual([['rules', 'INVALID']]);

    const kept = unwrap(
      await rules.replace(f.a, [
        { accountId: karachi.id, cities: ['karachi', 'Hyderabad', 'Karachi'] },
        { accountId: main.id, codAtLeast: '20,000', codBelow: '' },
      ]),
    );
    expect(kept).toEqual([
      {
        id: expect.any(String),
        accountId: karachi.id,
        cities: ['Karachi', 'Hyderabad'],
        codAtLeast: null,
        codBelow: null,
        accountArchived: false,
      },
      {
        id: expect.any(String),
        accountId: main.id,
        cities: [],
        codAtLeast: 2_000_000n,
        codBelow: null,
        accountArchived: false,
      },
    ]);
    expect(await rules.list(f.a)).toEqual(kept);
    expect(await rules.list(f.b)).toEqual([]);
    // The same again changes nothing, and records nothing.
    unwrap(
      await rules.replace(f.a, [
        { accountId: karachi.id, cities: ['Karachi', 'Hyderabad'] },
        { accountId: main.id, codAtLeast: '20000' },
      ]),
    );
    const changes = (await f.outbox()).filter((row) => row.event_type === 'courier_rules.updated');
    expect(changes).toEqual([
      expect.objectContaining({ aggregate_id: f.a.shopId, payload: { count: 2 } }),
    ]);
    // Another shop's account is none of this shop's.
    const theirs = unwrap(
      await f.accounts.connect(f.b, {
        courier: 'test',
        credentials: [{ key: 'key', value: 'anything-9876' }],
      }),
    );
    expect(
      errorsOf(await rules.replace(f.a, [{ accountId: theirs.id, cities: ['Lahore'] }])),
    ).toEqual([['rules.0.accountId', 'NOT_FOUND']]);

    unwrap(await f.accounts.archive(f.a, karachi.id));
    expect((await rules.list(f.a))[0]!.accountArchived).toBe(true);
    expect(
      errorsOf(await rules.replace(f.a, [{ accountId: karachi.id, cities: ['Karachi'] }])),
    ).toEqual([['rules.0.accountId', 'INVALID']]);
    expect(unwrap(await rules.replace(f.a, []))).toEqual([]);
  });

  it("books each order with the account its first rule names, else the shop's default", async () => {
    const main = unwrap(await testAccount('Main'));
    const karachi = unwrap(await testAccount('Karachi'));
    const dear = unwrap(await testAccount('Dear'));
    unwrap(
      await rules.replace(f.a, [
        { accountId: karachi.id, cities: ['Karachi'] },
        { accountId: dear.id, codAtLeast: '5,000' },
      ]),
    );
    const toKarachi = await f.confirmed(f.a, kurta, { city: 'karachi', quantity: 3 });
    const bigLahore = await f.confirmed(f.a, kurta, { quantity: 3 });
    const smallLahore = await f.confirmed(f.a, kurta);

    expect(
      await f.bookings.accountsFor(f.a, [
        toKarachi.orderId,
        bigLahore.orderId,
        smallLahore.orderId,
      ]),
    ).toEqual([
      {
        orderId: toKarachi.orderId,
        accountId: karachi.id,
        ruleId: expect.any(String),
        estimate: null,
      },
      {
        orderId: bigLahore.orderId,
        accountId: dear.id,
        ruleId: expect.any(String),
        estimate: null,
      },
      { orderId: smallLahore.orderId, accountId: main.id, ruleId: null, estimate: null },
    ]);
    const missing = newId();
    expect(await f.bookings.accountsFor(f.a, [missing])).toEqual([
      { orderId: missing, accountId: null, ruleId: null, estimate: null },
    ]);

    const asked = unwrap(
      await f.bookings.request(f.a, {
        orderIds: [toKarachi.orderId, bigLahore.orderId, smallLahore.orderId],
      }),
    );
    expect(asked.refused).toEqual([]);
    expect(
      Object.fromEntries(asked.bookings.map((booking) => [booking.orderId, booking.accountId])),
    ).toEqual({
      [toKarachi.orderId]: karachi.id,
      [bigLahore.orderId]: dear.id,
      [smallLahore.orderId]: main.id,
    });

    // Naming an account books with it, whatever the rules say.
    const named = await f.confirmed(f.a, kurta, { city: 'Karachi' });
    const withMain = unwrap(
      await f.bookings.request(f.a, { orderIds: [named.orderId], accountId: main.id }),
    );
    expect(withMain.bookings[0]!.accountId).toBe(main.id);
  });

  it('books with the cheapest account by rate cards where a rule names none (ADR-385)', async () => {
    const main = unwrap(await testAccount('Main'));
    const karachi = unwrap(await testAccount('Karachi'));
    const card = {
      localEach: '50',
      otherFirst: '300',
      otherEach: '100',
    };
    unwrap(
      await f.rateCards.set(f.a, main.id, { ...card, originCity: 'Lahore', localFirst: '150' }),
    );
    unwrap(
      await f.rateCards.set(f.a, karachi.id, { ...card, originCity: 'Karachi', localFirst: '120' }),
    );
    const kept = unwrap(await rules.replace(f.a, [{ accountId: null }]));
    expect(kept).toEqual([expect.objectContaining({ accountId: null, accountArchived: false })]);
    expect(await rules.list(f.a)).toEqual(kept);

    const toKarachi = await f.confirmed(f.a, kurta, { city: 'Karachi' });
    const toLahore = await f.confirmed(f.a, kurta);
    expect(await f.bookings.accountsFor(f.a, [toKarachi.orderId, toLahore.orderId])).toEqual([
      {
        orderId: toKarachi.orderId,
        accountId: karachi.id,
        ruleId: kept[0]!.id,
        estimate: 12_000n,
      },
      { orderId: toLahore.orderId, accountId: main.id, ruleId: kept[0]!.id, estimate: 15_000n },
    ]);
    const asked = unwrap(
      await f.bookings.request(f.a, { orderIds: [toKarachi.orderId, toLahore.orderId] }),
    );
    expect(
      Object.fromEntries(asked.bookings.map((booking) => [booking.orderId, booking.accountId])),
    ).toEqual({ [toKarachi.orderId]: karachi.id, [toLahore.orderId]: main.id });

    // An archived account is chosen no more; without cards the rule is passed over.
    unwrap(await f.accounts.archive(f.a, karachi.id));
    const again = await f.confirmed(f.a, kurta, { city: 'Karachi' });
    expect((await f.bookings.accountsFor(f.a, [again.orderId]))[0]).toMatchObject({
      accountId: main.id,
      ruleId: kept[0]!.id,
      estimate: 30_000n,
    });
    unwrap(await f.rateCards.remove(f.a, main.id));
    expect((await f.bookings.accountsFor(f.a, [again.orderId]))[0]).toEqual({
      orderId: again.orderId,
      accountId: main.id,
      ruleId: null,
      estimate: null,
    });
  });

  it('refuses an order no rule is for once the shop has no default account', async () => {
    const karachi = unwrap(await testAccount('Karachi'));
    unwrap(await rules.replace(f.a, [{ accountId: karachi.id, cities: ['Karachi'] }]));
    await f.admin.query('UPDATE logistics.courier_accounts SET is_default = false');
    const toKarachi = await f.confirmed(f.a, kurta, { city: 'Karachi' });
    const toLahore = await f.confirmed(f.a, kurta);
    const asked = unwrap(
      await f.bookings.request(f.a, { orderIds: [toKarachi.orderId, toLahore.orderId] }),
    );
    expect(asked.bookings.map((booking) => booking.orderId)).toEqual([toKarachi.orderId]);
    expect(asked.refused).toEqual([
      {
        orderId: toLahore.orderId,
        message: 'No courier rule is for this order, and the shop has no default courier account',
      },
    ]);
  });
});
