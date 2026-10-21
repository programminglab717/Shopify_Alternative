import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PersonalisationEvents,
  PersonalisationService,
  personalisationIn,
} from './personalisation.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('Personalisation fields (CAT-15, ADR-689)', () => {
  let f: CatalogFixture;
  let personalisation: PersonalisationService;

  const product = async (title: string, tenant = f.a) =>
    unwrap(await f.products.create(tenant, { title, status: 'active' })).id;
  const events = async () =>
    (await f.outbox()).filter((event) => event.event_type === PersonalisationEvents.Updated);

  beforeAll(async () => {
    f = await catalogFixture(server!);
    personalisation = new PersonalisationService(f.db);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(() => f.reset());

  it('keeps what a product asks for, in order, in place of what it asked, and none', async () => {
    const kurta = await product('Embroidered kurta');
    const plain = await product('Plain kurta');

    expect(
      unwrap(
        await personalisation.set(f.a, kurta, [
          { name: ' Name to embroider ', kind: 'text', required: true, maxLength: 12 },
          {
            name: 'Thread',
            kind: 'choice',
            choices: [' Gold', 'Silver', ' ', 'Maroon'],
            price: '250.50',
          },
          { name: 'Note for the tailor', kind: 'text', choices: ['ignored'], price: ' ' },
        ]),
      ),
    ).toEqual([
      {
        name: 'Name to embroider',
        kind: 'text',
        required: true,
        maxLength: 12,
        choices: [],
        price: 0,
      },
      {
        name: 'Thread',
        kind: 'choice',
        required: false,
        maxLength: null,
        choices: ['Gold', 'Silver', 'Maroon'],
        // What an answer adds to each unit's price, in minor units (ADR-697).
        price: 250_50,
      },
      // Text takes 50 characters unless the shop says otherwise.
      {
        name: 'Note for the tailor',
        kind: 'text',
        required: false,
        maxLength: 50,
        choices: [],
        price: 0,
      },
    ]);
    const kept = await personalisation.of(f.a, [kurta, plain]);
    expect(kept.get(kurta)?.map((field) => field.name)).toEqual([
      'Name to embroider',
      'Thread',
      'Note for the tailor',
    ]);
    expect(kept.has(plain)).toBe(false);
    expect(await events()).toEqual([
      expect.objectContaining({ aggregate_id: kurta, payload: { fields: 3 } }),
    ]);

    // The same again changes nothing; fewer, and those alone.
    const thread = { name: 'Thread', kind: 'choice' as const, choices: ['Gold', 'Silver'] };
    unwrap(
      await personalisation.set(f.a, kurta, [
        { name: 'Name to embroider', kind: 'text', required: true, maxLength: 12 },
        { ...thread, choices: ['Gold', 'Silver', 'Maroon'], price: '250.5' },
        { name: 'Note for the tailor', kind: 'text' },
      ]),
    );
    expect(await events()).toHaveLength(1);
    unwrap(await personalisation.set(f.a, kurta, [thread]));
    expect(
      await f.db.tenant(f.a.shopId, (tx) => personalisationIn(tx, f.a.shopId, [kurta])),
    ).toEqual(new Map([[kurta, [{ ...thread, required: false, maxLength: null, price: 0 }]]]));
    // Fields kept before a field could cost anything cost nothing.
    await f.admin.query(
      `UPDATE catalog.product_personalisation SET fields = $1::jsonb WHERE product_id = $2`,
      [JSON.stringify([{ ...thread, required: false, maxLength: null }]), kurta],
    );
    expect(
      (await personalisation.of(f.a, [kurta])).get(kurta)?.map((field) => field.price),
    ).toEqual([0]);
    expect(unwrap(await personalisation.set(f.a, kurta, []))).toEqual([]);
    expect((await personalisation.of(f.a, [kurta])).has(kurta)).toBe(false);
    expect(await events()).toHaveLength(3);

    // Its fields go with a product deleted; another shop's products are not found.
    unwrap(await personalisation.set(f.a, kurta, [thread]));
    unwrap(await f.products.delete(f.a, kurta));
    expect((await personalisation.of(f.a, [kurta])).has(kurta)).toBe(false);
    const theirs = await product('Their kurta', f.b);
    expect(errorsOf(await personalisation.set(f.a, theirs, [thread]))).toEqual([
      ['productId', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await personalisation.set(f.a, newId(), [thread]))).toEqual([
      ['productId', 'NOT_FOUND'],
    ]);
  });

  it('refuses a field without its name, an app’s name or a name twice, and choices too few', async () => {
    const kurta = await product('Kurta');
    const result = await personalisation.set(f.a, kurta, [
      { name: ' ', kind: 'text' },
      { name: '_app', kind: 'text' },
      { name: 'Name', kind: 'text', maxLength: 251 },
      { name: 'name', kind: 'choice', choices: ['Gold', 'gold'] },
      { name: 'Colour', kind: 'choice', choices: ['x'.repeat(41), 'Red'] },
      { name: 'Size', kind: 'choice', choices: ['Small'] },
      { name: 'Gift wrap', kind: 'text', price: '-50' },
    ]);
    expect(errorsOf(result)).toEqual([
      ['fields', 'TOO_MANY'],
      ['fields.0.name', 'BLANK'],
      ['fields.1.name', 'INVALID'],
      ['fields.2.maxLength', 'INVALID'],
      ['fields.3.name', 'TAKEN'],
      ['fields.3.choices.1', 'TAKEN'],
      ['fields.4.choices.0', 'TOO_LONG'],
      ['fields.5.choices', 'TOO_FEW'],
      ['fields.6.price', 'INVALID'],
    ]);
    if (!result.ok) {
      expect(result.errors.map((error) => error.message)).toContain(
        "A field's name can't begin with _",
      );
    }
    expect((await personalisation.of(f.a, [kurta])).has(kurta)).toBe(false);
    expect(await events()).toEqual([]);
  });
});
