import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  StorefrontContentSearchController,
  contentSearchText,
  searchContentIn,
} from './content-search.js';
import { onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)("A storefront's search of the shop's articles and pages (ADR-212)", () => {
  let f: OnlineStoreFixture;

  beforeAll(async () => {
    f = await onlineStoreFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  const search = (terms: string, options: Partial<Parameters<typeof searchContentIn>[3]> = {}) =>
    f.db.tenant(f.a.shopId, (tx) =>
      searchContentIn(tx, f.a.shopId, terms, { limit: 250, ...options }),
    );

  it('keeps the words of a title, its names and the opening of its text, folded', () => {
    expect(
      contentSearchText(
        'Eid Lawn',
        ['Ayesha Khan'],
        '<p>Hand-block&nbsp;printed <b>kameez</b></p>',
      ),
    ).toBe('eid lawn ayesha khan hand block printed kamiz');
    expect(contentSearchText('Notes', [], `<p>${'a '.repeat(6_000)}multan</p>`)).not.toContain(
      'multan',
    );
  });

  it('finds published articles and pages with every word typed, a title first, and no other shop’s', async () => {
    const shipping = unwrap(
      await f.pages.create(f.a, {
        title: 'Shipping and returns',
        body: '<p>We deliver lawn suits across Pakistan, from Multan.</p>',
      }),
    );
    const about = unwrap(
      await f.pages.create(f.a, {
        title: 'About us',
        body: '<p>Hand-block printed lawn from Multan.</p>',
      }),
    );
    unwrap(await f.pages.create(f.a, { title: 'Lawn secrets', isPublished: false }));
    const news = unwrap(await f.blogs.create(f.a, { title: 'News' }));
    const eid = unwrap(
      await f.articles.create(f.a, {
        blogId: news.id,
        title: 'Eid lawn is here',
        body: '<p>Printed in Multan.</p>',
        author: 'Ayesha Khan',
        tags: ['Eid'],
      }),
    );
    const cuts = unwrap(
      await f.articles.create(f.a, {
        blogId: news.id,
        title: 'Kameez cuts',
        summary: '<p>Measure twice.</p>',
        tags: ['Guides'],
      }),
    );
    unwrap(
      await f.articles.create(f.a, { blogId: news.id, title: 'Draft lawn', isPublished: false }),
    );
    // Another shop's, with every word.
    unwrap(await f.pages.create(f.b, { title: 'Lawn', body: '<p>Multan lawn</p>' }));

    // A title holding the word first, then the latest published; nothing hidden.
    expect(await search('lawn')).toEqual({
      articleIds: [eid.id],
      pageIds: [about.id, shipping.id],
    });
    expect(await search('lawn multan')).toEqual({
      articleIds: [eid.id],
      pageIds: [about.id, shipping.id],
    });
    expect(await search('lawn pakistan')).toEqual({ articleIds: [], pageIds: [shipping.id] });
    // Its tags, its author and its summary too.
    expect((await search('guides')).articleIds).toEqual([cuts.id]);
    expect((await search('ayesha')).articleIds).toEqual([eid.id]);
    expect((await search('twice')).articleIds).toEqual([cuts.id]);
    // As Roman Urdu folds it: "kame", on its way to "kameez", only as the last word cut short.
    expect((await search('kame')).articleIds).toEqual([]);
    expect((await search('kame', { prefix: true })).articleIds).toEqual([cuts.id]);
    // The kinds asked for alone, as many as asked; nothing for no words.
    expect(await search('lawn', { types: new Set(['page']), limit: 1 })).toEqual({
      articleIds: [],
      pageIds: [about.id],
    });
    expect(await search(' , ')).toEqual({ articleIds: [], pageIds: [] });

    // Changed, it is found by its words now.
    unwrap(await f.pages.update(f.a, about.id, { title: 'Our story', body: '<p>Since 1990.</p>' }));
    expect((await search('lawn')).pageIds).toEqual([shipping.id]);
    expect((await search('story')).pageIds).toEqual([about.id]);
    unwrap(await f.articles.update(f.a, eid.id, { tags: ['Festive'] }));
    expect((await search('festive')).articleIds).toEqual([eid.id]);
  });

  it('answers storefronts with the kinds and as many as asked, for a shop by its ID', async () => {
    const news = unwrap(await f.blogs.create(f.a, { title: 'News' }));
    const [first, second] = [
      unwrap(await f.articles.create(f.a, { blogId: news.id, title: 'Lawn one' })),
      unwrap(await f.articles.create(f.a, { blogId: news.id, title: 'Lawn two' })),
    ];
    const page = unwrap(await f.pages.create(f.a, { title: 'Lawn care' }));
    const controller = new StorefrontContentSearchController(f.db);
    expect(await controller.search(f.a.shopId, { q: 'lawn' })).toEqual({
      articleIds: [second.id, first.id],
      pageIds: [page.id],
    });
    expect(
      await controller.search(f.a.shopId, { q: 'lawn', types: 'article', limit: '1' }),
    ).toEqual({ articleIds: [second.id], pageIds: [] });
    expect(
      await controller.search(f.a.shopId, { q: 'law', prefix: 'last', types: 'page' }),
    ).toEqual({ articleIds: [], pageIds: [page.id] });
    await expect(controller.search('not-a-shop', { q: 'lawn' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
