import 'reflect-metadata';
import { DnsLookup, StorefrontSite } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { searchContentIn } from './content-search.js';
import { DomainService } from './domain.service.js';
import { PolicyService, shopPoliciesOf } from './policy.service.js';
import { translations } from './schema.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';
import { digestOf, type TranslatableKind } from './translation-content.js';
import { shopTranslationsOf } from './translation.service.js';

const server = testDatabaseServer();

/** No domain of their own: the shops are at their handles' subdomains. */
class NoDns extends DnsLookup {
  async cnames(): Promise<string[]> {
    return [];
  }

  async addresses(): Promise<string[]> {
    return [];
  }
}

describe.skipIf(!server)('TranslationService', () => {
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

  const events = async () =>
    (await f.outbox())
      .filter((event) => event.event_type === 'translations.updated')
      .map((event) => [event.aggregate_id, event.payload] as const);

  /** The digest of a resource's field, as the API gives it. */
  const digestIn = async (kind: TranslatableKind, id: string, key: string) =>
    (await f.translations.resource(f.a, kind, id))!.content.find((field) => field.key === key)!
      .digest;

  it('matches the migrated table', async () => {
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(translations).limit(1));
  });

  it("keeps a product's fields in Urdu, each written for its words as they were", async () => {
    const lawn = unwrap(
      await f.products.create(f.a, {
        title: 'Lawn Suit',
        description: 'Soft lawn.\n\nThree pieces & a dupatta.',
        productType: 'Suits',
        seo: { title: null, description: 'Lawn for Eid' },
      }),
    );
    // Its fields with words, a description as HTML, each with its digest.
    const own = await f.translations.resource(f.a, 'product', lawn.id);
    const body = '<p>Soft lawn.</p><p>Three pieces &amp; a dupatta.</p>';
    expect(own).toEqual({
      kind: 'product',
      id: lawn.id,
      content: [
        {
          key: 'title',
          value: 'Lawn Suit',
          digest: digestOf('Lawn Suit'),
          type: 'single_line_text_field',
        },
        { key: 'body_html', value: body, digest: digestOf(body), type: 'html' },
        {
          key: 'product_type',
          value: 'Suits',
          digest: digestOf('Suits'),
          type: 'single_line_text_field',
        },
        {
          key: 'meta_description',
          value: 'Lawn for Eid',
          digest: digestOf('Lawn for Eid'),
          type: 'multi_line_text_field',
        },
      ],
      translations: [],
    });

    // A title on one line; a description kept as text, as the product's is.
    const kept = unwrap(
      await f.translations.register(f.a, 'product', lawn.id, [
        {
          locale: 'ur',
          key: 'title',
          value: '  لان\n سوٹ ',
          translatableContentDigest: digestOf('Lawn Suit'),
        },
        {
          locale: 'ur',
          key: 'body_html',
          value: '<p>نرم لان۔</p><script>x()</script><p>تین پیس &amp; دوپٹہ</p>',
          translatableContentDigest: digestOf(body),
        },
      ]),
    );
    expect(kept.map((each) => [each.key, each.value, each.locale, each.outdated])).toEqual([
      ['title', 'لان سوٹ', 'ur', false],
      ['body_html', '<p>نرم لان۔</p><p>تین پیس &amp; دوپٹہ</p>', 'ur', false],
    ]);
    expect(await events()).toEqual([
      [lawn.id, { kind: 'product', locales: ['ur'], keys: ['body_html', 'title'] }],
    ]);
    const translated = await f.db.tenant(f.a.shopId, (tx) =>
      shopTranslationsOf(tx, f.a.shopId, [lawn.id]),
    );
    expect(translated.get(lawn.id)).toEqual({
      ur: { body_html: 'نرم لان۔\n\nتین پیس & دوپٹہ', title: 'لان سوٹ' },
    });

    // The product's title changes: its translation is outdated, its description's is not.
    unwrap(await f.products.update(f.a, { id: lawn.id, title: 'Lawn Suit, 3 piece' }));
    const after = await f.translations.resource(f.a, 'product', lawn.id);
    expect(after!.translations.map((each) => [each.key, each.outdated])).toEqual([
      ['body_html', false],
      ['title', true],
    ]);
    // Written for the old words, it is refused; for the new, it takes the old one's place.
    expect(
      errorsOf(
        await f.translations.register(f.a, 'product', lawn.id, [
          {
            locale: 'ur',
            key: 'title',
            value: 'لان سوٹ، تین پیس',
            translatableContentDigest: digestOf('Lawn Suit'),
          },
        ]),
      ),
    ).toEqual([
      [
        'translations.0.translatableContentDigest',
        'STALE',
        "The product's title has changed since it was read: read it again",
      ],
    ]);
    unwrap(
      await f.translations.register(f.a, 'product', lawn.id, [
        {
          locale: 'ur',
          key: 'title',
          value: 'لان سوٹ، تین پیس',
          translatableContentDigest: digestOf('Lawn Suit, 3 piece'),
        },
      ]),
    );
    expect(
      (await f.translations.resource(f.a, 'product', lawn.id))!.translations.map((each) => [
        each.key,
        each.value,
        each.outdated,
      ]),
    ).toEqual([
      ['body_html', '<p>نرم لان۔</p><p>تین پیس &amp; دوپٹہ</p>', false],
      ['title', 'لان سوٹ، تین پیس', false],
    ]);

    // Another shop sees none of it, and translates nothing of it.
    expect(await f.translations.resource(f.b, 'product', lawn.id)).toBeNull();
    expect(
      errorsOf(
        await f.translations.register(f.b, 'product', lawn.id, [
          { locale: 'ur', key: 'title', value: 'x', translatableContentDigest: digestOf('x') },
        ]),
      ),
    ).toEqual([['resourceId', 'NOT_FOUND', 'No such product']]);
  });

  it('refuses what cannot be translated, saying why', async () => {
    const lawn = unwrap(await f.products.create(f.a, { title: 'Lawn Suit' }));
    const title = digestOf('Lawn Suit');
    expect(
      errorsOf(
        await f.translations.register(f.a, 'product', lawn.id, [
          { locale: 'fr', key: 'title', value: 'Costume', translatableContentDigest: title },
          { locale: 'ur', key: 'handle', value: 'lawn', translatableContentDigest: title },
          { locale: 'ur', key: 'meta_title', value: 'لان', translatableContentDigest: title },
          { locale: 'ur', key: 'title', value: ' \n ', translatableContentDigest: title },
          { locale: 'ur', key: 'title', value: 'ل'.repeat(256), translatableContentDigest: title },
        ]),
      ),
    ).toEqual([
      [
        'translations.0.locale',
        'INVALID',
        "Locale fr is not one the storefront shows besides the shop's own: ur",
      ],
      [
        'translations.1.key',
        'INVALID',
        'Key handle is not a field of a product that can be translated: title, body_html, ' +
          'product_type, meta_title, meta_description',
      ],
      ['translations.2.key', 'INVALID', 'The product has no meta_title to translate'],
      ['translations.3.value', 'BLANK', "Value can't be blank"],
      ['translations.4', 'INVALID', 'title in ur is given twice'],
      ['translations.4.value', 'TOO_LONG', 'Value is too long (maximum is 255 characters)'],
    ]);
    expect(errorsOf(await f.translations.register(f.a, 'product', lawn.id, []))).toEqual([
      ['translations', 'BLANK', "Translations can't be blank"],
    ]);
    // Nothing was kept, and nothing told.
    expect((await f.translations.resource(f.a, 'product', lawn.id))!.translations).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("removes a resource's translations, the storefront showing its own words again", async () => {
    const about = unwrap(
      await f.pages.create(f.a, {
        title: 'About us',
        body: '<p>Since 1998.</p>',
        seo: { title: 'About Zari', description: null },
      }),
    );
    unwrap(
      await f.translations.register(f.a, 'page', about.id, [
        {
          locale: 'ur',
          key: 'title',
          value: 'ہمارے بارے میں',
          translatableContentDigest: digestOf('About us'),
        },
        {
          locale: 'ur',
          key: 'body_html',
          value: '<p onclick="x()">1998 سے۔</p>',
          translatableContentDigest: digestOf('<p>Since 1998.</p>'),
        },
        {
          locale: 'ur',
          key: 'meta_title',
          value: 'زری کے بارے میں',
          translatableContentDigest: digestOf('About Zari'),
        },
      ]),
    );
    // A page's HTML is cleaned as its own is.
    expect(
      (await f.translations.resource(f.a, 'page', about.id))!.translations.find(
        (each) => each.key === 'body_html',
      )!.value,
    ).toBe('<p>1998 سے۔</p>');

    expect(
      errorsOf(await f.translations.remove(f.a, 'page', about.id, ['summary_html'], ['de'])),
    ).toEqual([
      [
        'translationKeys.0',
        'INVALID',
        'Key summary_html is not a field of a page that can be translated',
      ],
      ['locales.0', 'INVALID', "Locale de is not one the storefront shows besides the shop's own"],
    ]);
    const removed = unwrap(
      await f.translations.remove(f.a, 'page', about.id, ['title', 'meta_title'], ['ur']),
    );
    expect(removed.map((each) => [each.key, each.value]).sort()).toEqual([
      ['meta_title', 'زری کے بارے میں'],
      ['title', 'ہمارے بارے میں'],
    ]);
    expect(
      (await f.translations.resource(f.a, 'page', about.id))!.translations.map((each) => each.key),
    ).toEqual(['body_html']);
    // Removing what is not there changes nothing, and tells nobody.
    expect(unwrap(await f.translations.remove(f.a, 'page', about.id, ['title'], ['ur']))).toEqual(
      [],
    );
    expect((await events()).map(([id, payload]) => [id, payload.keys])).toEqual([
      [about.id, ['body_html', 'meta_title', 'title']],
      [about.id, ['meta_title', 'title']],
    ]);
  });

  it("lists a kind's resources the newest first, a page at a time: articles, blogs, menus and their items", async () => {
    const news = unwrap(await f.blogs.create(f.a, { title: 'News' }));
    const eid = unwrap(
      await f.articles.create(f.a, {
        blogId: news.id,
        title: 'Eid is here',
        body: '<p>New lawn.</p>',
        summary: '<p>Out now.</p>',
      }),
    );
    const winter = unwrap(await f.articles.create(f.a, { blogId: news.id, title: 'Winter' }));
    const pageOne = await f.translations.resources(f.a, 'article', { first: 1 });
    expect(pageOne.items.map((each) => each.id)).toEqual([winter.id]);
    expect(pageOne.hasNextPage).toBe(true);
    const pageTwo = await f.translations.resources(f.a, 'article', { first: 1, after: winter.id });
    expect(pageTwo).toEqual({
      items: [
        {
          kind: 'article',
          id: eid.id,
          content: [
            {
              key: 'title',
              value: 'Eid is here',
              digest: digestOf('Eid is here'),
              type: 'single_line_text_field',
            },
            {
              key: 'body_html',
              value: '<p>New lawn.</p>',
              digest: digestOf('<p>New lawn.</p>'),
              type: 'html',
            },
            {
              key: 'summary_html',
              value: '<p>Out now.</p>',
              digest: digestOf('<p>Out now.</p>'),
              type: 'html',
            },
          ],
          translations: [],
        },
      ],
      hasNextPage: false,
    });
    expect(
      (await f.translations.resources(f.a, 'blog', { first: 10 })).items.map(
        (each) => each.content,
      ),
    ).toEqual([
      [
        {
          key: 'title',
          value: 'News',
          digest: digestOf('News'),
          type: 'single_line_text_field',
        },
      ],
    ]);

    // A menu's items at every level, each by its own ID.
    const shopBy = unwrap(
      await f.menus.create(f.a, {
        title: 'Shop by',
        handle: 'shop-by',
        items: [
          {
            title: 'Home',
            type: 'frontpage',
            items: [{ title: 'Sale', type: 'http', url: '/collections/sale' }],
          },
        ],
      }),
    );
    const sale = shopBy.items[0]!.items[0]!;
    const items = await f.translations.resources(f.a, 'menuItem', { first: 50 });
    expect(items.items.map((each) => each.content[0]!.value)).toEqual(
      expect.arrayContaining(['Home', 'Sale']),
    );
    unwrap(
      await f.translations.register(f.a, 'menuItem', sale.id, [
        {
          locale: 'ur',
          key: 'title',
          value: 'سیل',
          translatableContentDigest: await digestIn('menuItem', sale.id, 'title'),
        },
      ]),
    );
    unwrap(
      await f.translations.register(f.a, 'menu', shopBy.id, [
        {
          locale: 'ur',
          key: 'title',
          value: 'خریدیں',
          translatableContentDigest: digestOf('Shop by'),
        },
      ]),
    );
    expect(await events()).toEqual([
      [sale.id, { kind: 'menuItem', locales: ['ur'], keys: ['title'] }],
      [shopBy.id, { kind: 'menu', locales: ['ur'], keys: ['title'] }],
    ]);
    const menus = (await f.translations.resources(f.a, 'menu', { first: 50 })).items;
    expect(
      menus.find((each) => each.id === shopBy.id)!.translations.map((each) => each.value),
    ).toEqual(['خریدیں']);
  });

  it("gives the storefront a policy's Urdu while it translates the policy as it is (ADR-239)", async () => {
    const site = new StorefrontSite('https://hatti.pk');
    const service = new PolicyService(f.db, site, new DomainService(f.db, site, new NoDns()));
    unwrap(await service.update(f.a, { type: 'refund_policy', body: '<p>7 days.</p>' }));
    const listed = (await f.translations.resources(f.a, 'shopPolicy', { first: 10 })).items;
    expect(listed.map((each) => each.content)).toEqual([
      [{ key: 'body', value: '<p>7 days.</p>', digest: digestOf('<p>7 days.</p>'), type: 'html' }],
    ]);
    const refund = listed[0]!.id;
    // Cleaned as the policy is.
    unwrap(
      await f.translations.register(f.a, 'shopPolicy', refund, [
        {
          locale: 'ur',
          key: 'body',
          value: '<p onclick="x()">سات دن۔</p><script>x()</script>',
          translatableContentDigest: digestOf('<p>7 days.</p>'),
        },
      ]),
    );
    expect(await events()).toEqual([
      [refund, { kind: 'shopPolicy', locales: ['ur'], keys: ['body'] }],
    ]);
    const given = () => f.db.tenant(f.a.shopId, (tx) => shopPoliciesOf(tx, f.a.shopId));
    expect(await given()).toEqual([
      { type: 'refund_policy', body: '<p>7 days.</p>', translations: { ur: '<p>سات دن۔</p>' } },
    ]);

    // The policy's words change: its Urdu, written for the old ones, is not given, as its terms
    // may not be the policy's now, until it is written again.
    unwrap(await service.update(f.a, { type: 'refund_policy', body: '<p>14 days.</p>' }));
    expect(await given()).toEqual([
      { type: 'refund_policy', body: '<p>14 days.</p>', translations: {} },
    ]);
    expect(
      (await f.translations.resource(f.a, 'shopPolicy', refund))!.translations.map((each) => [
        each.value,
        each.outdated,
      ]),
    ).toEqual([['<p>سات دن۔</p>', true]]);
    unwrap(
      await f.translations.register(f.a, 'shopPolicy', refund, [
        {
          locale: 'ur',
          key: 'body',
          value: '<p>چودہ دن۔</p>',
          translatableContentDigest: digestOf('<p>14 days.</p>'),
        },
      ]),
    );
    expect((await given())[0]!.translations).toEqual({ ur: '<p>چودہ دن۔</p>' });
    expect(await f.translations.resources(f.b, 'shopPolicy', { first: 10 })).toEqual({
      items: [],
      hasNextPage: false,
    });
  });

  it('pages through products by the catalog, the newest first', async () => {
    // The other shop's, as the catalog stays between tests.
    for (const title of ['Lawn', 'Shawl', 'Kurta']) {
      unwrap(await f.products.create(f.b, { title }));
    }
    const first = await f.translations.resources(f.b, 'product', { first: 2 });
    expect(first.items.map((each) => each.content[0]!.value)).toEqual(['Kurta', 'Shawl']);
    expect(first.hasNextPage).toBe(true);
    const rest = await f.translations.resources(f.b, 'product', {
      first: 2,
      after: first.items[1]!.id,
    });
    expect(rest.items.map((each) => each.content[0]!.value)).toEqual(['Lawn']);
    expect(rest.hasNextPage).toBe(false);
  });
  it("finds products, pages and articles by the shop's Urdu for them, until it is removed (ADR-240)", async () => {
    const kurta = unwrap(
      await f.products.create(f.a, {
        title: 'Cotton Kurta',
        status: 'active',
        productType: 'Kurta',
        variants: [{ price: '2,500' }],
      }),
    );
    const search = (terms: string) =>
      f.db.tenant(f.a.shopId, (tx) => f.products.searchIdsOf(tx, f.a.shopId, terms, 10));
    expect(await search('کرتا')).toEqual([]);
    unwrap(
      await f.translations.register(f.a, 'product', kurta.id, [
        {
          locale: 'ur',
          key: 'title',
          value: 'سوتی کرتا',
          translatableContentDigest: digestOf('Cotton Kurta'),
        },
        {
          locale: 'ur',
          key: 'product_type',
          value: 'کرتے',
          translatableContentDigest: digestOf('Kurta'),
        },
      ]),
    );
    // By its Urdu, its type's too, a typo forgiven as in its own words; and by its own still.
    expect(await search('سوتی کرتا')).toEqual([kurta.id]);
    expect(await search('کرتے')).toEqual([kurta.id]);
    expect(await search('سوطی')).toEqual([kurta.id]);
    expect(await search('cotton kurta')).toEqual([kurta.id]);
    unwrap(await f.translations.remove(f.a, 'product', kurta.id, ['title'], ['ur']));
    expect(await search('سوتی')).toEqual([]);
    expect(await search('کرتے')).toEqual([kurta.id]);

    // A page by its Urdu text, and an article by its Urdu title.
    const about = unwrap(
      await f.pages.create(f.a, { title: 'About us', body: '<p>Since 1998.</p>' }),
    );
    const news = unwrap(await f.blogs.create(f.a, { title: 'News' }));
    const eid = unwrap(await f.articles.create(f.a, { blogId: news.id, title: 'Eid is here' }));
    unwrap(
      await f.translations.register(f.a, 'page', about.id, [
        {
          locale: 'ur',
          key: 'body_html',
          value: '<p>ملتان میں ہاتھ سے بنا۔</p>',
          translatableContentDigest: digestOf('<p>Since 1998.</p>'),
        },
      ]),
    );
    unwrap(
      await f.translations.register(f.a, 'article', eid.id, [
        {
          locale: 'ur',
          key: 'title',
          value: 'عید آ گئی',
          translatableContentDigest: digestOf('Eid is here'),
        },
      ]),
    );
    const content = (terms: string) =>
      f.db.tenant(f.a.shopId, (tx) => searchContentIn(tx, f.a.shopId, terms, { limit: 10 }));
    expect(await content('ملتان')).toEqual({ articleIds: [], pageIds: [about.id] });
    expect(await content('عید')).toEqual({ articleIds: [eid.id], pageIds: [] });
    expect(await content('since')).toEqual({ articleIds: [], pageIds: [about.id] });
  });

  it("keeps a product's options and their values in Urdu, naming the product (ADR-241)", async () => {
    // The other shop's, after its products are paged through, as the catalog stays between tests.
    const suit = unwrap(
      await f.products.create(f.b, {
        title: 'Lawn Suit',
        options: [
          { name: 'Size', values: ['Small', 'Large'] },
          { name: 'Colour', values: ['Red'] },
        ],
        variants: [
          { optionValues: ['Small', 'Red'], price: '4,990' },
          { optionValues: ['Large', 'Red'], price: '5,190' },
        ],
      }),
    );
    const size = suit.options[0]!;
    const [small, large] = [size.values[0]!, size.values[1]!];
    expect(await f.translations.resource(f.b, 'productOption', size.id)).toEqual({
      kind: 'productOption',
      id: size.id,
      content: [
        { key: 'name', value: 'Size', digest: digestOf('Size'), type: 'single_line_text_field' },
      ],
      translations: [],
    });
    // A name on one line, as long as the catalog's may be.
    const kept = unwrap(
      await f.translations.register(f.b, 'productOption', size.id, [
        {
          locale: 'ur',
          key: 'name',
          value: ' سائز\n',
          translatableContentDigest: digestOf('Size'),
        },
      ]),
    );
    expect(kept.map((each) => [each.key, each.value, each.outdated])).toEqual([
      ['name', 'سائز', false],
    ]);
    unwrap(
      await f.translations.register(f.b, 'productOptionValue', small.id, [
        { locale: 'ur', key: 'name', value: 'چھوٹا', translatableContentDigest: digestOf('Small') },
      ]),
    );
    const digest = digestOf('Large');
    expect(
      errorsOf(
        await f.translations.register(f.b, 'productOptionValue', large.id, [
          { locale: 'ur', key: 'title', value: 'بڑا', translatableContentDigest: digest },
          { locale: 'ur', key: 'name', value: 'ب'.repeat(256), translatableContentDigest: digest },
        ]),
      ),
    ).toEqual([
      [
        'translations.0.key',
        'INVALID',
        'Key title is not a field of an option value that can be translated: name',
      ],
      ['translations.1.value', 'TOO_LONG', 'Value is too long (maximum is 255 characters)'],
    ]);
    // Neither is anything else's: a product's ID names no option.
    expect(
      errorsOf(
        await f.translations.register(f.b, 'productOption', suit.id, [
          { locale: 'ur', key: 'name', value: 'سائز', translatableContentDigest: digestOf('Size') },
        ]),
      ),
    ).toEqual([['resourceId', 'NOT_FOUND', 'No such product option']]);

    // Each tells the storefront the product whose document shows it.
    expect(await events()).toEqual([
      [size.id, { kind: 'productOption', locales: ['ur'], keys: ['name'], productId: suit.id }],
      [
        small.id,
        { kind: 'productOptionValue', locales: ['ur'], keys: ['name'], productId: suit.id },
      ],
    ]);
    const given = await f.db.tenant(f.b.shopId, (tx) =>
      shopTranslationsOf(tx, f.b.shopId, [size.id, small.id, large.id]),
    );
    expect(given).toEqual(
      new Map([
        [size.id, { ur: { name: 'سائز' } }],
        [small.id, { ur: { name: 'چھوٹا' } }],
      ]),
    );

    // The shop's values, a page at a time, each once; another shop's are not among them.
    const first = await f.translations.resources(f.b, 'productOptionValue', { first: 2 });
    const rest = await f.translations.resources(f.b, 'productOptionValue', {
      first: 2,
      after: first.items[1]!.id,
    });
    expect([first.hasNextPage, rest.hasNextPage]).toEqual([true, false]);
    expect([...first.items, ...rest.items].map((each) => each.content[0]!.value).sort()).toEqual([
      'Large',
      'Red',
      'Small',
    ]);
    const options = await f.translations.resources(f.b, 'productOption', { first: 5 });
    expect(options.items.map((each) => each.content[0]!.value).sort()).toEqual(['Colour', 'Size']);
    expect(await f.translations.resource(f.a, 'productOption', size.id)).toBeNull();
  });
});
