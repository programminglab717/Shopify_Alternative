import { CsvError, parseCsv, toCsv } from '@hatti/csv';
import { money, toMajorString, type CurrencyCode } from '@hatti/money';
import { toHandle } from './handle.js';
import { LIMITS } from './input-checker.js';
import type { CreateProductInput } from './product.service.js';
import type { MediaRecord, ProductRecord } from './records.js';

/** How much one import takes: a file as customers' imports take it. */
export const PRODUCT_IMPORT_LIMITS = {
  /** Characters in the file. */
  csv: 1_500_000,
  rows: 5_000,
  /** Row errors the result lists; it counts them all. */
  rowErrors: 100,
} as const;

/**
 * The columns of Shopify's product CSV that the import reads, by the heading Shopify gives them.
 * Others, such as SEO titles or Google Shopping's, are left.
 */
const COLUMNS = {
  handle: 'Handle',
  title: 'Title',
  body: 'Body (HTML)',
  vendor: 'Vendor',
  type: 'Type',
  tags: 'Tags',
  published: 'Published',
  status: 'Status',
  option1Name: 'Option1 Name',
  option1Value: 'Option1 Value',
  option2Name: 'Option2 Name',
  option2Value: 'Option2 Value',
  option3Name: 'Option3 Name',
  option3Value: 'Option3 Value',
  sku: 'Variant SKU',
  grams: 'Variant Grams',
  tracker: 'Variant Inventory Tracker',
  quantity: 'Variant Inventory Qty',
  policy: 'Variant Inventory Policy',
  price: 'Variant Price',
  compareAtPrice: 'Variant Compare At Price',
  barcode: 'Variant Barcode',
  taxable: 'Variant Taxable',
  taxCode: 'Variant Tax Code',
  imageSrc: 'Image Src',
  imagePosition: 'Image Position',
  imageAlt: 'Image Alt Text',
  variantImage: 'Variant Image',
  giftCard: 'Gift Card',
  cost: 'Cost per item',
} as const;
type Column = keyof typeof COLUMNS;
/** A column of Shopify's product CSV the import reads, by its key. */
export type ShopifyColumn = Column;

const OPTION_COLUMNS = [
  ['option1Name', 'option1Value'],
  ['option2Name', 'option2Value'],
  ['option3Name', 'option3Value'],
] as const;

/** A product as Shopify's CSV gives it, over the rows that share its handle. */
export interface ShopifyProduct {
  /** Its handle, as its Shopify store had it: it keeps its address, /products/{handle}. */
  handle: string;
  /** The row it starts on, the header being row 1. */
  row: number;
  input: CreateProductInput & { handle: string };
  /** The row of each variant, in the order of `input.variants`. */
  variantRows: number[];
  /** In Shopify's order, each once. */
  images: { src: string; alt: string; row: number }[];
  /** Each variant's stock where Shopify tracked it, in `input.variants`' order; null where not. */
  stock: (ShopifyVariantStock | null)[];
  /** Each variant's own image, one of `images`, in `input.variants`' order; null where none. */
  variantImages: (string | null)[];
}

/** A variant's stock as a product CSV says it, where it is tracked. */
export interface ShopifyVariantStock {
  quantity: number;
  /** Sold when out of stock: Shopify's inventory policy `continue`. */
  continueSelling: boolean;
}

/** Something wrong with a row, said in the file's own terms. */
export interface ShopifyRowProblem {
  row: number;
  /** The file's heading, or null for the row as a whole. */
  column: string | null;
  message: string;
}

export type ShopifyFileResult =
  | {
      ok: true;
      rows: number;
      products: ShopifyProduct[];
      problems: ShopifyRowProblem[];
      /**
       * The columns the file has: one it lacks leaves a product it updates as it is, where a
       * blank cell clears the field.
       */
      columns: ReadonlySet<ShopifyColumn>;
    }
  | { ok: false; code: 'BLANK' | 'TOO_LONG' | 'INVALID' | 'TOO_MANY'; message: string };

/**
 * Reads a product CSV that Shopify exported (ONB-05): its rows grouped by handle into products,
 * the first row of each giving the product, the rows with option values or prices its variants,
 * and the rows with images its pictures. What the catalog cannot take, such as gift cards or
 * images at addresses that are not https, is said by row and column, and left out.
 */
export function readShopifyProducts(csv: string): ShopifyFileResult {
  if (csv.trim() === '') return { ok: false, code: 'BLANK', message: 'The file is empty' };
  if (csv.length > PRODUCT_IMPORT_LIMITS.csv) {
    return {
      ok: false,
      code: 'TOO_LONG',
      message: `The file is too long (at most ${PRODUCT_IMPORT_LIMITS.csv.toLocaleString('en')} characters)`,
    };
  }
  let table: string[][];
  try {
    table = parseCsv(csv);
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    return { ok: false, code: 'INVALID', message: `The file is not CSV: ${error.message}` };
  }
  const [header, ...records] = table;
  if (!header || records.length === 0) {
    return { ok: false, code: 'BLANK', message: 'The file has no products under its headings' };
  }
  if (records.length > PRODUCT_IMPORT_LIMITS.rows) {
    return {
      ok: false,
      code: 'TOO_MANY',
      message: `The file has ${records.length} rows; an import takes at most ${PRODUCT_IMPORT_LIMITS.rows.toLocaleString('en')}`,
    };
  }
  const headings = header.map(normalizeHeading);
  const index = new Map<Column, number>();
  for (const [key, heading] of Object.entries(COLUMNS) as [Column, string][]) {
    const at = headings.indexOf(normalizeHeading(heading));
    if (at >= 0) index.set(key, at);
  }
  if (!index.has('handle') || !index.has('title')) {
    return {
      ok: false,
      code: 'INVALID',
      message:
        "The file needs Handle and Title columns, as Shopify's product export has: " +
        'export products from Shopify as a CSV for Excel or plain CSV',
    };
  }

  const problems: ShopifyRowProblem[] = [];
  const say = (row: number, column: Column | null, message: string) =>
    problems.push({ row, column: column && COLUMNS[column], message });

  // Rows by handle, in the order handles first appear.
  const groups = new Map<string, { row: number; cells: (column: Column) => string }[]>();
  records.forEach((cells, position) => {
    const row = position + 2;
    const cell = (column: Column) => {
      const at = index.get(column);
      return at === undefined ? '' : (cells[at] ?? '').trim();
    };
    const raw = cell('handle');
    const handle = toHandle(raw);
    if (handle === '') {
      say(row, 'handle', raw === '' ? 'Handle is blank' : `"${raw}" is not a handle`);
      return;
    }
    const group = groups.get(handle) ?? [];
    group.push({ row, cells: cell });
    groups.set(handle, group);
  });

  const products: ShopifyProduct[] = [];
  for (const [handle, rows] of groups) {
    const first = rows[0]!;
    const main = first.cells;
    if (main('title') === '') {
      say(first.row, 'title', "Title is blank: a product's first row gives its title");
      continue;
    }
    if (main('giftCard').toLowerCase() === 'true') {
      say(first.row, 'giftCard', 'Gift cards are not imported: Hatti does not sell them yet');
      continue;
    }

    // Shopify writes Title / Default Title for a product without options.
    const names = OPTION_COLUMNS.map(([name]) => main(name));
    const plain =
      names[0]!.toLowerCase() === 'title' &&
      main('option1Value').toLowerCase() === 'default title' &&
      names[1] === '' &&
      names[2] === '';
    const optionCount = plain ? 0 : Math.max(0, ...names.map((name, at) => (name ? at + 1 : 0)));

    const variantRows = rows.filter(
      ({ cells }) => cells('option1Value') !== '' || cells('price') !== '' || cells('sku') !== '',
    );
    const values = OPTION_COLUMNS.slice(0, optionCount).map(() => new Map<string, string>());
    const variants: NonNullable<CreateProductInput['variants']> = [];
    const stock: ShopifyProduct['stock'] = [];
    for (const { row, cells } of variantRows) {
      const optionValues = OPTION_COLUMNS.slice(0, optionCount).map(([, column], at) => {
        const value = cells(column);
        if (value !== '' && !values[at]!.has(value.toLowerCase())) {
          values[at]!.set(value.toLowerCase(), value);
        }
        return value;
      });
      const grams = cells('grams');
      const weight = grams === '' ? undefined : Number(grams);
      if (weight !== undefined && !(Number.isFinite(weight) && weight >= 0)) {
        say(row, 'grams', `"${grams}" is not a weight in grams`);
      }
      variants.push({
        ...(optionCount > 0 && { optionValues }),
        price: cells('price'),
        ...(cells('compareAtPrice') !== '' && { compareAtPrice: cells('compareAtPrice') }),
        ...(cells('cost') !== '' && { cost: cells('cost') }),
        ...(cells('sku') !== '' && { sku: cells('sku') }),
        ...(cells('barcode') !== '' && { barcode: cells('barcode') }),
        // Shopify writes TRUE or FALSE; blank, its variants are taxed.
        ...(cells('taxable').toLowerCase() === 'false' && { taxable: false }),
        ...(cells('taxCode') !== '' && { taxCode: cells('taxCode') }),
        ...(weight !== undefined && Number.isFinite(weight) && weight >= 0
          ? { weightGrams: Math.round(weight) }
          : {}),
      });
      stock.push(stockOf(row, cells, say));
    }

    const images = imagesOf(rows, say);
    const pictured = new Set(images.map((image) => image.src));
    const variantImages = variantRows.map(({ cells }) =>
      pictured.has(cells('variantImage')) ? cells('variantImage') : null,
    );
    const status = statusOf(main('status'), main('published'));
    products.push({
      handle,
      row: first.row,
      input: {
        title: main('title'),
        handle,
        description: htmlToText(main('body')),
        ...(main('vendor') !== '' && { vendor: main('vendor') }),
        ...(main('type') !== '' && { productType: main('type') }),
        tags: main('tags')
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag !== ''),
        status,
        options: names
          .slice(0, optionCount)
          .map((name, at) => ({ name, values: [...values[at]!.values()] })),
        variants,
      },
      variantRows: variantRows.map(({ row }) => row),
      images,
      stock,
      variantImages,
    });
  }
  return { ok: true, rows: records.length, products, problems, columns: new Set(index.keys()) };
}

/**
 * The headings of the product CSV the export writes (CAT-05, ADR-129): Shopify's, in the order its
 * export gives them, so that Shopify's import and Hatti's both take the file. Those the import
 * leaves, such as Variant Fulfillment Service, say what Shopify asks of a product shipped by hand.
 */
export const SHOPIFY_PRODUCT_HEADINGS = [
  'Handle',
  'Title',
  'Body (HTML)',
  'Vendor',
  'Type',
  'Tags',
  'Published',
  'Option1 Name',
  'Option1 Value',
  'Option2 Name',
  'Option2 Value',
  'Option3 Name',
  'Option3 Value',
  'Variant SKU',
  'Variant Grams',
  'Variant Inventory Tracker',
  'Variant Inventory Qty',
  'Variant Inventory Policy',
  'Variant Fulfillment Service',
  'Variant Price',
  'Variant Compare At Price',
  'Variant Requires Shipping',
  'Variant Taxable',
  'Variant Barcode',
  'Image Src',
  'Image Position',
  'Image Alt Text',
  'Gift Card',
  'Variant Image',
  'Variant Weight Unit',
  'Variant Tax Code',
  'Cost per item',
  'Status',
] as const;
type Heading = (typeof SHOPIFY_PRODUCT_HEADINGS)[number];

/**
 * Products as Shopify's product CSV gives them (CAT-05, ADR-129), which `readShopifyProducts`
 * reads back: a product's rows share its handle, the first giving the product and its option
 * names, one row for each variant and each image, the n-th image on the n-th row, and as many
 * rows as it has variants or images, whichever is more. A product without options has Shopify's
 * Title / Default Title. Stock is given for the variants in `stock`, tracked; with `stock` null
 * no variant's is, and an import leaves stock alone.
 */
export function writeShopifyProducts(
  products: readonly ProductRecord[],
  currency: CurrencyCode,
  stock: ReadonlyMap<string, ShopifyVariantStock> | null,
  imageSrc: (media: MediaRecord, product: ProductRecord) => string = (media) => media.sourceUrl,
): { csv: string; rows: number } {
  const amount = (value: bigint | null) =>
    value === null ? '' : toMajorString(money(value, currency));
  // Stock goes in as a number, which the CSV writer leaves as it is: below zero, as text, it
  // would take an apostrophe against spreadsheets' formulas.
  const table: (string | number)[][] = [[...SHOPIFY_PRODUCT_HEADINGS]];
  for (const product of products) {
    const options = [...product.options].sort((a, b) => a.position - b.position).slice(0, 3);
    const variants = [...product.variants].sort((a, b) => a.position - b.position);
    const images = [...product.media].sort((a, b) => a.position - b.position);
    const imageOf = new Map(product.media.map((media) => [media.id, imageSrc(media, product)]));
    const rows = Math.max(variants.length, images.length, 1);
    for (let at = 0; at < rows; at++) {
      const cells: Partial<Record<Heading, string | number>> = { Handle: product.handle };
      if (at === 0) {
        Object.assign(cells, {
          Title: product.title,
          'Body (HTML)': textToHtml(product.description),
          Vendor: product.vendor ?? '',
          Type: product.productType ?? '',
          Tags: product.tags.join(', '),
          Published: product.status === 'active' ? 'TRUE' : 'FALSE',
          'Gift Card': 'FALSE',
          Status: product.status,
        });
        if (options.length === 0) cells['Option1 Name'] = 'Title';
        options.forEach((option, index) => {
          cells[`Option${index + 1} Name` as Heading] = option.name;
        });
      }
      const variant = variants[at];
      if (variant) {
        if (options.length === 0) cells['Option1 Value'] = 'Default Title';
        options.forEach((option, index) => {
          const selected = variant.selectedOptions.find((each) => each.optionId === option.id);
          cells[`Option${index + 1} Value` as Heading] = selected?.value ?? '';
        });
        const tracked = stock?.get(variant.id);
        const weighed = variant.weightGrams !== null;
        Object.assign(cells, {
          'Variant SKU': variant.sku ?? '',
          'Variant Grams': weighed ? String(variant.weightGrams) : '',
          'Variant Inventory Tracker': tracked ? 'shopify' : '',
          'Variant Inventory Qty': tracked ? tracked.quantity : '',
          'Variant Inventory Policy': tracked?.continueSelling ? 'continue' : 'deny',
          'Variant Fulfillment Service': 'manual',
          'Variant Price': amount(variant.price),
          'Variant Compare At Price': amount(variant.compareAtPrice),
          'Variant Requires Shipping': 'TRUE',
          'Variant Taxable': variant.taxable ? 'TRUE' : 'FALSE',
          'Variant Barcode': variant.barcode ?? '',
          'Variant Image': (variant.mediaId && imageOf.get(variant.mediaId)) ?? '',
          'Variant Weight Unit': weighed ? 'g' : '',
          'Variant Tax Code': variant.taxCode ?? '',
          'Cost per item': amount(variant.cost),
        });
      }
      const image = images[at];
      if (image) {
        Object.assign(cells, {
          'Image Src': imageOf.get(image.id)!,
          'Image Position': String(at + 1),
          'Image Alt Text': image.alt,
        });
      }
      table.push(SHOPIFY_PRODUCT_HEADINGS.map((heading) => cells[heading] ?? ''));
    }
  }
  return { csv: toCsv(table), rows: table.length - 1 };
}

/**
 * Shopify's Status column when the export has it; else Published: TRUE for a product on sale,
 * FALSE for a draft.
 */
function statusOf(status: string, published: string): 'active' | 'draft' | 'archived' {
  const named = status.toLowerCase();
  if (named === 'active' || named === 'draft' || named === 'archived') return named;
  return published.toLowerCase() === 'true' ? 'active' : 'draft';
}

/** A variant's stock where Shopify tracked it, whole and not below 0. */
function stockOf(
  row: number,
  cells: (column: Column) => string,
  say: (row: number, column: Column | null, message: string) => void,
): ShopifyProduct['stock'][number] {
  if (cells('tracker').toLowerCase() !== 'shopify' || cells('quantity') === '') return null;
  // A spreadsheet may keep the apostrophe before a quantity below zero.
  const quantity = Number(cells('quantity').replace(/^'/, ''));
  if (!Number.isInteger(quantity)) {
    say(row, 'quantity', `"${cells('quantity')}" is not a number of items`);
    return null;
  }
  return {
    quantity: Math.min(Math.max(quantity, 0), 100_000_000),
    continueSelling: cells('policy').toLowerCase() === 'continue',
  };
}

/**
 * The product's images, by Image Position, then variants' images it does not have yet; each
 * address once, and only https addresses, as the catalog takes them.
 */
function imagesOf(
  rows: { row: number; cells: (column: Column) => string }[],
  say: (row: number, column: Column | null, message: string) => void,
): ShopifyProduct['images'] {
  const found: { src: string; alt: string; row: number; position: number }[] = [];
  const seen = new Set<string>();
  const add = (row: number, column: Column, src: string, alt: string, position: number) => {
    if (src === '' || seen.has(src)) return;
    seen.add(src);
    if (!isHttpsUrl(src)) {
      say(row, column, `${src.slice(0, 80)} is not an https address; the image is left out`);
      return;
    }
    found.push({ src, alt: alt.slice(0, LIMITS.alt), row, position });
  };
  for (const { row, cells } of rows) {
    const position = Number(cells('imagePosition'));
    add(
      row,
      'imageSrc',
      cells('imageSrc'),
      cells('imageAlt'),
      Number.isFinite(position) && position > 0 ? position : Number.MAX_SAFE_INTEGER,
    );
  }
  for (const { row, cells } of rows) {
    add(row, 'variantImage', cells('variantImage'), '', Number.MAX_SAFE_INTEGER);
  }
  return found
    .map((image, order) => ({ ...image, order }))
    .sort((a, b) => a.position - b.position || a.order - b.order)
    .slice(0, LIMITS.media)
    .map(({ src, alt, row }) => ({ src, alt, row }));
}

function isHttpsUrl(value: string): boolean {
  if (value.length > LIMITS.url) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

function normalizeHeading(heading: string): string {
  return heading.trim().toLowerCase().replace(/\s+/g, ' ');
}

const NBSP = new RegExp(String.fromCharCode(160), 'g');

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: String.fromCharCode(0x2013),
  mdash: String.fromCharCode(0x2014),
  lsquo: String.fromCharCode(0x2018),
  rsquo: String.fromCharCode(0x2019),
  ldquo: String.fromCharCode(0x201c),
  rdquo: String.fromCharCode(0x201d),
  hellip: String.fromCharCode(0x2026),
  bull: String.fromCharCode(0x2022),
  copy: String.fromCharCode(0xa9),
  reg: String.fromCharCode(0xae),
  trade: String.fromCharCode(0x2122),
};

/**
 * Shopify's `Body (HTML)` as the plain text the catalog keeps for descriptions, which the
 * storefront shows as paragraphs: paragraphs and line breaks kept, list items on lines of their
 * own, every tag gone, entities read.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|table|blockquote|section)\s*>/gi, '\n\n')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text)
    .replace(NBSP, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A description, plain text as the catalog keeps it, as Shopify's `Body (HTML)`: a paragraph to
 * each run of text between blank lines, its line breaks kept, which `htmlToText` reads back.
 */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      // Characters, not control codes or halves of characters.
      const control = (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code < 160);
      return code > 0 && code <= 0x10ffff && !control && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '';
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}
