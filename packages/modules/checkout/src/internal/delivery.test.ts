import 'reflect-metadata';
import { InputChecker } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  NO_DELIVERY_SETTINGS,
  checkDeliverySettings,
  deliveryCharge,
  highestDeliveryCharge,
  valueRateCharge,
  weightCharge,
  deliveryCountsFrom,
  deliveryDays,
  deliveryDaysRange,
  expectedDeliveryOn,
  offeredSlot,
  offeredSlots,
  slotsWithRoom,
  type DeliverySettingsInput,
  type DeliverySettingsRecord,
} from './delivery.js';
import { deliverySettings } from './schema.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';

const SETTINGS: DeliverySettingsRecord = {
  charge: 250_00n,
  freeAbove: 5_000_00n,
  days: { min: 2, max: 5 },
  zones: [
    { name: 'Karachi', cities: ['Karachi'], charge: 150_00n, days: { min: 1, max: 2 } },
    { name: 'Twin cities', cities: ['Islamabad', 'Rawalpindi'], charge: 200_00n, days: null },
  ],
  updatedAt: null,
};

/** What `input` makes of `current`, or the errors' [field, message]. */
function checked(input: DeliverySettingsInput, current = NO_DELIVERY_SETTINGS) {
  const check = new InputChecker();
  const settings = checkDeliverySettings(check, current, input, 'PKR');
  return settings ?? check.errors.map((error) => [error.field.join('.'), error.message]);
}

describe('Delivery charges', () => {
  it("charges the city's zone, else everywhere's, and nothing from the free subtotal", () => {
    expect(deliveryCharge(SETTINGS, 'Karachi', 1_000_00n)).toBe(150_00n);
    // Cities as addresses write them.
    expect(deliveryCharge(SETTINGS, 'Pindi', 1_000_00n)).toBe(200_00n);
    expect(deliveryCharge(SETTINGS, 'Multan', 1_000_00n)).toBe(250_00n);
    expect(deliveryCharge(SETTINGS, 'Chak 45 SB', 1_000_00n)).toBe(250_00n);
    expect(deliveryCharge(SETTINGS, null, 1_000_00n)).toBe(250_00n);
    expect(deliveryCharge(SETTINGS, 'Karachi', 5_000_00n)).toBe(0n);
    expect(deliveryCharge(NO_DELIVERY_SETTINGS, 'Lahore', 1n)).toBe(0n);
  });

  it('charges heavier orders more, the heaviest weight they pass alone (ADR-702)', () => {
    const heavy: DeliverySettingsRecord = {
      ...SETTINGS,
      weights: [
        { aboveGrams: 2_000, charge: 100_00n },
        { aboveGrams: 5_000, charge: 300_00n },
      ],
    };
    expect([0, 2_000, 2_001, 5_000, 5_001, 90_000].map((g) => weightCharge(heavy, g))).toEqual([
      0n,
      0n,
      100_00n,
      100_00n,
      300_00n,
      300_00n,
    ]);
    // Added to the city's charge, and nothing from the free subtotal, whatever it weighs.
    expect(deliveryCharge(heavy, 'Karachi', 1_000_00n, 3_000)).toBe(250_00n);
    expect(deliveryCharge(heavy, 'Multan', 1_000_00n, 6_000)).toBe(550_00n);
    expect(deliveryCharge(heavy, 'Multan', 1_000_00n)).toBe(250_00n);
    expect(deliveryCharge(heavy, 'Karachi', 5_000_00n, 6_000)).toBe(0n);
    expect(highestDeliveryCharge(heavy, 1_000_00n, 6_000)).toBe(550_00n);
    expect(highestDeliveryCharge(heavy, 5_000_00n, 6_000)).toBe(0n);
    // Settings from before weights charge none.
    expect(weightCharge(SETTINGS, 90_000)).toBe(0n);
  });

  it("caps larger orders' charge at the rate of the largest value they reach (ADR-721)", () => {
    const rated: DeliverySettingsRecord = {
      ...SETTINGS,
      valueRates: [
        { fromSubtotal: 2_000_00n, charge: 180_00n },
        { fromSubtotal: 3_000_00n, charge: 100_00n },
      ],
      weights: [{ aboveGrams: 2_000, charge: 50_00n }],
    };
    expect(
      [1_999_99n, 2_000_00n, 2_999_99n, 3_000_00n].map((s) => valueRateCharge(rated, s)),
    ).toEqual([null, 180_00n, 180_00n, 100_00n]);
    // Below a rate, the city's charge; from it, the rate where it is less, the zone's where not.
    expect(deliveryCharge(rated, 'Multan', 1_000_00n)).toBe(250_00n);
    expect(deliveryCharge(rated, 'Multan', 2_000_00n)).toBe(180_00n);
    expect(deliveryCharge(rated, 'Karachi', 2_000_00n)).toBe(150_00n);
    expect(deliveryCharge(rated, 'Karachi', 3_000_00n)).toBe(100_00n);
    // Its weight adds after; nothing from the free subtotal.
    expect(deliveryCharge(rated, 'Multan', 3_000_00n, 3_000)).toBe(150_00n);
    expect(deliveryCharge(rated, 'Multan', 5_000_00n, 3_000)).toBe(0n);
    expect(highestDeliveryCharge(rated, 1_000_00n)).toBe(250_00n);
    expect(highestDeliveryCharge(rated, 2_500_00n, 3_000)).toBe(230_00n);
    // A rate of nothing: free but for the weight.
    const free = { ...rated, valueRates: [{ fromSubtotal: 2_000_00n, charge: 0n }] };
    expect(deliveryCharge(free, 'Multan', 2_000_00n, 3_000)).toBe(50_00n);
    // Settings from before rates cap nothing.
    expect(valueRateCharge(SETTINGS, 9_000_00n)).toBeNull();
  });

  it('takes rates by value in rupees, kept the smallest first, each value once (ADR-721)', () => {
    expect(
      checked({
        valueRates: [
          { fromSubtotal: '3,000', charge: '100' },
          { fromSubtotal: '2000', charge: '0' },
        ],
      }),
    ).toMatchObject({
      valueRates: [
        { fromSubtotal: 2_000_00n, charge: 0n },
        { fromSubtotal: 3_000_00n, charge: 100_00n },
      ],
    });
    const rated = { ...SETTINGS, valueRates: [{ fromSubtotal: 2_000_00n, charge: 100_00n }] };
    expect(checked({ charge: '200' }, rated)).toMatchObject({ valueRates: rated.valueRates });
    expect(checked({ valueRates: null }, rated)).toMatchObject({ valueRates: [] });
    expect(
      checked({
        valueRates: [
          { fromSubtotal: '0', charge: '100' },
          { fromSubtotal: '2000', charge: '' },
          { fromSubtotal: '2,000', charge: '50' },
          { fromSubtotal: 'lots', charge: '-5' },
        ],
      }),
    ).toEqual([
      ['valueRates.0.fromSubtotal', 'A rate must start above Rs 0'],
      ['valueRates.1.charge', "Charge can't be blank"],
      ['valueRates.2.fromSubtotal', 'This value has a rate already'],
      [
        'valueRates.3.fromSubtotal',
        'From subtotal must be an amount of zero or more, like 2499 or 2499.50',
      ],
      ['valueRates.3.charge', 'Charge must be an amount of zero or more, like 2499 or 2499.50'],
    ]);
    const many = Array.from({ length: 11 }, (_, i) => ({ fromSubtotal: `${i + 1}`, charge: '10' }));
    expect(checked({ valueRates: many })).toEqual([
      ['valueRates', "A shop sets at most 10 rates by the order's value"],
    ]);
  });

  it('takes weights in grams with charges in rupees, kept the lightest first (ADR-702)', () => {
    expect(
      checked({
        weights: [
          { aboveGrams: 5_000, charge: '300' },
          { aboveGrams: 2_000, charge: '100' },
        ],
      }),
    ).toMatchObject({
      weights: [
        { aboveGrams: 2_000, charge: 100_00n },
        { aboveGrams: 5_000, charge: 300_00n },
      ],
    });
    // Kept when left out; none with an empty list or null.
    const heavy = { ...SETTINGS, weights: [{ aboveGrams: 2_000, charge: 100_00n }] };
    expect(checked({ charge: '200' }, heavy)).toMatchObject({ weights: heavy.weights });
    expect(checked({ weights: [] }, heavy)).toMatchObject({ weights: [] });
    expect(checked({ weights: null }, heavy)).toMatchObject({ weights: [] });
    expect(
      checked({
        weights: [
          { aboveGrams: 0, charge: '100' },
          { aboveGrams: 1.5, charge: '100' },
          { aboveGrams: 2_000, charge: '0' },
          { aboveGrams: 2_000, charge: '' },
          { aboveGrams: 1_000_001, charge: '100' },
        ],
      }),
    ).toEqual([
      ['weights.0.aboveGrams', 'A weight is whole grams from 1 to 1000000'],
      ['weights.1.aboveGrams', 'A weight is whole grams from 1 to 1000000'],
      ['weights.2.charge', 'A heavier order must cost more than Rs 0'],
      ['weights.3.aboveGrams', 'This weight has a charge already'],
      ['weights.3.charge', "Charge can't be blank"],
      ['weights.4.aboveGrams', 'A weight is whole grams from 1 to 1000000'],
    ]);
    const many = Array.from({ length: 11 }, (_, i) => ({ aboveGrams: i + 1, charge: '10' }));
    expect(checked({ weights: many })).toEqual([
      ['weights', 'A shop charges for at most 10 weights'],
    ]);
  });

  it("says how many working days delivery takes: the city's zone's, else everywhere's (ADR-235)", () => {
    expect(deliveryDays(SETTINGS, 'Karachi')).toEqual({ min: 1, max: 2 });
    // A zone of its own days takes everywhere's, as a city no zone names does.
    expect(deliveryDays(SETTINGS, 'Pindi')).toEqual({ min: 2, max: 5 });
    expect(deliveryDays(SETTINGS, 'Multan')).toEqual({ min: 2, max: 5 });
    expect(deliveryDays(SETTINGS, 'Chak 45 SB')).toEqual({ min: 2, max: 5 });
    // Without a city, wherever it goes: the fewest days to the most.
    expect(deliveryDays(SETTINGS, null)).toEqual({ min: 1, max: 5 });
    expect(deliveryDaysRange(SETTINGS)).toEqual({ min: 1, max: 5 });
    expect(deliveryDays(NO_DELIVERY_SETTINGS, 'Lahore')).toBeNull();
    // Days for a zone alone say nothing of the cities it doesn't name.
    const zoneAlone = { ...SETTINGS, days: null };
    expect(deliveryDays(zoneAlone, 'Karachi')).toEqual({ min: 1, max: 2 });
    expect(deliveryDays(zoneAlone, 'Multan')).toBeNull();
    expect(deliveryDays(zoneAlone, null)).toBeNull();
  });

  it('takes charges in rupees and cities as addresses name them, each in one zone', () => {
    expect(
      checked({
        charge: '250',
        freeAbove: '5,000',
        days: { min: 2, max: 4 },
        zones: [
          {
            name: 'Twin cities',
            cities: ['isb', 'Pindi'],
            charge: '200',
            days: { min: 0, max: 1 },
          },
        ],
      }),
    ).toEqual({
      charge: 250_00n,
      freeAbove: 5_000_00n,
      days: { min: 2, max: 4 },
      zones: [
        {
          name: 'Twin cities',
          cities: ['Islamabad', 'Rawalpindi'],
          charge: 200_00n,
          days: { min: 0, max: 1 },
        },
      ],
      cutoffHour: null,
      weights: [],
      valueRates: [],
      slots: [],
      slotDays: 7,
      slotLeadHours: 2,
      slotCapacity: null,
    });
    // What is left out stays; null for nothing, or no free delivery, or no days said.
    expect(checked({ freeAbove: null }, SETTINGS)).toEqual({
      charge: 250_00n,
      freeAbove: null,
      days: { min: 2, max: 5 },
      zones: SETTINGS.zones,
      cutoffHour: null,
      weights: [],
      valueRates: [],
      slots: [],
      slotDays: 7,
      slotLeadHours: 2,
      slotCapacity: null,
    });
    expect(checked({ days: null }, SETTINGS)).toMatchObject({ days: null, zones: SETTINGS.zones });
    expect(
      checked({
        days: { min: 5, max: 2 },
        zones: [{ name: 'Lahore', cities: ['lhr'], charge: '100', days: { min: -1, max: 31 } }],
      }),
    ).toEqual([
      ['days.max', 'The most days delivery takes must be no fewer than the fewest'],
      ['zones.0.days.min', 'Delivery takes 0 to 30 working days'],
      ['zones.0.days.max', 'Delivery takes 0 to 30 working days'],
    ]);
    expect(checked({ charge: null, zones: [] }, SETTINGS)).toMatchObject({ charge: 0n, zones: [] });
    expect(
      checked({
        charge: '-5',
        freeAbove: '0',
        zones: [
          { name: 'South', cities: ['Karachi', 'Atlantis'], charge: '150' },
          { name: ' ', cities: ['khi'], charge: '' },
          { name: 'Empty', cities: [], charge: '100' },
        ],
      }),
    ).toEqual([
      ['charge', 'Charge must be an amount of zero or more, like 2499 or 2499.50'],
      ['freeAbove', 'Free delivery must start above Rs 0'],
      ['zones.0.cities.1', '"Atlantis" is not a city of Pakistan we know'],
      ['zones.1.name', "Name can't be blank"],
      ['zones.1.charge', "Charge can't be blank"],
      ['zones.1.cities.0', 'Karachi is in the zone "South"'],
      ['zones.2.cities', 'A zone has 1 to 200 cities'],
    ]);
  });
});

const server = testDatabaseServer();

describe.skipIf(!server)('DeliveryService', () => {
  let f: CheckoutFixture;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  it('matches the migrated table', async () => {
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(deliverySettings).limit(1));
  });

  it("keeps a shop's charges, recording each change for the storefront", async () => {
    expect(await f.delivery.get(f.a)).toEqual(NO_DELIVERY_SETTINGS);
    const saved = unwrap(
      await f.delivery.update(f.a, {
        charge: '250',
        freeAbove: '5,000',
        zones: [{ name: 'Karachi', cities: ['khi'], charge: '150' }],
      }),
    );
    expect(saved).toMatchObject({
      charge: 250_00n,
      freeAbove: 5_000_00n,
      zones: [{ name: 'Karachi', cities: ['Karachi'], charge: 150_00n }],
    });
    expect(saved.updatedAt).toBeInstanceOf(Date);
    // The same again changes nothing; then a new charge alone.
    unwrap(await f.delivery.update(f.a, { charge: '250.00' }));
    unwrap(await f.delivery.update(f.a, { charge: '300' }));
    expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      ['delivery_settings.updated', { changed: ['charge', 'freeAbove', 'zones'] }],
      ['delivery_settings.updated', { changed: ['charge'] }],
    ]);
    expect(await f.delivery.get(f.a)).toMatchObject({ charge: 300_00n, freeAbove: 5_000_00n });
    // Refused whole, with what is wrong.
    const refused = await f.delivery.update(f.a, { charge: '100', freeAbove: 'free' });
    expect(refused.ok).toBe(false);
    expect((await f.delivery.get(f.a)).charge).toBe(300_00n);
    // Each shop's are its own.
    expect(await f.delivery.get(f.b)).toEqual(NO_DELIVERY_SETTINGS);
    const read = await f.db.tenant(f.a.shopId, (tx) => f.delivery.settingsOf(tx, f.a.shopId));
    expect(read.zones).toEqual([
      { name: 'Karachi', cities: ['Karachi'], charge: 150_00n, days: null },
    ]);
  });

  it('keeps how many working days delivery takes, everywhere and in a zone (ADR-235)', async () => {
    unwrap(
      await f.delivery.update(f.a, {
        charge: '250',
        zones: [{ name: 'Karachi', cities: ['khi'], charge: '150' }],
      }),
    );
    expect(await f.delivery.get(f.a)).toMatchObject({ days: null });
    const saved = unwrap(
      await f.delivery.update(f.a, {
        days: { min: 2, max: 4 },
        zones: [{ name: 'Karachi', cities: ['khi'], charge: '150', days: { min: 1, max: 1 } }],
      }),
    );
    expect(saved).toMatchObject({
      days: { min: 2, max: 4 },
      zones: [{ name: 'Karachi', days: { min: 1, max: 1 } }],
    });
    expect(await f.delivery.get(f.a)).toEqual(saved);
    // Unsaid again; the same again changes nothing.
    unwrap(await f.delivery.update(f.a, { days: null }));
    unwrap(await f.delivery.update(f.a, { days: null }));
    expect((await f.delivery.get(f.a)).days).toBeNull();
    expect(
      (await f.outbox()).map((event) => (event.payload as { changed: string[] }).changed),
    ).toEqual([['charge', 'zones'], ['days', 'zones'], ['days']]);
    const refused = await f.delivery.update(f.a, { days: { min: 3, max: 1 } });
    expect(refused.ok).toBe(false);
    await expect(
      f.admin.query(
        `UPDATE checkout.delivery_settings SET min_days = 4, max_days = 2 WHERE shop_id = $1`,
        [f.a.shopId],
      ),
    ).rejects.toThrow(/delivery_settings_days_check/);
  });

  it('keeps what heavier orders cost more, recording a change of them (ADR-702)', async () => {
    expect((await f.delivery.get(f.a)).weights).toEqual([]);
    const saved = unwrap(
      await f.delivery.update(f.a, {
        weights: [
          { aboveGrams: 5_000, charge: '300' },
          { aboveGrams: 2_000, charge: '100' },
        ],
      }),
    );
    const weights = [
      { aboveGrams: 2_000, charge: 100_00n },
      { aboveGrams: 5_000, charge: 300_00n },
    ];
    expect(saved.weights).toEqual(weights);
    expect((await f.delivery.get(f.a)).weights).toEqual(weights);
    // The same again changes nothing; kept when the rest changes; none with an empty list.
    unwrap(await f.delivery.update(f.a, { weights: [...saved.weights!].reverse().map(input) }));
    unwrap(await f.delivery.update(f.a, { charge: '250' }));
    expect((await f.delivery.get(f.a)).weights).toEqual(weights);
    unwrap(await f.delivery.update(f.a, { weights: [] }));
    expect((await f.delivery.get(f.a)).weights).toEqual([]);
    expect(
      (await f.outbox()).map((event) => (event.payload as { changed: string[] }).changed),
    ).toEqual([['weights'], ['charge'], ['weights']]);
    expect(await f.delivery.get(f.b)).toEqual(NO_DELIVERY_SETTINGS);
  });

  it('keeps what larger orders pay at most, recording a change of them (ADR-721)', async () => {
    expect((await f.delivery.get(f.a)).valueRates).toEqual([]);
    const rates = [
      { fromSubtotal: 2_000_00n, charge: 150_00n },
      { fromSubtotal: 4_000_00n, charge: 0n },
    ];
    const saved = unwrap(
      await f.delivery.update(f.a, {
        valueRates: [
          { fromSubtotal: '4000', charge: '0' },
          { fromSubtotal: '2000', charge: '150' },
        ],
      }),
    );
    expect(saved.valueRates).toEqual(rates);
    expect((await f.delivery.get(f.a)).valueRates).toEqual(rates);
    // The same again changes nothing; none with an empty list.
    unwrap(
      await f.delivery.update(f.a, {
        valueRates: [
          { fromSubtotal: '2,000', charge: '150' },
          { fromSubtotal: '4,000', charge: '0' },
        ],
      }),
    );
    unwrap(await f.delivery.update(f.a, { valueRates: [] }));
    expect((await f.delivery.get(f.a)).valueRates).toEqual([]);
    expect(
      (await f.outbox()).map((event) => (event.payload as { changed: string[] }).changed),
    ).toEqual([['valueRates'], ['valueRates']]);
  });

  it("keeps the shop's cut-off hour, from which orders count from the next day (ADR-597)", async () => {
    expect((await f.delivery.get(f.a)).cutoffHour).toBeNull();
    const saved = unwrap(await f.delivery.update(f.a, { cutoffHour: 15 }));
    expect(saved.cutoffHour).toBe(15);
    expect((await f.delivery.get(f.a)).cutoffHour).toBe(15);
    // Kept when the rest changes; taken off with null.
    unwrap(await f.delivery.update(f.a, { charge: '250' }));
    expect((await f.delivery.get(f.a)).cutoffHour).toBe(15);
    unwrap(await f.delivery.update(f.a, { cutoffHour: null }));
    expect((await f.delivery.get(f.a)).cutoffHour).toBeNull();
    expect(
      (await f.outbox()).map((event) => (event.payload as { changed: string[] }).changed),
    ).toEqual([['cutoffHour'], ['charge'], ['cutoffHour']]);
    for (const hour of [0, 24, 1.5]) {
      const refused = await f.delivery.update(f.a, { cutoffHour: hour });
      expect(refused.ok ? [] : refused.errors.map((error) => error.field.join('.'))).toEqual([
        'cutoffHour',
      ]);
    }
    await expect(
      f.admin.query(`UPDATE checkout.delivery_settings SET cutoff_hour = 0 WHERE shop_id = $1`, [
        f.a.shopId,
      ]),
    ).rejects.toThrow(/cutoff_hour/);
  });

  it('keeps the times of the day the shop delivers in, recording a change of them (ADR-768)', async () => {
    expect(await f.delivery.get(f.a)).toMatchObject({
      slots: [],
      slotDays: 7,
      slotLeadHours: 2,
      slotCapacity: null,
    });
    const slots = [
      { from: '10:00', until: '13:00' },
      { from: '16:00', until: '19:00' },
    ];
    const saved = unwrap(
      await f.delivery.update(f.a, { slots: [...slots].reverse(), slotDays: 3 }),
    );
    expect(saved).toMatchObject({ slots, slotDays: 3, slotLeadHours: 2 });
    expect(await f.delivery.get(f.a)).toEqual(saved);
    // The same again changes nothing; kept when the rest changes; none with an empty list.
    unwrap(await f.delivery.update(f.a, { slots, slotDays: 3, slotLeadHours: 2 }));
    unwrap(await f.delivery.update(f.a, { slotLeadHours: 24 }));
    expect(await f.delivery.get(f.a)).toMatchObject({ slots, slotDays: 3, slotLeadHours: 24 });
    unwrap(await f.delivery.update(f.a, { slots: [] }));
    expect((await f.delivery.get(f.a)).slots).toEqual([]);
    // How many orders a slot takes (ADR-772).
    unwrap(await f.delivery.update(f.a, { slotCapacity: 4 }));
    expect((await f.delivery.get(f.a)).slotCapacity).toBe(4);
    expect(
      (await f.outbox()).map((event) => (event.payload as { changed: string[] }).changed),
    ).toEqual([['slots', 'slotDays'], ['slotLeadHours'], ['slots'], ['slotCapacity']]);
    await expect(
      f.admin.query(`UPDATE checkout.delivery_settings SET slot_days = 0 WHERE shop_id = $1`, [
        f.a.shopId,
      ]),
    ).rejects.toThrow(/slot_days/);
    expect(await f.delivery.get(f.b)).toEqual(NO_DELIVERY_SETTINGS);
  });
});

describe('Delivery time slots (CHK-15, ADR-768)', () => {
  const SLOTS: DeliverySettingsRecord = {
    ...NO_DELIVERY_SETTINGS,
    slots: [
      { from: '10:00', until: '13:00' },
      { from: '16:00', until: '19:00' },
    ],
    slotDays: 2,
    slotLeadHours: 3,
  };

  it('takes times of the day as HH:MM, kept the earliest first, none overlapping', () => {
    expect(
      checked({
        slots: [
          { from: '16:00', until: '19:00' },
          { from: ' 09:30', until: '12:00 ' },
        ],
        slotDays: 3,
        slotLeadHours: 0,
      }),
    ).toMatchObject({
      slots: [
        { from: '09:30', until: '12:00' },
        { from: '16:00', until: '19:00' },
      ],
      slotDays: 3,
      slotLeadHours: 0,
    });
    // Left out, they stay as they are.
    expect(checked({ charge: '100' }, SLOTS)).toMatchObject({
      slots: SLOTS.slots,
      slotDays: 2,
      slotLeadHours: 3,
    });
    expect(
      checked({
        slots: [
          { from: '9:00', until: '12:00' },
          { from: '13:00', until: '12:00' },
          { from: '14:00', until: '24:00' },
          { from: '10:00', until: '11:00' },
          { from: '10:30', until: '12:00' },
        ],
        slotDays: 15,
        slotLeadHours: -1,
      }),
    ).toEqual([
      ['slots.0.from', 'A time is HH:MM, from 00:00 to 23:59'],
      ['slots.1.until', 'A slot must end after it starts'],
      ['slots.2.until', 'A time is HH:MM, from 00:00 to 23:59'],
      ['slots.4.from', 'This slot overlaps 10:00 to 11:00'],
      ['slotDays', 'Slots are offered 1 to 14 days ahead'],
      ['slotLeadHours', 'A slot starts 0 to 72 hours ahead'],
    ]);
    expect(
      checked({ slots: Array.from({ length: 9 }, () => ({ from: '10:00', until: '11:00' })) }),
    ).toEqual([['slots', 'A shop offers at most 8 delivery slots']]);
  });

  it('offers each slot on the slot days from today in Pakistan, from the lead hours ahead', () => {
    // 9 am in Karachi, Friday 23 October 2026: 10 am is too soon, with 3 hours to prepare.
    const offered = offeredSlots(SLOTS, new Date('2026-10-23T04:00:00Z'));
    expect(offered.map((slot) => slot.key)).toEqual([
      '2026-10-23T16:00-19:00',
      '2026-10-24T10:00-13:00',
      '2026-10-24T16:00-19:00',
    ]);
    expect(offered[0]).toEqual({
      key: '2026-10-23T16:00-19:00',
      day: '2026-10-23',
      startsAt: new Date('2026-10-23T11:00:00Z'),
      endsAt: new Date('2026-10-23T14:00:00Z'),
    });
    // At 7 am exactly, 10 am is just far enough ahead; just after 7 pm in Karachi is still today.
    expect(offeredSlots(SLOTS, new Date('2026-10-23T02:00:00Z'))[0]?.key).toBe(
      '2026-10-23T10:00-13:00',
    );
    expect(offeredSlots(SLOTS, new Date('2026-10-23T14:01:00Z')).map((slot) => slot.key)).toEqual([
      '2026-10-24T10:00-13:00',
      '2026-10-24T16:00-19:00',
    ]);
    // One chosen is offered still, or not.
    const now = new Date('2026-10-23T04:00:00Z');
    expect(offeredSlot(SLOTS, '2026-10-24T10:00-13:00', now)?.day).toBe('2026-10-24');
    expect(offeredSlot(SLOTS, '2026-10-23T10:00-13:00', now)).toBeNull();
    expect(offeredSlot(SLOTS, '2026-10-25T10:00-13:00', now)).toBeNull();
    expect(offeredSlots(NO_DELIVERY_SETTINGS, now)).toEqual([]);
  });
});

describe('How many orders a delivery slot takes (CHK-15, ADR-772)', () => {
  it('takes a limit from 1 to 1,000, or none, and offers only slots with room', () => {
    expect(checked({ slotCapacity: 5 })).toMatchObject({ slotCapacity: 5 });
    expect(checked({ charge: '100' }, { ...NO_DELIVERY_SETTINGS, slotCapacity: 5 })).toMatchObject({
      slotCapacity: 5,
    });
    expect(
      checked({ slotCapacity: null }, { ...NO_DELIVERY_SETTINGS, slotCapacity: 5 }),
    ).toMatchObject({ slotCapacity: null });
    for (const slotCapacity of [0, 1001, 2.5]) {
      expect(checked({ slotCapacity })).toEqual([
        ['slotCapacity', 'A slot takes 1 to 1000 orders, or no limit'],
      ]);
    }
    const settings: DeliverySettingsRecord = {
      ...NO_DELIVERY_SETTINGS,
      slots: [
        { from: '10:00', until: '13:00' },
        { from: '16:00', until: '19:00' },
      ],
      slotDays: 1,
      slotLeadHours: 0,
      slotCapacity: 2,
    };
    // 9 am in Karachi: both of today's slots are offered.
    const offered = offeredSlots(settings, new Date('2026-10-23T04:00:00Z'));
    const [morning, evening] = offered;
    const taken = new Map([
      [morning!.startsAt.getTime(), 2],
      [evening!.startsAt.getTime(), 1],
    ]);
    expect(slotsWithRoom(settings, offered, taken)).toEqual([evening]);
    // Without a limit, however many it has.
    expect(slotsWithRoom({ ...settings, slotCapacity: null }, offered, taken)).toEqual(offered);
  });
});

describe('Where delivery days count from (ADR-597)', () => {
  it("counts from today in Pakistan, or tomorrow once the shop's cut-off has come", () => {
    const cutoff = { ...SETTINGS, cutoffHour: 15 };
    // 2:59 pm and 3 pm in Karachi, Tuesday 20 October 2026.
    expect(deliveryCountsFrom(cutoff, new Date('2026-10-20T09:59:00Z'))).toBe('2026-10-20');
    expect(deliveryCountsFrom(cutoff, new Date('2026-10-20T10:00:00Z'))).toBe('2026-10-21');
    // Without one, the day it is; just after midnight in Karachi is the next day.
    expect(deliveryCountsFrom(SETTINGS, new Date('2026-10-20T18:00:00Z'))).toBe('2026-10-20');
    expect(deliveryCountsFrom(SETTINGS, new Date('2026-10-20T19:30:00Z'))).toBe('2026-10-21');
    // Two working days to Karachi: Thursday before the cut-off, Friday after.
    const before = deliveryCountsFrom(cutoff, new Date('2026-10-20T09:00:00Z'));
    const after = deliveryCountsFrom(cutoff, new Date('2026-10-20T11:00:00Z'));
    expect(expectedDeliveryOn(cutoff, 'Karachi', before, [])).toBe('2026-10-22');
    expect(expectedDeliveryOn(cutoff, 'Karachi', after, [])).toBe('2026-10-23');
  });
});

/** A weight as the API takes it. */
function input(weight: { aboveGrams: number; charge: bigint }) {
  return { aboveGrams: weight.aboveGrams, charge: (Number(weight.charge) / 100).toString() };
}
