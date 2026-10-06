import {
  MemoryStore,
  type ArticleDoc,
  type BlogDoc,
  type CollectionDoc,
  type ProductDoc,
} from '@hatti/storefront-data';
import { describe, expect, it } from 'vitest';
import {
  BLOG_FEED_ARTICLES,
  blogFeed,
  COLLECTION_FEED_PRODUCTS,
  collectionFeed,
  FEED_CHUNK,
  feedItems,
  productFeed,
} from './feeds.js';
import { sampleStore } from './fixtures.js';

const ORIGIN = 'https://www.zari.pk';
const SHOP = { name: 'Zari Fashions' };

/** Each item's fields, in order, as they are written: escaped. */
function itemsOf(xml: string): [string, string][][] {
  return [...xml.matchAll(/<item>(.*?)<\/item>/g)].map(([, body]) =>
    [...body!.matchAll(/<(g:[a-z_]+)>([^<]*)<\/\1>/g)].map(([, name, value]) => [name!, value!]),
  );
}

async function feedOf(store: Parameters<typeof productFeed>[0]): Promise<string> {
  let feed = '';
  for await (const part of productFeed(store, SHOP, ORIGIN)) feed += part;
  return feed;
}

const kurta: ProductDoc = {
  id: 'p-kurta',
  handle: 'chikankari-kurta',
  title: 'Chikankari Kurta',
  descriptionHtml: '<p>Embroidered in Lucknow &amp; Lahore.</p>\n<ul><li>Cotton</li></ul>',
  vendor: '',
  productType: 'Kurta',
  tags: [],
  options: [
    { name: 'Size', values: ['M', 'L'] },
    { name: 'Color', values: ['White'] },
  ],
  variants: [
    {
      id: 'v-m',
      title: 'M / White',
      sku: null,
      price: 349_900,
      compareAtPrice: 449_900,
      available: true,
      options: ['M', 'White'],
      image: null,
    },
    {
      id: 'v-l',
      title: 'L / White',
      sku: null,
      price: 369_900,
      compareAtPrice: 369_900,
      available: false,
      options: ['L', 'White'],
      image: 1,
    },
  ],
  images: [
    { src: '/images/products/kurta-1.jpg', width: 1600, height: 2000, alt: null },
    { src: 'https://cdn.example.com/kurta-2.jpg?v=7', width: 0, height: 0, alt: null },
  ],
};

describe('Catalog feeds', () => {
  it("lists a product's variants as Google's specification has them, grouped by the product", () => {
    const [medium, large] = itemsOf(feedItems(kurta, SHOP, ORIGIN));
    expect(medium).toEqual([
      ['g:id', 'v-m'],
      ['g:item_group_id', 'p-kurta'],
      ['g:title', 'Chikankari Kurta - M / White'],
      // Its description as text, and escaped again for XML.
      ['g:description', 'Embroidered in Lucknow &amp; Lahore. Cotton'],
      ['g:link', 'https://www.zari.pk/products/chikankari-kurta?variant=v-m'],
      // The image service's at the shop's address; an image by URL at its own, query kept.
      ['g:image_link', 'https://www.zari.pk/images/products/kurta-1.jpg?width=1200'],
      ['g:additional_image_link', 'https://cdn.example.com/kurta-2.jpg?v=7&amp;width=1200'],
      ['g:availability', 'in_stock'],
      // On sale: the price it was, then the price it is.
      ['g:price', '4499.00 PKR'],
      ['g:sale_price', '3499.00 PKR'],
      // Without a vendor, the shop's own.
      ['g:brand', 'Zari Fashions'],
      ['g:condition', 'new'],
      ['g:identifier_exists', 'no'],
      ['g:product_type', 'Kurta'],
      ['g:size', 'M'],
      ['g:color', 'White'],
    ]);
    // Its own image first; a price it was no higher is no sale.
    expect(Object.fromEntries(large!)).toMatchObject({
      'g:id': 'v-l',
      'g:image_link': 'https://cdn.example.com/kurta-2.jpg?v=7&amp;width=1200',
      'g:additional_image_link': 'https://www.zari.pk/images/products/kurta-1.jpg?width=1200',
      'g:availability': 'out_of_stock',
      'g:price': '3699.00 PKR',
    });
    expect(large!.map(([name]) => name)).not.toContain('g:sale_price');
  });

  it('gives a product of one variant no group, and leaves out a product without an image', () => {
    const control = String.fromCharCode(7);
    const shawl: ProductDoc = {
      ...kurta,
      title: `Pashmina <Shawl> & Stole${control}`,
      descriptionHtml: '',
      vendor: 'Kashmir House',
      productType: '',
      options: [{ name: 'Title', values: ['Default Title'] }],
      variants: [{ ...kurta.variants[0]!, compareAtPrice: null, options: ['Default Title'] }],
    };
    const [item] = itemsOf(feedItems(shawl, SHOP, ORIGIN));
    expect(item).toEqual([
      ['g:id', 'v-m'],
      // Escaped, and without the control characters XML has no place for.
      ['g:title', 'Pashmina &lt;Shawl&gt; &amp; Stole'],
      // Without a description, its title.
      ['g:description', 'Pashmina &lt;Shawl&gt; &amp; Stole'],
      ['g:link', 'https://www.zari.pk/products/chikankari-kurta?variant=v-m'],
      ['g:image_link', 'https://www.zari.pk/images/products/kurta-1.jpg?width=1200'],
      ['g:additional_image_link', 'https://cdn.example.com/kurta-2.jpg?v=7&amp;width=1200'],
      ['g:availability', 'in_stock'],
      ['g:price', '3499.00 PKR'],
      ['g:brand', 'Kashmir House'],
      ['g:condition', 'new'],
      ['g:identifier_exists', 'no'],
    ]);

    // Titles as long as Google takes; up to ten more images.
    const long: ProductDoc = {
      ...shawl,
      title: 'Lawn '.repeat(40),
      images: Array.from({ length: 12 }, (_, at) => ({ ...kurta.images[0]!, src: `/i/${at}.jpg` })),
    };
    const [fields] = itemsOf(feedItems(long, SHOP, ORIGIN));
    expect(Object.fromEntries(fields!)['g:title']).toHaveLength(150);
    expect(fields!.filter(([name]) => name === 'g:additional_image_link')).toHaveLength(10);

    expect(feedItems({ ...kurta, images: [] }, SHOP, ORIGIN)).toBe('');
  });

  it("sends a shop's products a chunk at a time, in the same order each time", async () => {
    const sample = sampleStore();
    const store = new MemoryStore(sample);
    const feed = await feedOf(store);

    expect(feed.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(feed).toContain(
      '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>\n' +
        '<title>Zari Fashions</title>\n<link>https://www.zari.pk/</link>\n' +
        '<description>Products of Zari Fashions</description>\n',
    );
    expect(feed.endsWith('</channel>\n</rss>\n')).toBe(true);
    const items = itemsOf(feed);
    expect(items).toHaveLength(
      sample.products.reduce((count, product) => count + product.variants.length, 0),
    );
    // Products by ID, each one's variants in their order.
    const groups = [...new Set(items.map((item) => Object.fromEntries(item)['g:item_group_id']))];
    expect(groups).toEqual(sample.products.map((product) => product.id).sort());
    // The IDs, then a round trip for each chunk of products.
    expect(sample.products.length).toBeGreaterThan(2 * FEED_CHUNK);
    expect(store.roundTrips).toBe(1 + Math.ceil(sample.products.length / FEED_CHUNK));
    expect(await feedOf(store.fresh())).toBe(feed);
  });

  it('skips a product gone since the IDs were read, and has a head and an end without products', async () => {
    const memory = new MemoryStore({ ...sampleStore(), products: [kurta] });
    const feed = await feedOf({
      productIds: async () => ['p-gone', ...(await memory.productIds())],
      products: (ids) => memory.products(ids),
    });
    expect(itemsOf(feed).map((item) => item[0]![1])).toEqual(['v-m', 'v-l']);

    const empty = await feedOf(new MemoryStore({ ...sampleStore(), products: [] }));
    expect(empty).not.toContain('<item>');
    expect(empty.endsWith('</description>\n</channel>\n</rss>\n')).toBe(true);
  });
});

describe("A blog's Atom feed (ADR-209)", () => {
  const NEWS = '0192d3a4-0000-7000-8000-000000000001';

  async function blogFeedOf(store: MemoryStore, blog: BlogDoc, now?: Date): Promise<string> {
    let feed = '';
    for await (const part of blogFeed(store, SHOP, blog, ORIGIN, now)) feed += part;
    return feed;
  }

  /** An article of News published on `day` of September, changed `changed` if said. */
  function article(n: number, day: number, changed?: string): ArticleDoc {
    return {
      id: `0192d3a4-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`,
      handle: `note-${n}`,
      blogHandle: 'news',
      title: `Note ${n}`,
      bodyHtml: `<p>Note ${n}</p>`,
      summaryHtml: '',
      author: '',
      tags: [],
      publishedAt: new Date(Date.UTC(2026, 8, day, 9)).toISOString(),
      templateSuffix: null,
      ...(changed ? { updatedAt: changed } : {}),
    };
  }

  function blogOf(articles: ArticleDoc[]): BlogDoc {
    return {
      id: NEWS,
      handle: 'news',
      title: 'News & notes',
      templateSuffix: null,
      articles: articles.map((each) => ({ id: each.id, tags: each.tags })),
    };
  }

  it('gives its articles, the newest first, each whole, linking to their pages at the shop', async () => {
    const eid: ArticleDoc = {
      ...article(1, 20, '2026-09-22T10:00:00.000Z'),
      handle: 'eid-lawn',
      title: 'Eid lawn <is> here',
      bodyHtml: '<p>Hand-block printed in Multan. <a href="sizes">Sizes</a></p>',
      summaryHtml: '<p>Out now &amp; stitched.</p>',
      author: 'Ayesha Khan',
      tags: ['Eid', 'Lawn & silk'],
    };
    const shawls = article(2, 5);
    const store = new MemoryStore({ ...sampleStore(), articles: [eid, shawls] });
    const feed = await blogFeedOf(store, blogOf([eid, shawls]));
    expect(feed).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<feed xmlns="http://www.w3.org/2005/Atom">\n' +
        `<id>urn:uuid:${NEWS}</id>\n` +
        '<link rel="alternate" type="text/html" href="https://www.zari.pk/blogs/news"/>\n' +
        '<link rel="self" type="application/atom+xml" href="https://www.zari.pk/blogs/news.atom"/>\n' +
        '<title>Zari Fashions - News &amp; notes</title>\n' +
        // When its articles last changed: the newest's edit, two days after it was published.
        '<updated>2026-09-22T10:00:00.000Z</updated>\n' +
        '<author><name>Zari Fashions</name></author>\n' +
        '<entry>\n' +
        `<id>urn:uuid:${eid.id}</id>\n` +
        '<published>2026-09-20T09:00:00.000Z</published>\n' +
        '<updated>2026-09-22T10:00:00.000Z</updated>\n' +
        '<link rel="alternate" type="text/html" href="https://www.zari.pk/blogs/news/eid-lawn"/>\n' +
        '<title>Eid lawn &lt;is&gt; here</title>\n' +
        '<author><name>Ayesha Khan</name></author>\n' +
        '<category term="Eid"/>\n<category term="Lawn &amp; silk"/>\n' +
        '<summary type="html" xml:base="https://www.zari.pk/blogs/news/eid-lawn">' +
        '&lt;p&gt;Out now &amp;amp; stitched.&lt;/p&gt;</summary>\n' +
        '<content type="html" xml:base="https://www.zari.pk/blogs/news/eid-lawn">' +
        '&lt;p&gt;Hand-block printed in Multan. &lt;a href=&quot;sizes&quot;&gt;Sizes&lt;/a&gt;' +
        '&lt;/p&gt;</content>\n' +
        '</entry>\n' +
        // Without an author or a summary, and written before documents said when it changed.
        '<entry>\n' +
        `<id>urn:uuid:${shawls.id}</id>\n` +
        '<published>2026-09-05T09:00:00.000Z</published>\n' +
        '<updated>2026-09-05T09:00:00.000Z</updated>\n' +
        '<link rel="alternate" type="text/html" href="https://www.zari.pk/blogs/news/note-2"/>\n' +
        '<title>Note 2</title>\n' +
        '<content type="html" xml:base="https://www.zari.pk/blogs/news/note-2">' +
        '&lt;p&gt;Note 2&lt;/p&gt;</content>\n' +
        '</entry>\n' +
        '</feed>\n',
    );
    // Its articles in one round trip.
    expect(store.roundTrips).toBe(1);
  });

  it(`holds the latest ${BLOG_FEED_ARTICLES} articles, says when an older one changed, and skips one gone`, async () => {
    const articles = Array.from({ length: 35 }, (_, index) => article(index + 1, 30 - index / 2));
    // An older article edited since is the last change; one gone since is left out.
    articles[20] = { ...articles[20]!, updatedAt: '2026-10-01T08:00:00.000Z' };
    const store = new MemoryStore({ ...sampleStore(), articles: articles.slice(1) });
    const feed = await blogFeedOf(store, blogOf(articles));
    const ids = [...feed.matchAll(/<entry>\n<id>urn:uuid:([^<]+)<\/id>/g)].map((match) => match[1]);
    expect(ids).toEqual(articles.slice(1, BLOG_FEED_ARTICLES).map((each) => each.id));
    expect(feed).toContain('<author><name>Zari Fashions</name></author>\n<entry>');
    expect(/<updated>([^<]+)<\/updated>/.exec(feed)![1]).toBe('2026-10-01T08:00:00.000Z');
    // An edit dated before its publication, as a publication date set later: then.
    const back = { ...articles[0]!, updatedAt: '2026-01-01T00:00:00.000Z' };
    const one = await blogFeedOf(
      new MemoryStore({ ...sampleStore(), articles: [back] }),
      blogOf([back]),
    );
    expect(one).toContain(
      `<published>${back.publishedAt}</published>\n<updated>${back.publishedAt}</updated>`,
    );
  });

  it('says a blog without articles changed now, and asks for none', async () => {
    const store = new MemoryStore({ ...sampleStore(), articles: [] });
    const now = new Date('2026-10-06T12:00:00.000Z');
    const feed = await blogFeedOf(store, blogOf([]), now);
    expect(feed).toContain('<updated>2026-10-06T12:00:00.000Z</updated>');
    expect(feed).not.toContain('<entry>');
    expect(feed.endsWith('</name></author>\n</feed>\n')).toBe(true);
    expect(store.roundTrips).toBe(0);
  });
});

describe("A collection's Atom feed (ADR-216)", () => {
  const LAWN = '0192d3a4-0000-7000-8000-000000000010';

  async function collectionFeedOf(
    store: MemoryStore,
    collection: CollectionDoc,
    now?: Date,
  ): Promise<string> {
    let feed = '';
    for await (const part of collectionFeed(store, SHOP, collection, ORIGIN, now)) feed += part;
    return feed;
  }

  function collectionOf(productIds: string[]): CollectionDoc {
    return {
      id: LAWN,
      handle: 'lawn',
      title: 'Lawn & silk',
      descriptionHtml: '',
      image: null,
      productIds,
    };
  }

  it("gives its products in its order, each with its variants in Shopify's namespace, linking to their pages", async () => {
    const dated: ProductDoc = {
      ...kurta,
      vendor: 'Zari',
      tags: ['Eid'],
      createdAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-20T10:00:00.000Z',
    };
    const store = new MemoryStore({ ...sampleStore(), products: [dated] });
    const feed = await collectionFeedOf(store, collectionOf([dated.id]));
    const summary =
      '<p><img src="https://www.zari.pk/images/products/kurta-1.jpg?width=600" ' +
      'alt="Chikankari Kurta"></p>' +
      '<p>Embroidered in Lucknow &amp; Lahore.</p>\n<ul><li>Cotton</li></ul>' +
      '<p>From Rs 3,499</p>';
    const escaped = summary
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    expect(feed).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:s="http://jadedpixel.com/-/spec/shopify">\n' +
        `<id>urn:uuid:${LAWN}</id>\n` +
        '<link rel="alternate" type="text/html" href="https://www.zari.pk/collections/lawn"/>\n' +
        '<link rel="self" type="application/atom+xml" href="https://www.zari.pk/collections/lawn.atom"/>\n' +
        '<title>Zari Fashions - Lawn &amp; silk</title>\n' +
        '<updated>2026-09-20T10:00:00.000Z</updated>\n' +
        '<author><name>Zari Fashions</name></author>\n' +
        '<entry>\n' +
        '<id>urn:uuid:p-kurta</id>\n' +
        '<published>2026-09-01T09:00:00.000Z</published>\n' +
        '<updated>2026-09-20T10:00:00.000Z</updated>\n' +
        '<link rel="alternate" type="text/html" href="https://www.zari.pk/products/chikankari-kurta"/>\n' +
        '<title>Chikankari Kurta</title>\n' +
        '<s:type>Kurta</s:type>\n' +
        '<s:vendor>Zari</s:vendor>\n' +
        '<category term="Eid"/>\n' +
        `<summary type="html">${escaped}</summary>\n` +
        '<s:variant><id>urn:uuid:v-m</id><title>M / White</title>' +
        '<s:price currency="PKR">3499.00</s:price>' +
        '<s:compare_at_price currency="PKR">4499.00</s:compare_at_price>' +
        '<s:sku></s:sku><s:available>true</s:available></s:variant>\n' +
        '<s:variant><id>urn:uuid:v-l</id><title>L / White</title>' +
        '<s:price currency="PKR">3699.00</s:price>' +
        '<s:compare_at_price currency="PKR">3699.00</s:compare_at_price>' +
        '<s:sku></s:sku><s:available>false</s:available></s:variant>\n' +
        '</entry>\n' +
        '</feed>\n',
    );
    // Its products in one round trip.
    expect(store.roundTrips).toBe(1);
  });

  it(`holds its first ${COLLECTION_FEED_PRODUCTS} products, skips one gone, and dates one without dates as the feed`, async () => {
    const products = Array.from({ length: 60 }, (_, index): ProductDoc => ({
      ...kurta,
      id: `p-${index + 1}`,
      handle: `kurta-${index + 1}`,
      variants: [kurta.variants[0]!],
      images: [],
      createdAt: '2026-09-01T09:00:00.000Z',
      updatedAt: new Date(Date.UTC(2026, 8, 1 + (index % 20))).toISOString(),
    }));
    // One written before documents had dates, and one gone since.
    const { createdAt: _made, updatedAt: _changed, ...undated } = products[3]!;
    products[3] = undated;
    const store = new MemoryStore({
      ...sampleStore(),
      products: products.filter((_, index) => index !== 5),
    });
    const feed = await collectionFeedOf(store, collectionOf(products.map((each) => each.id)));
    const ids = [...feed.matchAll(/<entry>\n<id>urn:uuid:([^<]+)<\/id>/g)].map((match) => match[1]);
    expect(ids).toEqual(
      products
        .slice(0, COLLECTION_FEED_PRODUCTS)
        .filter((_, index) => index !== 5)
        .map((each) => each.id),
    );
    const latest = '2026-09-20T00:00:00.000Z';
    expect(/<updated>([^<]+)<\/updated>/.exec(feed)![1]).toBe(latest);
    expect(feed).toContain(
      '<id>urn:uuid:p-4</id>\n' + `<published>${latest}</published>\n<updated>${latest}</updated>`,
    );
    // Without a picture, its summary is its description and price; one price alone.
    expect(feed).toContain(
      '<summary type="html">&lt;p&gt;Embroidered in Lucknow &amp;amp; Lahore.&lt;/p&gt;\n' +
        '&lt;ul&gt;&lt;li&gt;Cotton&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;Rs 3,499&lt;/p&gt;</summary>',
    );
    expect(store.roundTrips).toBe(1);
  });

  it('says a collection without products changed now, and asks for none', async () => {
    const store = new MemoryStore({ ...sampleStore(), products: [] });
    const now = new Date('2026-10-06T12:00:00.000Z');
    const feed = await collectionFeedOf(store, collectionOf([]), now);
    expect(feed).toContain('<updated>2026-10-06T12:00:00.000Z</updated>');
    expect(feed).not.toContain('<entry>');
    expect(feed.endsWith('</name></author>\n</feed>\n')).toBe(true);
    expect(store.roundTrips).toBe(0);
  });
});
