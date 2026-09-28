import { LOGIN_DEFAULTS, setupDatabase } from '@hatti/db';
import { TEST_LOGINS } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { searchKey } from '@hatti/pk';
import pg from 'pg';
import { Random } from './random.js';
import { LOGINS, type Settings } from './settings.js';

/**
 * Shops come in three sizes. Their UUIDs are built from a six-digit number, so pgbench scripts can
 * address a random shop of a given size with `\set n random(first, last)`.
 */
export type ShopSize = 'small' | 'medium' | 'large';

export interface ShopClass {
  size: ShopSize;
  count: number;
  products: readonly [min: number, max: number];
  /** Shop numbers first..last. */
  first: number;
  last: number;
}

const FIRST_SHOP_NUMBER = 100_000;

const CLASS_SPECS = {
  full: [
    { size: 'small', count: 850, products: [20, 200] },
    { size: 'medium', count: 140, products: [300, 2_500] },
    { size: 'large', count: 10, products: [10_000, 25_000] },
  ],
  smoke: [
    { size: 'small', count: 40, products: [20, 60] },
    { size: 'medium', count: 8, products: [300, 600] },
    { size: 'large', count: 2, products: [2_000, 3_000] },
  ],
} as const;

export function shopClasses(scale: Settings['scale']): ShopClass[] {
  let next = FIRST_SHOP_NUMBER;
  return CLASS_SPECS[scale].map((spec) => {
    const first = next;
    next += spec.count;
    return { ...spec, first, last: next - 1 };
  });
}

export function shopClass(scale: Settings['scale'], size: ShopSize): ShopClass {
  const found = shopClasses(scale).find((candidate) => candidate.size === size);
  if (!found) throw new Error(`No ${size} shops`);
  return found;
}

/** Shop number → UUID; the pgbench scripts build the same string. */
export function shopUuid(number: number): string {
  return `00000000-0000-7000-8000-000000${number}`;
}

/** Product number k (1-based) in a shop has the handle item-k, for point lookups. */
export function productHandle(k: number): string {
  return `item-${k}`;
}

/** Search words and roughly how often they appear in titles (see FABRICS and ITEMS). */
export const SEARCH_WORDS = { common: 'lawn', rare: 'organza' } as const;

/** On about 1% of products, for the index checks. */
export const RARE_TAG = 'clearance';

const ADJECTIVES = [
  'Embroidered',
  'Printed',
  'Digital Print',
  'Handmade',
  'Unstitched',
  'Stitched',
  'Luxury',
  'Festive',
  'Bridal',
  'Casual',
  'Classic',
  'Premium',
  'Summer',
  'Winter',
  'Chikankari',
  'Block Print',
  'Tie Dye',
  'Mirror Work',
  'Gota',
  'Zari',
];
const COLOURS = [
  'Maroon',
  'Mustard',
  'Teal',
  'Off White',
  'Black',
  'Navy',
  'Pink',
  'Emerald',
  'Beige',
  'Rust',
  'Lilac',
  'Olive',
  'Peach',
  'Sky Blue',
  'Ivory',
];
const FABRICS: readonly (readonly [string, number])[] = [
  ['Lawn', 14],
  ['Khaddar', 8],
  ['Cotton', 10],
  ['Chiffon', 6],
  ['Silk', 5],
  ['Linen', 5],
  ['Karandi', 3],
  ['Cambric', 4],
  ['Velvet', 3],
  ['Jacquard', 3],
  ['Marina', 2],
  ['Organza', 1],
  ['', 36],
];
type SizeRange = 'clothes' | 'shoes' | 'none';
const ITEMS: readonly (readonly [[name: string, type: string, sizes: SizeRange], number])[] = [
  [['Kameez', 'Ready to Wear', 'clothes'], 5],
  [['Qameez', 'Ready to Wear', 'clothes'], 2],
  [['Shalwar Kameez', 'Ready to Wear', 'clothes'], 4],
  [['Kurta', 'Ready to Wear', 'clothes'], 5],
  [['Kurti', 'Ready to Wear', 'clothes'], 4],
  [['Dupatta', 'Accessories', 'none'], 4],
  [['3 Piece Suit', 'Unstitched', 'none'], 8],
  [['2 Piece Suit', 'Unstitched', 'none'], 5],
  [['Chappal', 'Footwear', 'shoes'], 3],
  [['Khussa', 'Footwear', 'shoes'], 3],
  [['Peshawari Chappal', 'Footwear', 'shoes'], 2],
  [['Shawl', 'Accessories', 'none'], 3],
  [['Waistcoat', 'Menswear', 'clothes'], 2],
  [['Sherwani', 'Menswear', 'clothes'], 1],
  [['Lehenga', 'Bridal', 'clothes'], 1],
  [['Abaya', 'Modest Wear', 'clothes'], 2],
  [['Hijab', 'Modest Wear', 'none'], 2],
  [['Bedsheet', 'Home', 'none'], 3],
  [['Cushion Cover', 'Home', 'none'], 2],
  [['Tea Set', 'Home', 'none'], 1],
  [['Attar', 'Beauty', 'none'], 2],
  [['Mehndi Cone', 'Beauty', 'none'], 1],
  [['Bangles', 'Jewellery', 'none'], 2],
  [['Jhumka', 'Jewellery', 'none'], 2],
  [['Tote Bag', 'Accessories', 'none'], 1],
];
const VENDORS = [
  'Hatti Studio',
  'Karigar',
  'Lahore Looms',
  'Multan Crafts',
  'Sindh Weaves',
  'Peshawar Leather',
  'Quetta Crafts',
  'Faisalabad Textiles',
  'Hala Handicrafts',
  'Chitral Wool',
  'Hunza Home',
  'Swat Woodwork',
  'Bahawalpur Khussa',
];
const TAGS = [
  'eid',
  'new-arrival',
  'sale',
  'summer',
  'winter',
  'bestseller',
  'wedding',
  'ramzan',
  'limited-edition',
  'cod',
];
/** Merchant descriptions are HTML, often with a size chart: most are 0.5–1.5 KB. */
const DESCRIPTION_SECTIONS = [
  '<p>Shirt: embroidered front and back with printed sleeves. Dupatta: digital print on chiffon. ' +
    'Trouser: dyed cambric. Unstitched: 3 metres shirt, 2.5 metres dupatta, 2.5 metres trouser.</p>',
  '<p>Fabric: 100% cotton, pre-washed so it keeps its size. Colours can look slightly different ' +
    'on phone screens.</p>',
  '<h3>Size guide</h3><table><tr><th>Size</th><th>Chest</th><th>Length</th></tr>' +
    '<tr><td>S</td><td>19"</td><td>40"</td></tr><tr><td>M</td><td>20.5"</td><td>41"</td></tr>' +
    '<tr><td>L</td><td>22"</td><td>42"</td></tr><tr><td>XL</td><td>23.5"</td><td>43"</td></tr></table>',
  '<h3>Care</h3><ul><li>Hand wash cold, separately</li><li>Do not bleach</li>' +
    '<li>Iron on the reverse at medium heat</li></ul>',
  '<h3>Delivery</h3><p>Cash on delivery across Pakistan. Karachi, Lahore and Islamabad in 2–3 ' +
    'working days; other cities in 3–5. Exchanges within 7 days of delivery if the tags are ' +
    'intact.</p>',
];

const SIZES: Record<SizeRange, readonly string[]> = {
  clothes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
  shoes: ['6', '7', '8', '9', '10', '11'],
  none: ['Default'],
};

interface ProductRows {
  shopId: string[];
  id: string[];
  title: string[];
  handle: string[];
  status: string[];
  description: string[];
  vendor: (string | null)[];
  productType: string[];
  tags: string[];
  searchText: string[];
  createdAt: string[];
}

interface VariantRows {
  shopId: string[];
  id: string[];
  productId: string[];
  title: string[];
  sku: string[];
  barcode: (string | null)[];
  price: string[];
  compareAtPrice: (string | null)[];
  position: number[];
  createdAt: string[];
}

function emptyBatch(): { products: ProductRows; variants: VariantRows } {
  return {
    products: {
      shopId: [],
      id: [],
      title: [],
      handle: [],
      status: [],
      description: [],
      vendor: [],
      productType: [],
      tags: [],
      searchText: [],
      createdAt: [],
    },
    variants: {
      shopId: [],
      id: [],
      productId: [],
      title: [],
      sku: [],
      barcode: [],
      price: [],
      compareAtPrice: [],
      position: [],
      createdAt: [],
    },
  };
}

/** Rounds rupees to the nearest 50 and converts to paisa. */
function paisa(rupees: number): string {
  return String(Math.max(50, Math.round(rupees / 50) * 50) * 100);
}

function addShop(
  random: Random,
  batch: ReturnType<typeof emptyBatch>,
  shopNumber: number,
  productCount: number,
): void {
  const shopId = shopUuid(shopNumber);
  const vendors = random.sample(VENDORS, random.int(1, 4));
  const now = Date.now();
  for (let k = 1; k <= productCount; k++) {
    const [name, productType, sizeRange] = random.weighted(ITEMS);
    const fabric = random.weighted(FABRICS);
    const title = [
      random.chance(0.8) ? random.pick(ADJECTIVES) : '',
      random.chance(0.5) ? random.pick(COLOURS) : '',
      fabric,
      name,
    ]
      .filter(Boolean)
      .join(' ');
    const vendor = random.chance(0.9) ? random.pick(vendors) : null;
    const tags = random.sample(
      TAGS,
      random.weighted([
        [0, 30],
        [1, 30],
        [2, 25],
        [3, 10],
        [4, 5],
      ]),
    );
    if (random.chance(0.01)) tags.push(RARE_TAG);
    const createdAt = new Date(now - random.int(0, 730 * 24 * 3_600) * 1_000).toISOString();
    const productId = newId();
    const { products, variants } = batch;
    products.shopId.push(shopId);
    products.id.push(productId);
    products.title.push(title);
    products.handle.push(productHandle(k));
    products.status.push(
      random.weighted([
        ['active', 80],
        ['draft', 15],
        ['archived', 5],
      ]),
    );
    products.description.push(
      `<p>${title}${vendor ? ` by ${vendor}` : ''}. Made in Pakistan.</p>` +
        random.sample(DESCRIPTION_SECTIONS, random.int(1, DESCRIPTION_SECTIONS.length)).join(''),
    );
    products.vendor.push(vendor);
    products.productType.push(productType);
    products.tags.push(tags.join('|'));
    products.searchText.push(searchKey([title, vendor, productType, ...tags].join(' ')));
    products.createdAt.push(createdAt);

    const base = random.weighted([
      [random.int(500, 3_000), 50],
      [random.int(3_000, 10_000), 35],
      [random.int(10_000, 50_000), 15],
    ]);
    const sizes = SIZES[sizeRange];
    const count = Math.min(
      sizes.length,
      random.weighted([
        [1, 40],
        [2, 10],
        [3, 20],
        [4, 15],
        [5, 10],
        [6, 5],
      ]),
    );
    const start = random.int(0, sizes.length - count);
    for (let v = 0; v < count; v++) {
      const price = base * (1 + (random.next() - 0.5) * 0.2);
      variants.shopId.push(shopId);
      variants.id.push(newId());
      variants.productId.push(productId);
      variants.title.push(count === 1 && sizeRange === 'none' ? 'Default' : sizes[start + v]!);
      variants.sku.push(`${shopNumber}-${k}-${v + 1}`);
      variants.barcode.push(random.chance(0.2) ? String(random.int(1e12, 1e13 - 1)) : null);
      variants.price.push(paisa(price));
      variants.compareAtPrice.push(
        random.chance(0.25) ? paisa(price * (1.2 + random.next() * 0.3)) : null,
      );
      variants.position.push(v + 1);
      variants.createdAt.push(createdAt);
    }
  }
}

async function insertBatch(pool: pg.Pool, batch: ReturnType<typeof emptyBatch>): Promise<void> {
  const { products: p, variants: v } = batch;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO catalog.products
         (shop_id, id, title, handle, status, description, vendor, product_type, tags, search_text,
          created_at, updated_at)
       SELECT shop_id, id, title, handle, status, description, vendor, product_type,
              string_to_array(tags, '|'), search_text, created_at, created_at
         FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[],
                     $7::text[], $8::text[], $9::text[], $10::text[], $11::timestamptz[])
           AS t(shop_id, id, title, handle, status, description, vendor, product_type, tags,
                search_text, created_at)`,
      [
        p.shopId,
        p.id,
        p.title,
        p.handle,
        p.status,
        p.description,
        p.vendor,
        p.productType,
        p.tags,
        p.searchText,
        p.createdAt,
      ],
    );
    await client.query(
      `INSERT INTO catalog.variants
         (shop_id, id, product_id, title, sku, barcode, price, compare_at_price, position,
          created_at, updated_at)
       SELECT shop_id, id, product_id, title, sku, barcode, price, compare_at_price, position,
              created_at, created_at
         FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[],
                     $7::bigint[], $8::bigint[], $9::int[], $10::timestamptz[])
           AS t(shop_id, id, product_id, title, sku, barcode, price, compare_at_price, position,
                created_at)`,
      [
        v.shopId,
        v.id,
        v.productId,
        v.title,
        v.sku,
        v.barcode,
        v.price,
        v.compareAtPrice,
        v.position,
        v.createdAt,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface DatasetSummary {
  shops: { size: ShopSize; shops: number; products: number; variants: number }[];
  tables: { table: string; size: string }[];
  /** Share of products whose search text contains each search word. */
  searchSelectivity: Record<keyof typeof SEARCH_WORDS, number>;
  seconds: number;
}

/**
 * Recreates the benchmark database and loads it. Loads with the superuser, which bypasses
 * row-level security, in parallel batches.
 */
export async function loadDataset(
  settings: Settings,
  log: (message: string) => void,
): Promise<DatasetSummary> {
  const started = performance.now();
  const admin = new pg.Client({ connectionString: settings.adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `DROP DATABASE IF EXISTS ${admin.escapeIdentifier(settings.database)} WITH (FORCE)`,
    );
  } finally {
    await admin.end();
  }
  const login = (kind: keyof typeof TEST_LOGINS) => settings.url(TEST_LOGINS[kind], 'direct');
  await setupDatabase({
    adminUrl: settings.adminUrl,
    appUrl: login('app'),
    systemUrl: login('system'),
    identityUrl: login('identity'),
  });

  const pool = new pg.Pool({
    connectionString: settings.benchAdminUrl,
    max: 4,
    // Loading only: nothing here needs to survive a crash.
    options: '-c synchronous_commit=off',
  });
  try {
    const { user, password } = LOGINS.bypass;
    await pool.query(`
      DO $$
      BEGIN
        CREATE ROLE ${pg.escapeIdentifier(user)} LOGIN;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END
      $$`);
    await pool.query(
      `ALTER ROLE ${pg.escapeIdentifier(user)} WITH LOGIN BYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`,
    );
    await pool.query(`GRANT hatti_app_role TO ${pg.escapeIdentifier(user)}`);
    // The same session defaults as hatti_app, so the two logins differ only in BYPASSRLS.
    for (const [name, value] of Object.entries(LOGIN_DEFAULTS)) {
      await pool.query(
        `ALTER ROLE ${pg.escapeIdentifier(user)} SET ${name} = ${pg.escapeLiteral(value)}`,
      );
    }

    const random = new Random(20_260_928);
    const classes = shopClasses(settings.scale);
    const shopNumbers = classes.flatMap((c) =>
      Array.from({ length: c.count }, (_, i) => c.first + i),
    );
    await pool.query(
      `INSERT INTO control.shops (id, name)
       SELECT id, 'Bench shop ' || n FROM unnest($1::uuid[], $2::int[]) AS t(id, n)`,
      [shopNumbers.map(shopUuid), shopNumbers],
    );

    const inFlight = new Set<Promise<void>>();
    let batch = emptyBatch();
    let loaded = 0;
    const flush = async () => {
      if (batch.products.id.length === 0) return;
      const current = batch;
      batch = emptyBatch();
      const insert = insertBatch(pool, current).finally(() => inFlight.delete(insert));
      inFlight.add(insert);
      loaded += current.products.id.length;
      if (inFlight.size >= 4) await Promise.race(inFlight);
    };
    for (const shopClassSpec of classes) {
      for (let n = shopClassSpec.first; n <= shopClassSpec.last; n++) {
        addShop(random, batch, n, random.int(...shopClassSpec.products));
        if (batch.products.id.length >= 5_000) {
          await flush();
          if (loaded % 50_000 < 5_000) log(`  ${loaded.toLocaleString('en')} products loaded`);
        }
      }
    }
    await flush();
    await Promise.all(inFlight);
    log('  vacuuming and analysing');
    await pool.query('VACUUM (ANALYZE) control.shops, catalog.products, catalog.variants');

    const counts = await pool.query<{ n: number; products: string; variants: string }>(`
      SELECT substring(s.id::text from 25)::int AS n,
             (SELECT count(*) FROM catalog.products p WHERE p.shop_id = s.id) AS products,
             (SELECT count(*) FROM catalog.variants v WHERE v.shop_id = s.id) AS variants
        FROM control.shops s`);
    const shops = classes.map((c) => {
      const rows = counts.rows.filter((row) => row.n >= c.first && row.n <= c.last);
      return {
        size: c.size,
        shops: rows.length,
        products: rows.reduce((sum, row) => sum + Number(row.products), 0),
        variants: rows.reduce((sum, row) => sum + Number(row.variants), 0),
      };
    });
    const sizes = await pool.query<{ table: string; size: string }>(`
      SELECT c.relname AS table, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'catalog' AND c.relkind = 'r'
       ORDER BY c.relname`);
    const selectivity = await pool.query<{ common: string; rare: string }>(
      `SELECT avg((search_text LIKE $1)::int) AS common, avg((search_text LIKE $2)::int) AS rare
         FROM catalog.products`,
      [`%${SEARCH_WORDS.common}%`, `%${SEARCH_WORDS.rare}%`],
    );
    return {
      shops,
      tables: sizes.rows,
      searchSelectivity: {
        common: Number(selectivity.rows[0]?.common ?? 0),
        rare: Number(selectivity.rows[0]?.rare ?? 0),
      },
      seconds: (performance.now() - started) / 1_000,
    };
  } finally {
    await pool.end();
  }
}
