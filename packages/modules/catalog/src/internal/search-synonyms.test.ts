import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SEARCH_SYNONYM_LIMITS,
  SearchSynonymEvents,
  SearchSynonymService,
} from './search-synonyms.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("A shop's own search synonyms (SRC-04, ADR-685)", () => {
  let f: CatalogFixture;
  let synonyms: SearchSynonymService;

  const create = async (title: string, tags: string[] = []) =>
    unwrap(await f.products.create(f.a, { title, status: 'active', tags })).id;
  const search = (terms: string, shopId = f.a.shopId) =>
    f.db.tenant(shopId, (tx) => f.products.searchIdsOf(tx, shopId, terms, 10));

  beforeAll(async () => {
    f = await catalogFixture(server!);
    synonyms = new SearchSynonymService(f.db);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(async () => {
    await f.reset();
    await f.admin.query('DELETE FROM catalog.search_synonyms');
  });

  it("keeps the shop's groups as it wrote them, replaced together, and tells of the change", async () => {
    expect(await synonyms.list(f.a)).toEqual([]);
    const groups = [
      [' Chappal ', 'Sandals', 'slippers'],
      ['jora', 'suit'],
    ];
    expect(unwrap(await synonyms.set(f.a, groups))).toEqual([
      { words: ['Chappal', 'Sandals', 'slippers'] },
      { words: ['jora', 'suit'] },
    ]);
    expect(await synonyms.list(f.a)).toHaveLength(2);
    // Another shop's are its own.
    expect(await synonyms.list(f.b)).toEqual([]);
    unwrap(await synonyms.set(f.a, [['jora', 'suit']]));
    expect(await synonyms.list(f.a)).toEqual([{ words: ['jora', 'suit'] }]);
    unwrap(await synonyms.set(f.a, []));
    expect(await synonyms.list(f.a)).toEqual([]);
    const events = (await f.outbox()).filter(
      (event) => event.event_type === SearchSynonymEvents.Updated,
    );
    expect(events.map((event) => (event.payload as { groups: number }).groups)).toEqual([2, 1, 0]);
  });

  it('refuses a group of one word, a phrase, a blank or a word in two groups', async () => {
    const refused = await synonyms.set(f.a, [
      ['chappal'],
      ['lawn suit', 'jora', ' '],
      ['Juti', 'khussa', 'juti'],
      ['sandal', 'Khussa'],
      ['x'.repeat(SEARCH_SYNONYM_LIMITS.word + 1), 'y'],
    ]);
    expect(errorsOf(refused)).toEqual([
      ['groups.0', 'TOO_FEW'],
      ['groups.1.0', 'INVALID'],
      ['groups.1.2', 'BLANK'],
      ['groups.2.2', 'TAKEN'],
      ['groups.3.1', 'TAKEN'],
      ['groups.4.0', 'TOO_LONG'],
    ]);
    expect(refused.ok ? [] : refused.errors.map((error) => error.message)).toContain(
      'Khussa is in another group already',
    );
    const many = Array.from({ length: SEARCH_SYNONYM_LIMITS.groups + 1 }, (_, index) => [
      `a${index}`,
      `b${index}`,
    ]);
    expect(errorsOf(await synonyms.set(f.a, many))).toEqual([['groups', 'TOO_MANY']]);
    expect(await synonyms.list(f.a)).toEqual([]);
  });

  it("finds by the shop's synonyms beside the lexicon's, what holds the word as typed first", async () => {
    const chappal = await create('Peshawari Chappal');
    const sandals = await create('Summer Sandals');
    const shoes = await create('Leather Shoes');
    unwrap(await f.products.create(f.b, { title: 'Sandals', status: 'active' }));
    // Before the shop says so, chappals are not sandals.
    expect(await search('chappal')).toEqual([chappal]);

    unwrap(await synonyms.set(f.a, [['chappal', 'sandals', 'چپل']]));
    expect(await search('chappal')).toEqual([chappal, sandals]);
    expect(await search('sandals')).toEqual([sandals, chappal]);
    // A synonym is a whole word as the shop wrote it: "sandal" is not "sandals".
    expect(await search('sandal')).toEqual([sandals]);
    expect(await search('چپل')).toEqual([sandals, chappal]);
    // The lexicon's words still count: shoes are juta.
    expect(await search('juta')).toEqual([shoes]);
    // Another shop's search reads its own.
    expect(await search('chappal', f.b.shopId)).toEqual([]);
  });
});
