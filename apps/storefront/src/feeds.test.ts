import { MemoryStore, type ProductDoc } from '@hatti/storefront-data';
import { describe, expect, it } from 'vitest';
import { FEED_CHUNK, feedItems, productFeed } from './feeds.js';
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
