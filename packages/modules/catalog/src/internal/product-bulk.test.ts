import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FieldError } from './input-checker.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

/** The [field path, code] pairs of a bulk action's refusals. */
const refused = (errors: readonly FieldError[]) =>
  errors.map((error) => [error.field.join('.'), error.code]);

describe.skipIf(!server)('Products acted on many at once (CAT-04)', () => {
  let f: CatalogFixture;
  const create = async (title: string, extra: Record<string, unknown> = {}) =>
    unwrap(await f.products.create(f.a, { title, ...extra }));

  beforeAll(async () => {
    f = await catalogFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  it('shows, hides or archives each product chosen, once, saying those refused at their place', async () => {
    const lawn = await create('Lawn Suit', { status: 'draft' });
    const shawl = await create('Ajrak Shawl', { status: 'active' });
    const elsewhere = unwrap(await f.products.create(f.b, { title: 'Khussa', status: 'draft' }));
    const before = (await f.outbox()).length;

    const { done, errors } = unwrap(
      await f.products.bulkSetStatus(
        f.a,
        [lawn.id, shawl.id, elsewhere.id, lawn.id, newId()],
        'active',
      ),
    );
    expect(done.map((product) => [product.title, product.status])).toEqual([
      ['Lawn Suit', 'active'],
      ['Ajrak Shawl', 'active'],
    ]);
    expect(refused(errors)).toEqual([
      ['ids.2', 'NOT_FOUND'],
      ['ids.4', 'NOT_FOUND'],
    ]);
    // Told only of the one that changed.
    const updated = (await f.outbox()).slice(before);
    expect(updated.map((row) => [row.event_type, row.aggregate_id, row.payload.changed])).toEqual([
      ['product.updated', lawn.id, ['status']],
    ]);
    expect((await f.products.get(f.b, elsewhere.id))!.status).toBe('draft');

    const archived = unwrap(await f.products.bulkSetStatus(f.a, [shawl.id], 'archived'));
    expect(archived.done.map((product) => product.status)).toEqual(['archived']);
  });

  it('adds tags as yet missing, in any case, and takes tags off, refusing one past the most', async () => {
    const lawn = await create('Lawn Suit', { tags: ['Lawn', 'summer'] });
    const shawl = await create('Ajrak Shawl');
    const full = await create('Khaddar Shawl', {
      tags: Array.from({ length: 250 }, (_, index) => `tag-${index}`),
    });

    const added = unwrap(
      await f.products.bulkAddTags(f.a, [lawn.id, shawl.id, full.id], ['lawn', ' Eid ', 'eid']),
    );
    expect(added.done.map((product) => product.tags)).toEqual([
      ['Lawn', 'summer', 'Eid'],
      ['lawn', 'Eid'],
    ]);
    expect(refused(added.errors)).toEqual([['ids.2', 'TOO_MANY']]);
    expect((await f.products.get(f.a, full.id))!.tags).toHaveLength(250);

    const removed = unwrap(
      await f.products.bulkRemoveTags(f.a, [lawn.id, shawl.id], ['LAWN', 'winter']),
    );
    expect(removed.done.map((product) => product.tags)).toEqual([['summer', 'Eid'], ['Eid']]);
    // Smart collections follow the tags.
    const smart = unwrap(
      await f.collections.create(f.a, {
        title: 'Eid',
        ruleSet: {
          appliedDisjunctively: false,
          rules: [{ column: 'tag', relation: 'equals', condition: 'Eid' }],
        },
      }),
    );
    unwrap(await f.products.bulkRemoveTags(f.a, [shawl.id], ['eid']));
    const members = await f.collections.products(f.a, smart.id, { first: 10, after: null });
    expect(members!.items.map((item) => item.id)).toEqual([lawn.id]);
  });

  it('deletes each product chosen, and refuses no IDs, too many, or no tags', async () => {
    const lawn = await create('Lawn Suit');
    const shawl = await create('Ajrak Shawl');
    const elsewhere = unwrap(await f.products.create(f.b, { title: 'Khussa' }));

    const { done, errors } = unwrap(
      await f.products.bulkDelete(f.a, [lawn.id, elsewhere.id, shawl.id]),
    );
    expect(done).toEqual([{ id: lawn.id }, { id: shawl.id }]);
    expect(refused(errors)).toEqual([['ids.1', 'NOT_FOUND']]);
    expect((await f.products.list(f.a, { first: 10 })).items).toEqual([]);
    expect(await f.products.get(f.b, elsewhere.id)).not.toBeNull();
    const deleted = (await f.outbox()).filter((row) => row.event_type === 'product.deleted');
    expect(deleted.map((row) => row.aggregate_id)).toEqual([lawn.id, shawl.id]);

    expect(errorsOf(await f.products.bulkDelete(f.a, []))).toEqual([['ids', 'BLANK']]);
    expect(
      errorsOf(
        await f.products.bulkSetStatus(
          f.a,
          Array.from({ length: 251 }, () => newId()),
          'draft',
        ),
      ),
    ).toEqual([['ids', 'TOO_MANY']]);
    expect(errorsOf(await f.products.bulkAddTags(f.a, [lawn.id], [' ']))).toEqual([
      ['tags', 'BLANK'],
    ]);
  });
});
