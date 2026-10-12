import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chargeEstimate } from './rate-cards.service.js';
import { errorsOf, logisticsFixture, unwrap, type LogisticsFixture } from './test-support.js';

describe('What a parcel is likely to cost by a rate card (ADR-383)', () => {
  const card = {
    originCity: 'Lahore',
    localFirst: 15_000n,
    localEach: 5_000n,
    otherFirst: 25_000n,
    otherEach: 10_000n,
    codFeeBp: 250,
    returnBp: 5_000,
  };

  it('prices by the half kilo, within the city or beyond it', () => {
    expect(chargeEstimate(card, { city: 'lahore', codAmount: 0n, weightGrams: 400 })).toEqual({
      out: 15_000n,
      codFee: 0n,
      back: 7_500n,
    });
    // 1.2 kg is three half kilos: the first, and two after.
    expect(chargeEstimate(card, { city: 'Karachi', codAmount: 0n, weightGrams: 1_200 }).out).toBe(
      45_000n,
    );
    // No known weight counts one half kilo; nor does a city nobody knows count as within.
    expect(chargeEstimate(card, { city: 'Atlantis', codAmount: 0n, weightGrams: null }).out).toBe(
      25_000n,
    );
  });

  it('takes its share of the cash collected, and of the charge to bring it back', () => {
    const estimate = chargeEstimate(card, {
      city: 'Karachi',
      codAmount: 349_900n,
      weightGrams: 500,
    });
    // 2.5% of Rs 3,499 is Rs 87.475, to the nearest paisa.
    expect(estimate).toEqual({ out: 25_000n, codFee: 8_748n, back: 12_500n });
  });
});

const server = testDatabaseServer();

describe.skipIf(!server)("Courier accounts' rate cards (ADR-383)", () => {
  let f: LogisticsFixture;
  let kurta: string;

  beforeAll(async () => {
    f = await logisticsFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    kurta = await f.variantOf(f.a, 'Kurta', '2,000');
  });

  const testAccount = () =>
    f.accounts.connect(f.a, {
      courier: 'test',
      credentials: [{ key: 'key', value: 'anything-9876' }],
    });
  const CARD = {
    originCity: 'lahore',
    localFirst: '150',
    localEach: '50',
    otherFirst: '250',
    otherEach: '100',
    codFeePercent: '2',
    returnPercent: '50',
  };

  it('keeps a card whole for an account, refusing what cannot be one, and takes it away', async () => {
    const account = unwrap(await testAccount());
    expect(
      errorsOf(
        await f.rateCards.set(f.a, account.id, {
          ...CARD,
          originCity: 'Atlantis',
          localFirst: '',
          codFeePercent: '25',
          returnPercent: 'half',
        }),
      ),
    ).toEqual([
      ['input.originCity', 'INVALID'],
      ['input.localFirst', 'BLANK'],
      ['input.codFeePercent', 'INVALID'],
      ['input.returnPercent', 'INVALID'],
    ]);
    expect(errorsOf(await f.rateCards.set(f.a, newId(), CARD))).toEqual([
      ['accountId', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await f.rateCards.set(f.b, account.id, CARD))).toEqual([
      ['accountId', 'NOT_FOUND'],
    ]);

    const kept = unwrap(await f.rateCards.set(f.a, account.id, CARD));
    expect(kept).toMatchObject({
      accountId: account.id,
      originCity: 'Lahore',
      localFirst: 15_000n,
      localEach: 5_000n,
      otherFirst: 25_000n,
      otherEach: 10_000n,
      codFeeBp: 200,
      returnBp: 5_000,
    });
    unwrap(await f.rateCards.set(f.a, account.id, { ...CARD, otherFirst: '300' }));
    expect((await f.rateCards.list(f.a)).map((card) => card.otherFirst)).toEqual([30_000n]);
    expect(await f.rateCards.list(f.b)).toEqual([]);
    const events = (await f.outbox()).filter(
      (row) => row.event_type === 'courier_rate_card.updated',
    );
    expect(events.map((row) => row.payload)).toEqual([
      { accountId: account.id, removed: false },
      { accountId: account.id, removed: false },
    ]);

    expect(unwrap(await f.rateCards.remove(f.a, account.id))).toBe(true);
    expect(errorsOf(await f.rateCards.remove(f.a, account.id))).toEqual([
      ['accountId', 'NOT_FOUND'],
    ]);
    unwrap(await f.accounts.archive(f.a, account.id));
    expect(errorsOf(await f.rateCards.set(f.a, account.id, CARD))).toEqual([
      ['accountId', 'INVALID'],
    ]);
  });

  it("estimates each parcel booked by its account's card, and the parcel keeps it", async () => {
    const account = unwrap(await testAccount());
    // Without a card, a parcel booked has no estimate.
    const plain = await f.booked(f.a, kurta, { city: 'Karachi' });
    unwrap(await f.rateCards.set(f.a, account.id, CARD));
    const toKarachi = await f.confirmed(f.a, kurta, { city: 'Karachi' });
    expect(await f.bookings.accountsFor(f.a, [toKarachi.orderId])).toEqual([
      // Out to another city, Rs 250, and 2% of the Rs 2,000 to collect.
      { orderId: toKarachi.orderId, accountId: account.id, ruleId: null, estimate: 29_000n },
    ]);
    const shipped = await f.booked(f.a, kurta, { city: 'Lahore' });

    const estimates = await f.admin.query<{
      id: string;
      out: string | null;
      cod: string | null;
      back: string | null;
    }>(
      `SELECT f.id, f.charge_estimate_out AS out, f.charge_estimate_cod_fee AS cod,
              f.charge_estimate_back AS back
         FROM orders.fulfillments f WHERE f.id = ANY($1) ORDER BY f.created_at`,
      [[plain.fulfillmentId, shipped.fulfillmentId]],
    );
    expect(estimates.rows).toEqual([
      { id: plain.fulfillmentId, out: null, cod: null, back: null },
      // Within Lahore: Rs 150 out, 2% of Rs 2,000, and half again back.
      { id: shipped.fulfillmentId, out: '15000', cod: '4000', back: '7500' },
    ]);
    const booking = await f.admin.query(
      'SELECT estimate_out, estimate_cod_fee, estimate_back FROM logistics.bookings WHERE id = $1',
      [shipped.bookingId],
    );
    expect(booking.rows).toEqual([
      { estimate_out: '15000', estimate_cod_fee: '4000', estimate_back: '7500' },
    ]);
  });
});
