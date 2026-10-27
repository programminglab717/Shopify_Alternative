import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  StitchingEvents,
  StitchingService,
  isMeasurement,
  stitchingIn,
  stitchingPrice,
  stitchingProblem,
  type StitchingOffer,
} from './stitching.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

const OFFER: StitchingOffer = { price: 1_500_00, leadDays: 7, measurements: ['chest', 'waist'] };

describe('Stitching a line (CAT-09, ADR-802)', () => {
  it('adds its price and asks for each measurement in inches only where the line is stitched', () => {
    const stitched = { Stitching: 'Stitched', 'Chest (inches)': '38', 'Waist (inches)': '32.5' };
    expect(stitchingPrice(OFFER, stitched)).toBe(1_500_00n);
    expect(stitchingPrice(OFFER, { Stitching: 'Unstitched' })).toBe(0n);
    expect(stitchingPrice(undefined, stitched)).toBe(0n);
    expect(stitchingProblem(OFFER, stitched)).toBeNull();
    expect(stitchingProblem(OFFER, {})).toBeNull();
    expect(stitchingProblem(OFFER, { Stitching: 'Stitched', 'Chest (inches)': '38' })).toEqual({
      problem: 'missing',
      field: 'Waist (inches)',
    });
    expect(stitchingProblem(OFFER, { ...stitched, 'Chest (inches)': 'large' })).toEqual({
      problem: 'not_a_measurement',
      field: 'Chest (inches)',
    });
    expect(stitchingProblem(undefined, stitched)).toEqual({
      problem: 'not_offered',
      field: 'Stitching',
    });
    expect(['38', '38.5', '38.25', ' 9 '].every(isMeasurement)).toBe(true);
    expect(['0', '100', '38.3', '-2', '38in', ''].some(isMeasurement)).toBe(false);
  });
});

describe.skipIf(!server)('Stitching offered with a product (CAT-09, ADR-802)', () => {
  let f: CatalogFixture;
  let stitching: StitchingService;

  const product = async (title: string, tenant = f.a) =>
    unwrap(await f.products.create(tenant, { title, status: 'active' })).id;
  const events = async () =>
    (await f.outbox()).filter((event) => event.event_type === StitchingEvents.Updated);

  beforeAll(async () => {
    f = await catalogFixture(server!);
    stitching = new StitchingService(f.db);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(() => f.reset());

  it('offers it with its price, days and measurements in tailors’ order, changes it and takes it away', async () => {
    const lawn = await product('Unstitched lawn 3-piece');
    const offered = unwrap(
      await stitching.set(f.a, lawn, {
        price: '1,500',
        leadDays: 7,
        measurements: ['waist', 'chest', 'shirt_length'],
      }),
    );
    expect(offered).toEqual({
      price: 1_500_00,
      leadDays: 7,
      measurements: ['shirt_length', 'chest', 'waist'],
    });
    expect(await f.db.tenant(f.a.shopId, (tx) => stitchingIn(tx, f.a.shopId, [lawn]))).toEqual(
      new Map([[lawn, offered]]),
    );
    // The same again changes nothing.
    unwrap(
      await stitching.set(f.a, lawn, {
        price: '1500',
        leadDays: 7,
        measurements: ['shirt_length', 'chest', 'waist'],
      }),
    );
    expect(await events()).toHaveLength(1);
    unwrap(
      await stitching.set(f.a, lawn, { price: '1200', leadDays: 10, measurements: ['chest'] }),
    );
    expect((await stitching.of(f.a, [lawn])).get(lawn)).toEqual({
      price: 1_200_00,
      leadDays: 10,
      measurements: ['chest'],
    });
    expect(unwrap(await stitching.set(f.a, lawn, null))).toBeNull();
    expect((await stitching.of(f.a, [lawn])).has(lawn)).toBe(false);
    expect(await events()).toHaveLength(3);
  });

  it('refuses no price, days out of range, measurements unknown or twice or none, and another shop’s product', async () => {
    const lawn = await product('Lawn');
    expect(
      errorsOf(
        await stitching.set(f.a, lawn, {
          price: '',
          leadDays: 61,
          measurements: ['chest', 'chest', 'bust_size'],
        }),
      ),
    ).toEqual([
      ['input.price', 'BLANK'],
      ['input.leadDays', 'INVALID'],
      ['input.measurements.1', 'TAKEN'],
      ['input.measurements.2', 'INVALID'],
    ]);
    expect(
      errorsOf(await stitching.set(f.a, lawn, { price: '1500', leadDays: 7, measurements: [] })),
    ).toEqual([['input.measurements', 'BLANK']]);
    const theirs = await product('Theirs', f.b);
    expect(
      errorsOf(
        await stitching.set(f.a, theirs, { price: '1500', leadDays: 7, measurements: ['chest'] }),
      ),
    ).toEqual([['productId', 'NOT_FOUND']]);
  });
});
