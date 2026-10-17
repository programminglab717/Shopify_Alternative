import { CsvError, parseCsv } from '@hatti/csv';
import { toHandle } from './handle.js';
import { LIMITS } from './input-checker.js';
import type { CreateProductInput } from './product.service.js';
import {
  PRODUCT_IMPORT_LIMITS,
  htmlToText,
  type ShopifyColumn,
  type ShopifyFileResult,
  type ShopifyProduct,
  type ShopifyRowProblem,
} from './shopify-csv.js';

// Products from a WooCommerce store's product export (ONB-06, ADR-482), as WooCommerce's own
// exporter writes them: a row for each simple or variable product, and a row for each variation
// naming its product in Parent. They become what Shopify's file would have made of the same shop,
// so the import goes on as it does for Shopify's (ADR-120).

/** The columns of WooCommerce's product CSV that the import reads, by their headings. */
const COLUMNS = {
  id: 'ID',
  type: 'Type',
  sku: 'SKU',
  name: 'Name',
  published: 'Published',
  short: 'Short description',
  description: 'Description',
  taxStatus: 'Tax status',
  inStock: 'In stock?',
  stock: 'Stock',
  backorders: 'Backorders allowed?',
  sale: 'Sale price',
  regular: 'Regular price',
  categories: 'Categories',
  tags: 'Tags',
  images: 'Images',
  parent: 'Parent',
  barcode: 'GTIN, UPC, EAN, or ISBN',
} as const;
type Column = keyof typeof COLUMNS;

/** Grams in one of each unit WooCommerce's Weight column may be in. */
const GRAMS = { kg: 1000, g: 1, lbs: 453.592, oz: 28.3495 } as const;
type WeightUnit = keyof typeof GRAMS;

const BOM = String.fromCharCode(0xfeff);

/** The most options a product has, as the catalog takes them. */
const OPTIONS = 3;

/** What of Shopify's columns the file says, for an import that updates products from it. */
const AS_SHOPIFY: Partial<Record<Column, ShopifyColumn[]>> = {
  name: ['title'],
  description: ['body'],
  categories: ['type'],
  tags: ['tags'],
  published: ['published'],
  regular: ['price', 'compareAtPrice'],
  sku: ['sku'],
  stock: ['quantity'],
  taxStatus: ['taxable'],
  images: ['imageSrc'],
  barcode: ['barcode'],
};

interface Row {
  row: number;
  cell: (column: Column) => string;
  /** Its attributes, by name, in the file's order: a variation's one value, a product's list. */
  attributes: { name: string; value: string }[];
  weightGrams: number | null | undefined;
}

/**
 * Reads a product CSV that WooCommerce exported (ONB-06): simple products with their one variant,
 * variable products with a variant for each of their variations' rows, their attributes the
 * options, at most three. Prices are its regular price, or its sale price with the regular one
 * the price compared at. A product's first category is its type, the others its tags with its
 * own. What the catalog cannot take, such as grouped or external products, is said by row and
 * column, and left out.
 */
export function readWooCommerceProducts(csv: string): ShopifyFileResult {
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
    // WooCommerce writes a byte-order mark before its headings.
    table = parseCsv(csv.startsWith(BOM) ? csv.slice(1) : csv);
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
  const headings = header.map((heading) => heading.trim().toLowerCase().replace(/\s+/g, ' '));
  const index = new Map<Column, number>();
  for (const [key, heading] of Object.entries(COLUMNS) as [Column, string][]) {
    const at = headings.indexOf(heading.toLowerCase());
    if (at >= 0) index.set(key, at);
  }
  if (!index.has('type') || !index.has('name')) {
    return {
      ok: false,
      code: 'INVALID',
      message:
        "The file needs Type and Name columns, as WooCommerce's product export has: in " +
        'WooCommerce, export products from Products > Export as a CSV',
    };
  }
  let weightAt = -1;
  let weightUnit: WeightUnit = 'kg';
  headings.forEach((heading, at) => {
    const unit = /^weight \((kg|g|lbs|oz)\)$/.exec(heading)?.[1] as WeightUnit | undefined;
    if (unit) {
      weightAt = at;
      weightUnit = unit;
    }
  });
  const attributeColumns: { name: number; value: number }[] = [];
  for (let n = 1; ; n++) {
    const name = headings.indexOf(`attribute ${n} name`);
    const value = headings.indexOf(`attribute ${n} value(s)`);
    if (name < 0 || value < 0) break;
    attributeColumns.push({ name, value });
  }

  const problems: ShopifyRowProblem[] = [];
  const say = (row: number, column: Column | string | null, message: string) =>
    problems.push({
      row,
      column: column === null ? null : (COLUMNS[column as Column] ?? column),
      message,
    });

  const rows: Row[] = records.map((cells, position) => {
    const row = position + 2;
    const cell = (column: Column) => {
      const at = index.get(column);
      return at === undefined ? '' : (cells[at] ?? '').trim();
    };
    const attributes = attributeColumns
      .map(({ name, value }) => ({
        name: (cells[name] ?? '').trim(),
        value: (cells[value] ?? '').trim(),
      }))
      .filter((attribute) => attribute.name !== '');
    const weight = weightAt < 0 ? '' : (cells[weightAt] ?? '').trim();
    let weightGrams: number | null | undefined;
    if (weight !== '') {
      const amount = Number(weight);
      if (Number.isFinite(amount) && amount >= 0) {
        weightGrams = Math.round(amount * GRAMS[weightUnit]);
      } else {
        weightGrams = null;
        say(row, header[weightAt]!.trim(), `"${weight}" is not a weight`);
      }
    }
    return { row, cell, attributes, weightGrams };
  });

  // Products, and the variations under each, by the ID or SKU their Parent names.
  const kinds = (row: Row) =>
    row
      .cell('type')
      .toLowerCase()
      .split(',')
      .map((kind) => kind.trim());
  const products: Row[] = [];
  const byReference = new Map<string, Row>();
  const variations = new Map<Row, Row[]>();
  const orphans: Row[] = [];
  for (const row of rows) {
    const kind = kinds(row);
    if (kind.includes('variation')) continue;
    if (kind.includes('simple') || kind.includes('variable')) {
      products.push(row);
      variations.set(row, []);
      if (row.cell('id') !== '') byReference.set(`id:${row.cell('id')}`, row);
      if (row.cell('sku') !== '') byReference.set(row.cell('sku').toLowerCase(), row);
    } else {
      say(
        row.row,
        'type',
        `${row.cell('type') || 'A product of no type'} is not a product Hatti sells; it is left out`,
      );
    }
  }
  for (const row of rows) {
    if (!kinds(row).includes('variation')) continue;
    const parent = row.cell('parent');
    const product =
      byReference.get(parent.toLowerCase()) ??
      byReference.get(parent.startsWith('id:') ? parent : `id:${parent}`);
    if (product && kinds(product).includes('variable')) variations.get(product)!.push(row);
    else orphans.push(row);
  }
  for (const orphan of orphans) {
    say(orphan.row, 'parent', 'Its variable product is not in the file; the variation is left out');
  }

  const handles = new Set<string>();
  const result: ShopifyProduct[] = [];
  for (const product of products) {
    const name = product.cell('name');
    if (name === '') {
      say(product.row, 'name', 'Name is blank');
      continue;
    }
    let handle = toHandle(name);
    if (handle === '') {
      say(product.row, 'name', `"${name}" makes no address`);
      continue;
    }
    for (let n = 2; handles.has(handle); n++) handle = `${toHandle(name)}-${n}`;
    handles.add(handle);

    const variable = kinds(product).includes('variable');
    const rowsOf = variable ? variations.get(product)! : [product];
    if (variable && rowsOf.length === 0) {
      say(product.row, 'type', 'A variable product without variations; it is left out');
      continue;
    }
    // Options: the attributes its variations say, in the product's order.
    const names: string[] = [];
    if (variable) {
      // A variation names each attribute it varies by, blank where any value will do.
      const said = new Set(
        rowsOf.flatMap((row) => row.attributes.map((a) => a.name.toLowerCase())),
      );
      for (const attribute of [...product.attributes, ...rowsOf.flatMap((row) => row.attributes)]) {
        const key = attribute.name.toLowerCase();
        if (said.has(key) && !names.some((each) => each.toLowerCase() === key)) {
          names.push(attribute.name);
        }
      }
      if (names.length > OPTIONS) {
        say(
          product.row,
          'Attribute 4 name',
          `Its variations differ by ${names.length} attributes; Hatti takes ${OPTIONS}`,
        );
        continue;
      }
    }

    const images: ShopifyProduct['images'] = [];
    const addImage = (row: Row, src: string) => {
      if (src === '' || images.some((image) => image.src === src)) return;
      if (!isHttpsUrl(src)) {
        say(
          row.row,
          'images',
          `${src.slice(0, 80)} is not an https address; the image is left out`,
        );
        return;
      }
      if (images.length < LIMITS.media) images.push({ src, alt: '', row: row.row });
    };
    for (const src of splitList(product.cell('images'))) addImage(product, src);

    const values = names.map(() => new Map<string, string>());
    const variants: NonNullable<CreateProductInput['variants']> = [];
    const variantRows: number[] = [];
    const stock: ShopifyProduct['stock'] = [];
    const variantImages: (string | null)[] = [];
    for (const row of rowsOf) {
      const optionValues = names.map((option, at) => {
        const value =
          row.attributes.find((a) => a.name.toLowerCase() === option.toLowerCase())?.value ?? '';
        if (value !== '' && !values[at]!.has(value.toLowerCase())) {
          values[at]!.set(value.toLowerCase(), value);
        }
        return value;
      });
      if (optionValues.some((value) => value === '')) {
        say(
          row.row,
          null,
          'A variation for any value of an attribute; give it one, it is left out',
        );
        continue;
      }
      // Its own price, else its product's, as a variation without one takes.
      const regular = row.cell('regular') || (variable ? '' : product.cell('regular'));
      const sale = row.cell('sale');
      const weight = row.weightGrams ?? (row === product ? undefined : product.weightGrams);
      variants.push({
        ...(names.length > 0 && { optionValues }),
        price: sale || regular,
        ...(sale !== '' && regular !== '' && { compareAtPrice: regular }),
        ...(row.cell('sku') !== '' && { sku: row.cell('sku') }),
        ...(row.cell('barcode') !== '' && { barcode: row.cell('barcode') }),
        ...((row.cell('taxStatus') || product.cell('taxStatus')).toLowerCase() === 'none' && {
          taxable: false,
        }),
        ...(typeof weight === 'number' && { weightGrams: weight }),
      });
      variantRows.push(row.row);
      stock.push(stockOf(row, say));
      const image = row === product ? '' : (splitList(row.cell('images'))[0] ?? '');
      addImage(row, image);
      variantImages.push(images.some((each) => each.src === image) ? image : null);
    }
    if (variants.length === 0) continue;

    const categories = splitList(product.cell('categories')).map((path) =>
      path.split('>').at(-1)!.trim(),
    );
    const tags = [...new Set([...splitList(product.cell('tags')), ...categories.slice(1)])];
    result.push({
      handle,
      row: product.row,
      input: {
        title: name,
        handle,
        description: htmlToText(product.cell('description') || product.cell('short')),
        ...(categories[0] && { productType: categories[0] }),
        tags,
        // Published: 1; 0 a draft, -1 private.
        status: product.cell('published') === '1' ? 'active' : 'draft',
        options: names.map((option, at) => ({ name: option, values: [...values[at]!.values()] })),
        variants,
      },
      variantRows,
      images,
      stock,
      variantImages,
    });
  }

  const columns = new Set<ShopifyColumn>();
  for (const key of index.keys()) for (const column of AS_SHOPIFY[key] ?? []) columns.add(column);
  if (weightAt >= 0) columns.add('grams');
  if (attributeColumns.length > 0) {
    for (const column of ['option1Name', 'option2Name', 'option3Name'] as const)
      columns.add(column);
  }
  problems.sort((a, b) => a.row - b.row);
  return { ok: true, rows: records.length, products: result, problems, columns };
}

/** A variation's stock where WooCommerce managed it: a whole number, not below 0. */
function stockOf(
  row: Row,
  say: (row: number, column: Column | string | null, message: string) => void,
): ShopifyProduct['stock'][number] {
  const text = row.cell('stock');
  if (text === '') return null;
  const quantity = Number(text);
  if (!Number.isInteger(quantity)) {
    say(row.row, 'stock', `"${text}" is not a number of items`);
    return null;
  }
  const backorders = row.cell('backorders').toLowerCase();
  return {
    quantity: Math.min(Math.max(quantity, 0), 100_000_000),
    continueSelling: backorders === '1' || backorders === 'notify' || backorders === 'yes',
  };
}

/** A cell of a list, as WooCommerce writes its images, categories and tags: comma-separated. */
function splitList(cell: string): string[] {
  return cell
    .split(',')
    .map((each) => each.trim())
    .filter((each) => each !== '');
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
