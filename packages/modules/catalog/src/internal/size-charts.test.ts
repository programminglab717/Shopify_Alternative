import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SIZE_CHART_LIMITS,
  SizeChartEvents,
  SizeChartService,
  shownSizeChartsIn,
  type SizeChartInput,
} from './size-charts.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

const KURTAS: SizeChartInput = {
  name: "Women's kurtas",
  unit: 'in',
  columns: ['Chest', 'Length'],
  rows: [
    { size: 'S', values: [36, 42] },
    { size: 'M', values: [38.5, 43] },
    { size: 'L', values: [40, null] },
  ],
  note: 'Measure under the arms, around the fullest part.',
};

describe.skipIf(!server)('Size charts (CAT-10, ADR-406)', () => {
  let f: CatalogFixture;
  let charts: SizeChartService;

  const product = async (title: string, tenant = f.a) =>
    unwrap(await f.products.create(tenant, { title, status: 'active' })).id;
  const events = async (type: string) =>
    (await f.outbox()).filter((event) => event.event_type === type);

  beforeAll(async () => {
    f = await catalogFixture(server!);
    charts = new SizeChartService(f.db);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(async () => {
    await f.reset();
    await f.admin.query('DELETE FROM catalog.size_charts');
  });

  it("keeps a chart of measurements, a row for each size, and lists the shop's by name", async () => {
    const chart = unwrap(await charts.create(f.a, KURTAS));
    expect(chart).toMatchObject({
      name: "Women's kurtas",
      unit: 'in',
      columns: ['Chest', 'Length'],
      rows: [
        { size: 'S', values: [36, 42] },
        { size: 'M', values: [38.5, 43] },
        { size: 'L', values: [40, null] },
      ],
      note: 'Measure under the arms, around the fullest part.',
      productCount: 0,
    });
    unwrap(
      await charts.create(f.a, {
        name: 'Boys shalwar',
        unit: 'cm',
        columns: ['Waist'],
        rows: [{ size: '8 years', values: [61.234] }],
      }),
    );
    expect((await charts.list(f.a)).map((each) => [each.name, each.rows[0]!.values])).toEqual([
      ['Boys shalwar', [61.23]],
      ["Women's kurtas", [36, 42]],
    ]);
    expect(await charts.list(f.b)).toEqual([]);
    expect(await charts.get(f.b, chart.id)).toBeNull();
    expect((await events(SizeChartEvents.Created)).length).toBe(2);
  });

  it('refuses a chart whose parts do not agree, and a name the shop has', async () => {
    const refused = await charts.create(f.a, {
      ...KURTAS,
      columns: ['Chest', 'chest'],
      rows: [{ size: 'S', values: [36, 1000] }],
    });
    // Sentences of their own where the field's last part is an index.
    expect(refused.ok ? [] : refused.errors.map((error) => error.message)).toEqual([
      'chest is measured already',
      'A measurement must be more than 0 and at most 999',
    ]);
    expect(
      errorsOf(
        await charts.create(f.a, {
          name: ' ',
          unit: 'mm' as never,
          columns: ['Chest', 'chest'],
          rows: [
            { size: 'S', values: [36] },
            { size: 's', values: [0, 1000] },
          ],
        }),
      ),
    ).toEqual([
      ['name', 'BLANK'],
      ['unit', 'INVALID'],
      ['columns.1', 'TAKEN'],
      ['rows.0.values', 'INVALID'],
      ['rows.1.size', 'TAKEN'],
      ['rows.1.values.0', 'INVALID'],
      ['rows.1.values.1', 'INVALID'],
    ]);
    expect(errorsOf(await charts.create(f.a, { ...KURTAS, columns: [], rows: [] }))).toEqual([
      ['columns', 'TOO_FEW'],
      ['rows', 'TOO_FEW'],
    ]);
    unwrap(await charts.create(f.a, KURTAS));
    expect(errorsOf(await charts.create(f.a, { ...KURTAS, name: "WOMEN'S KURTAS" }))).toEqual([
      ['name', 'TAKEN'],
    ]);
    // Another shop may have the same name.
    unwrap(await charts.create(f.b, KURTAS));
  });

  it(`keeps ${SIZE_CHART_LIMITS.charts} charts a shop at most`, async () => {
    await f.admin.query(
      `INSERT INTO catalog.size_charts (shop_id, name, unit, columns, rows)
       SELECT $1, 'Chart ' || n, 'in', '["Chest"]', '[{"size":"M","values":[40]}]'
         FROM generate_series(1, ${SIZE_CHART_LIMITS.charts}) AS n`,
      [f.a.shopId],
    );
    expect(errorsOf(await charts.create(f.a, KURTAS))).toEqual([['name', 'TOO_MANY']]);
  });

  it('gives products a chart by their IDs or as a collection has them, and takes it away', async () => {
    const kurtas = unwrap(await charts.create(f.a, KURTAS));
    const shirts = unwrap(
      await charts.create(f.a, {
        name: 'Shirts',
        unit: 'cm',
        columns: ['Chest'],
        rows: [{ size: 'M', values: [102] }],
      }),
    );
    const lawn = await product('Lawn kurta');
    const silk = await product('Silk kurta');
    const shirt = await product('Cotton shirt');
    const eid = unwrap(await f.collections.create(f.a, { title: 'Eid' }));
    unwrap(await f.collections.addProducts(f.a, eid.id, [silk, shirt]));

    expect(unwrap(await charts.setForProducts(f.a, kurtas.id, { productIds: [lawn] }))).toEqual([
      lawn,
    ]);
    expect(
      unwrap(
        await charts.setForProducts(f.a, kurtas.id, { productIds: [lawn], collectionId: eid.id }),
      ),
    ).toEqual([silk, shirt].sort());
    // Given again, nothing changes; another chart takes its place.
    expect(unwrap(await charts.setForProducts(f.a, kurtas.id, { productIds: [lawn] }))).toEqual([]);
    expect(unwrap(await charts.setForProducts(f.a, shirts.id, { productIds: [shirt] }))).toEqual([
      shirt,
    ]);
    expect((await charts.get(f.a, kurtas.id))!.productCount).toBe(2);

    const shown = await f.db.tenant(f.a.shopId, (tx) =>
      shownSizeChartsIn(tx, f.a.shopId, [lawn, silk, shirt, newId()]),
    );
    expect(shown.get(lawn)).toEqual({
      name: "Women's kurtas",
      unit: 'in',
      columns: ['Chest', 'Length'],
      rows: KURTAS.rows,
      note: KURTAS.note,
    });
    expect(shown.get(shirt)?.name).toBe('Shirts');
    expect(shown.size).toBe(3);
    const chartsOf = await charts.ofProducts(f.a, [lawn, shirt]);
    expect([chartsOf.get(lawn)?.name, chartsOf.get(shirt)?.name]).toEqual([
      "Women's kurtas",
      'Shirts',
    ]);

    expect(unwrap(await charts.setForProducts(f.a, null, { productIds: [lawn, silk] }))).toEqual(
      [lawn, silk].sort(),
    );
    expect((await charts.get(f.a, kurtas.id))!.productCount).toBe(0);
    expect((await events(SizeChartEvents.ProductsUpdated)).map((event) => event.payload)).toEqual([
      { productIds: [lawn], sizeChartId: kurtas.id },
      { productIds: [silk, shirt].sort(), sizeChartId: kurtas.id },
      { productIds: [shirt], sizeChartId: shirts.id },
      { productIds: [lawn, silk].sort(), sizeChartId: null },
    ]);
  });

  it("refuses what is not the shop's, and more products than one call gives", async () => {
    const kurtas = unwrap(await charts.create(f.a, KURTAS));
    const theirs = await product('Their kurta', f.b);
    const lawn = await product('Lawn kurta');
    expect(errorsOf(await charts.setForProducts(f.b, kurtas.id, { productIds: [theirs] }))).toEqual(
      [['sizeChartId', 'NOT_FOUND']],
    );
    expect(
      errorsOf(
        await charts.setForProducts(f.a, kurtas.id, {
          productIds: [lawn, theirs],
          collectionId: newId(),
        }),
      ),
    ).toEqual([
      ['productIds.1', 'NOT_FOUND'],
      ['collectionId', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await charts.setForProducts(f.a, kurtas.id, {}))).toEqual([
      ['productIds', 'BLANK'],
    ]);
    expect(
      errorsOf(
        await charts.setForProducts(f.a, kurtas.id, {
          productIds: Array.from({ length: SIZE_CHART_LIMITS.products + 1 }, newId),
        }),
      ),
    ).toEqual([['productIds', 'TOO_MANY']]);
    expect((await charts.get(f.a, kurtas.id))!.productCount).toBe(0);
  });

  it('changes a chart, naming the products whose pages show it', async () => {
    const kurtas = unwrap(await charts.create(f.a, KURTAS));
    const lawn = await product('Lawn kurta');
    unwrap(await charts.setForProducts(f.a, kurtas.id, { productIds: [lawn] }));

    const renamed = unwrap(await charts.update(f.a, kurtas.id, { name: 'Kurtas', note: null }));
    expect(renamed).toMatchObject({ name: 'Kurtas', note: null, columns: ['Chest', 'Length'] });
    expect(renamed.rows).toEqual(KURTAS.rows);
    // New columns take their rows again.
    expect(errorsOf(await charts.update(f.a, kurtas.id, { columns: ['Chest'] }))).toEqual([
      ['rows', 'INVALID'],
      ['rows', 'TOO_FEW'],
    ]);
    const measured = unwrap(
      await charts.update(f.a, kurtas.id, {
        unit: 'cm',
        columns: ['Chest'],
        rows: [{ size: 'M', values: [97.5] }],
      }),
    );
    expect(measured).toMatchObject({ unit: 'cm', rows: [{ size: 'M', values: [97.5] }] });
    // The same again changes nothing.
    unwrap(await charts.update(f.a, kurtas.id, { unit: 'cm' }));
    expect((await events(SizeChartEvents.Updated)).map((event) => event.payload)).toEqual([
      { productIds: [lawn] },
      { productIds: [lawn] },
    ]);

    const other = unwrap(await charts.create(f.a, { ...KURTAS, name: 'Shirts' }));
    expect(errorsOf(await charts.update(f.a, other.id, { name: 'kurtas' }))).toEqual([
      ['name', 'TAKEN'],
    ]);
    expect(errorsOf(await charts.update(f.b, kurtas.id, { name: 'Mine' }))).toEqual([
      ['id', 'NOT_FOUND'],
    ]);
  });

  it('deletes a chart: the products that showed it show none, and a copy keeps its own', async () => {
    const kurtas = unwrap(await charts.create(f.a, KURTAS));
    const lawn = await product('Lawn kurta');
    unwrap(await charts.setForProducts(f.a, kurtas.id, { productIds: [lawn] }));
    const copy = unwrap(
      await f.products.duplicate(f.a, { productId: lawn, newTitle: 'Lawn kurta, blue' }),
    );
    expect((await charts.ofProducts(f.a, [copy.id])).get(copy.id)?.name).toBe("Women's kurtas");

    expect(errorsOf(await charts.delete(f.b, kurtas.id))).toEqual([['id', 'NOT_FOUND']]);
    expect(unwrap(await charts.delete(f.a, kurtas.id))).toBe(kurtas.id);
    expect((await events(SizeChartEvents.Deleted)).map((event) => event.payload)).toEqual([
      { productIds: [lawn, copy.id].sort() },
    ]);
    expect((await charts.ofProducts(f.a, [lawn, copy.id])).size).toBe(0);
    expect(errorsOf(await charts.delete(f.a, kurtas.id))).toEqual([['id', 'NOT_FOUND']]);

    // A product deleted takes its chart's mention with it.
    const shirts = unwrap(await charts.create(f.a, { ...KURTAS, name: 'Shirts' }));
    unwrap(await charts.setForProducts(f.a, shirts.id, { productIds: [lawn] }));
    unwrap(await f.products.delete(f.a, lawn));
    expect((await charts.get(f.a, shirts.id))!.productCount).toBe(0);
  });
});
