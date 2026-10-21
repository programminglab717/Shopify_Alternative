import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEARCH_RULE_LIMITS, SearchRuleEvents, SearchRuleService } from './search-rules.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('What a search shows first or leaves out (SRC-04, ADR-692)', () => {
  let f: CatalogFixture;
  let rules: SearchRuleService;

  const create = async (title: string, status: 'active' | 'draft' = 'active') =>
    unwrap(await f.products.create(f.a, { title, status })).id;
  const search = (terms: string, options: { limit?: number; prefix?: boolean } = {}) =>
    f.db.tenant(f.a.shopId, (tx) =>
      f.products.searchIdsOf(tx, f.a.shopId, terms, options.limit ?? 10, options),
    );

  beforeAll(async () => {
    f = await catalogFixture(server!);
    rules = new SearchRuleService(f.db);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(async () => {
    await f.reset();
    await f.admin.query('DELETE FROM catalog.search_rules');
  });

  it("pins products to the top of a term's search in their order, and hides others", async () => {
    const lawn = await create('Eid Lawn Suit');
    const kurta = await create('Eid Kurta');
    const old = await create('Eid Collection 2023');
    const dupatta = await create('Chiffon Dupatta');
    const draft = await create('Eid Shawl', 'draft');
    expect(await search('eid')).toEqual([old, kurta, lawn]);

    const rule = unwrap(await rules.set(f.a, ' EID ', [dupatta, draft, lawn], [old]));
    expect(rule).toMatchObject({ query: 'EID', pinned: [dupatta, draft, lawn], hidden: [old] });
    // Pinned first in their order, whether they hold the word or not; a draft is not shown;
    // hidden left out; each once.
    expect(await search('eid')).toEqual([dupatta, lawn, kurta]);
    expect(await search('Eid', { limit: 2 })).toEqual([dupatta, lawn]);
    // The whole term, folded as the search folds it: not a search with more words, but one
    // typed to the end while a shopper types.
    expect(await search('eid kurta')).toEqual([kurta]);
    expect(await search('eid', { prefix: true })).toEqual([dupatta, lawn, kurta]);

    // The same term, written again, is its rule changed.
    unwrap(await rules.set(f.a, 'eid', [kurta], []));
    expect(await rules.list(f.a)).toMatchObject([{ query: 'eid', pinned: [kurta], hidden: [] }]);
    expect(await search('eid')).toEqual([kurta, old, lawn]);
    // Another shop's search is its own.
    expect(await rules.list(f.b)).toEqual([]);

    // A product deleted since is passed over.
    unwrap(await f.products.delete(f.a, kurta));
    expect(await rules.list(f.a)).toMatchObject([{ pinned: [], hidden: [] }]);

    const id = (await rules.list(f.a))[0]!.id;
    expect(unwrap(await rules.delete(f.a, id))).toBe(id);
    expect(await search('eid')).toEqual([old, lawn]);
    expect(errorsOf(await rules.delete(f.a, id))).toEqual([['id', 'NOT_FOUND']]);
    const events = (await f.outbox()).filter((event) =>
      Object.values(SearchRuleEvents).includes(event.event_type as never),
    );
    expect(events.map((event) => [event.event_type, event.payload])).toEqual([
      [SearchRuleEvents.Updated, { pinned: 3, hidden: 1 }],
      [SearchRuleEvents.Updated, { pinned: 1, hidden: 0 }],
      [SearchRuleEvents.Deleted, {}],
    ]);
  });

  it("refuses a term without a word, a product pinned twice or another shop's, or nothing", async () => {
    const lawn = await create('Lawn');
    const theirs = unwrap(await f.products.create(f.b, { title: 'Theirs' })).id;
    expect(errorsOf(await rules.set(f.a, ' !! ', [lawn], []))).toEqual([['query', 'INVALID']]);
    expect(errorsOf(await rules.set(f.a, 'lawn', [], []))).toEqual([['pinnedProductIds', 'BLANK']]);
    expect(errorsOf(await rules.set(f.a, 'lawn', [lawn], [lawn]))).toEqual([
      ['hiddenProductIds.0', 'TAKEN'],
    ]);
    expect(errorsOf(await rules.set(f.a, 'lawn', [lawn, theirs], []))).toEqual([
      ['pinnedProductIds.1', 'NOT_FOUND'],
    ]);
    const many = Array.from({ length: SEARCH_RULE_LIMITS.pinned + 1 }, () => lawn);
    expect(errorsOf(await rules.set(f.a, 'lawn', many, [])).slice(0, 1)).toEqual([
      ['pinnedProductIds', 'TOO_MANY'],
    ]);
    const words = Array.from({ length: SEARCH_RULE_LIMITS.words + 1 }, (_, at) => `w${at}`);
    expect(errorsOf(await rules.set(f.a, words.join(' '), [lawn], []))).toEqual([
      ['query', 'TOO_LONG'],
    ]);
    expect(await rules.list(f.a)).toEqual([]);
  });
});
