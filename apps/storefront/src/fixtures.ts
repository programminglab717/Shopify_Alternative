import {
  DOCUMENTS_VERSION,
  type CollectionDoc,
  type MenuLinkDoc,
  type PageDoc,
  type ProductDoc,
  type StoreDocuments,
  type VariantDoc,
} from '@hatti/storefront-data';

/**
 * A fashion shop's documents, the same every time: 200 products in three collections, with the
 * options, variants and images such shops have, and one heavy product (three options, 100
 * variants, 10 images) for the product page at its worst.
 */
export function sampleStore(): StoreDocuments {
  const random = seeded(2026);
  const products: ProductDoc[] = [];
  const collections: CollectionDoc[] = [];

  const lines: {
    handle: string;
    title: string;
    count: number;
    name: (index: number) => string;
    options: { name: string; values: string[] }[];
    price: [number, number];
    type: string;
  }[] = [
    {
      handle: 'eid-lawn',
      title: 'Eid Lawn',
      count: 80,
      name: (index: number) => `${pick(random, FABRICS)} Lawn ${pick(random, STYLES)} ${index + 1}`,
      options: [
        { name: 'Colour', values: ['Mint', 'Rose', 'Ivory'] },
        { name: 'Pieces', values: ['2-piece', '3-piece'] },
      ],
      price: [3_500, 9_500],
      type: 'Unstitched suit',
    },
    {
      handle: 'khussa',
      title: 'Khussas',
      count: 60,
      name: (index: number) => `${pick(random, CITIES)} Khussa ${index + 1}`,
      options: [
        { name: 'Size', values: ['36', '37', '38', '39', '40', '41'] },
        { name: 'Colour', values: ['Gold', 'Maroon', 'Black'] },
      ],
      price: [1_800, 4_500],
      type: 'Footwear',
    },
    {
      handle: 'mens-kurta',
      title: "Men's Kurtas",
      count: 60,
      name: (index: number) => `${pick(random, FABRICS)} Kurta ${index + 1}`,
      options: [
        { name: 'Size', values: ['S', 'M', 'L', 'XL', 'XXL'] },
        { name: 'Colour', values: ['White', 'Black', 'Navy', 'Olive'] },
      ],
      price: [2_200, 6_000],
      type: 'Kurta',
    },
  ];

  for (const line of lines) {
    const ids: string[] = [];
    for (let index = 0; index < line.count; index += 1) {
      const title = line.name(index);
      const product = makeProduct(random, {
        id: `p-${line.handle}-${index + 1}`,
        handle: `${handleOf(title)}-${line.handle}`,
        title,
        type: line.type,
        options: line.options,
        price: line.price,
        images: 5,
      });
      products.push(product);
      ids.push(product.id);
    }
    collections.push({
      id: `c-${line.handle}`,
      handle: line.handle,
      title: line.title,
      descriptionHtml: `<p>${line.title}, made in Pakistan and delivered across the country.</p>`,
      image: null,
      productIds: ids,
    });
  }

  const heavy = makeProduct(random, {
    id: 'p-heavy',
    handle: 'bridal-lehenga-heavy',
    title: 'Bridal Lehenga, Hand-embellished',
    type: 'Bridal',
    options: [
      { name: 'Size', values: ['XS', 'S', 'M', 'L', 'XL'] },
      { name: 'Colour', values: ['Red', 'Maroon', 'Gold', 'Pink', 'Ivory'] },
      { name: 'Fabric', values: ['Chiffon', 'Organza', 'Velvet', 'Silk'] },
    ],
    price: [85_000, 250_000],
    images: 10,
  });
  products.push(heavy);
  collections.push({
    id: 'c-all',
    handle: 'all',
    title: 'All products',
    descriptionHtml: '',
    image: null,
    productIds: products.map((product) => product.id),
  });

  return {
    shop: {
      version: DOCUMENTS_VERSION,
      name: 'Zari Fashions',
      handle: 'zari',
      domain: 'zari.hatti.pk',
      whatsapp: '+923001234567',
      cod: { available: true, fee: 0, limit: 5_000_000 },
      delivery: {
        charge: 25_000,
        freeAbove: 500_000,
        zones: [{ name: 'Lahore', cities: ['Lahore'], charge: 15_000 }],
      },
      theme: null,
    },
    products,
    collections,
    menus: [
      {
        handle: 'main-menu',
        title: 'Main menu',
        links: [
          link('Eid Lawn', '/collections/eid-lawn', 'collection_link'),
          link('Khussas', '/collections/khussa', 'collection_link'),
          link("Men's Kurtas", '/collections/mens-kurta', 'collection_link'),
          link('All', '/collections/all', 'catalog_link'),
        ],
      },
      {
        handle: 'footer',
        title: 'Footer',
        links: [
          link('Returns and exchanges', '/pages/returns', 'page_link'),
          link('Delivery', '/pages/delivery', 'page_link'),
          link('Contact us', '/pages/contact', 'page_link'),
        ],
      },
    ],
    pages: SAMPLE_PAGES,
  };
}

const PUBLISHED = '2026-09-01T09:00:00.000Z';

/** The sample shop's pages, as a shop writes them: its footer links to each. */
const SAMPLE_PAGES: PageDoc[] = [
  {
    id: 'pg-returns',
    handle: 'returns',
    title: 'Returns and exchanges',
    bodyHtml:
      '<p>Changed your mind? Send it back within <strong>7 days</strong> of delivery, unworn ' +
      'and with its tags, and we exchange it or refund you.</p>' +
      '<ul><li>Stitched suits are exchanged for size only.</li>' +
      '<li>Sale items are final.</li></ul>',
    templateSuffix: null,
    publishedAt: PUBLISHED,
  },
  {
    id: 'pg-delivery',
    handle: 'delivery',
    title: 'Delivery',
    bodyHtml:
      '<p>We deliver across Pakistan in 2 to 5 days, and you pay cash on delivery.</p>' +
      '<table><tr><th scope="row">Lahore</th><td>Rs 150</td></tr>' +
      '<tr><th scope="row">Everywhere else</th><td>Rs 250</td></tr></table>' +
      '<p>Free on orders of Rs 5,000 or more.</p>',
    templateSuffix: null,
    publishedAt: PUBLISHED,
  },
  {
    id: 'pg-contact',
    handle: 'contact',
    title: 'Contact us',
    bodyHtml:
      '<p>Call or WhatsApp <a href="https://wa.me/923001234567">0300 1234567</a>, 10 am to ' +
      '8 pm, or visit us at Liberty Market, Lahore.</p>' +
      '<p dir="rtl" lang="ur">ہم سے رابطہ کریں: 0300 1234567</p>',
    templateSuffix: null,
    publishedAt: PUBLISHED,
  },
];

const FABRICS = ['Chikankari', 'Embroidered', 'Printed', 'Jacquard', 'Khaddar', 'Cotton'];
const STYLES = ['Suit', 'Set', 'Collection'];
const CITIES = ['Multani', 'Peshawari', 'Lahori', 'Hyderabadi'];

function makeProduct(
  random: () => number,
  spec: {
    id: string;
    handle: string;
    title: string;
    type: string;
    options: { name: string; values: string[] }[];
    price: [number, number];
    images: number;
  },
): ProductDoc {
  const base = Math.round((spec.price[0] + random() * (spec.price[1] - spec.price[0])) / 50) * 50;
  const onSale = random() < 0.25;
  const variants: VariantDoc[] = combinations(spec.options.map((option) => option.values)).map(
    (values, index) => ({
      id: `${spec.id}-v${index + 1}`,
      title: values.join(' / '),
      sku: `${spec.id.toUpperCase()}-${index + 1}`,
      // In paisa. Larger sizes and costlier fabrics cost a little more.
      price: (base + (index % 3) * 100) * 100,
      compareAtPrice: onSale ? Math.round((base * 1.25) / 50) * 50 * 100 : null,
      available: random() > 0.15,
      options: values,
      image: index % spec.images,
    }),
  );
  return {
    id: spec.id,
    handle: spec.handle,
    title: spec.title,
    descriptionHtml:
      `<p>${spec.title}: soft, breathable and made to last. Stitched by hand in Pakistan.</p>` +
      '<ul><li>Fabric: premium cotton lawn</li><li>Care: hand wash cold, dry in shade</li>' +
      '<li>Delivery in 2 to 5 days; cash on delivery everywhere</li></ul>' +
      '<p>Colours may look slightly different on screen. Ask us on WhatsApp for more photos.</p>',
    vendor: 'Zari',
    productType: spec.type,
    tags: [spec.type.toLowerCase(), onSale ? 'sale' : 'new'],
    options: spec.options,
    variants,
    images: Array.from({ length: spec.images }, (_, index) => ({
      src: `/images/products/${spec.handle}-${index + 1}.jpg`,
      width: 1100,
      height: 1375,
      alt: `${spec.title}, photo ${index + 1}`,
    })),
  };
}

function combinations(lists: readonly (readonly string[])[]): string[][] {
  return lists.reduce<string[][]>(
    (combined, values) => combined.flatMap((prefix) => values.map((value) => [...prefix, value])),
    [[]],
  );
}

function handleOf(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)]!;
}

/** mulberry32: small, fast and the same on every machine. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function link(title: string, url: string, type = 'http_link'): MenuLinkDoc {
  return { title, url, type, links: [] };
}
