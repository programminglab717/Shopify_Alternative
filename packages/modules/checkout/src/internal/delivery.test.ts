import 'reflect-metadata';
import { InputChecker } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  NO_DELIVERY_SETTINGS,
  checkDeliverySettings,
  deliveryCharge,
  deliveryDays,
  deliveryDaysRange,
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
    });
    // What is left out stays; null for nothing, or no free delivery, or no days said.
    expect(checked({ freeAbove: null }, SETTINGS)).toEqual({
      charge: 250_00n,
      freeAbove: null,
      days: { min: 2, max: 5 },
      zones: SETTINGS.zones,
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
});
