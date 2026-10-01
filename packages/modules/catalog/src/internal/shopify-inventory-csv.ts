import { CsvError, parseCsv, toCsv } from '@hatti/csv';
import { toHandle } from './handle.js';
import type { ProductRecord } from './records.js';
import { PRODUCT_IMPORT_LIMITS, type ShopifyRowProblem } from './shopify-csv.js';

/**
 * Shopify's inventory CSV's headings, in its order: its "All states" export (CAT-05, ADR-133),
 * a row for each variant at each location that stocks it.
 */
export const SHOPIFY_INVENTORY_HEADINGS = [
  'Handle',
  'Title',
  'Option1 Name',
  'Option1 Value',
  'Option2 Name',
  'Option2 Value',
  'Option3 Name',
  'Option3 Value',
  'SKU',
  'HS Code',
  'COO',
  'Location',
  'Bin name',
  'Incoming (not editable)',
  'Unavailable (not editable)',
  'Committed (not editable)',
  'Available (not editable)',
  'On hand (current)',
  'On hand (new)',
] as const;

type Heading = (typeof SHOPIFY_INVENTORY_HEADINGS)[number];

/** The largest quantity on hand, as the inventory module keeps it. */
const MAX_QUANTITY = 100_000_000;

/** A variant's stock at one location, as the inventory module counts it, for the file. */
export interface StockLevel {
  /** The location's name, which the file names it by. */
  location: string;
  onHand: number;
  committed: number;
  available: number;
  /** On hand but not for sale: held for checkouts, and kept back as safety stock. */
  unavailable: number;
}

/** A row of an inventory file that says how many of a variant a location has on hand now. */
export interface ShopifyCount {
  row: number;
  handle: string;
  /** In order, as the file wrote them; blank for those it left blank. */
  optionValues: string[];
  /** The location's name, as the file wrote it. */
  location: string;
  /** On hand when the file was exported, where it says. */
  current: number | null;
  /** On hand from now. */
  quantity: number;
}

export type ShopifyInventoryResult =
  | {
      ok: true;
      /** Rows under the headings. */
      rows: number;
      counts: ShopifyCount[];
      /** Rows whose On hand (new) is blank, which change nothing. */
      unchanged: number;
      problems: ShopifyRowProblem[];
    }
  | { ok: false; code: 'BLANK' | 'TOO_LONG' | 'INVALID' | 'TOO_MANY'; message: string };

/**
 * Shopify's inventory CSV of `products`: a row for each variant at each location `levels` gives
 * it, the products in the order given and their variants in theirs, each row naming its product
 * and variant in full; On hand (new) is left blank for a count to fill in.
 */
export function writeShopifyInventory(
  products: readonly ProductRecord[],
  levels: ReadonlyMap<string, readonly StockLevel[]>,
): { csv: string; rows: number } {
  // Quantities go in as numbers, which the CSV writer leaves as they are: one below zero, as
  // text, would take an apostrophe against spreadsheets' formulas.
  const table: (string | number)[][] = [[...SHOPIFY_INVENTORY_HEADINGS]];
  for (const product of products) {
    const options = [...product.options].sort((a, b) => a.position - b.position).slice(0, 3);
    const variants = [...product.variants].sort((a, b) => a.position - b.position);
    for (const variant of variants) {
      for (const level of levels.get(variant.id) ?? []) {
        const cells: Partial<Record<Heading, string | number>> = {
          Handle: product.handle,
          Title: product.title,
          SKU: variant.sku ?? '',
          Location: level.location,
          'Incoming (not editable)': 0,
          'Unavailable (not editable)': level.unavailable,
          'Committed (not editable)': level.committed,
          'Available (not editable)': level.available,
          'On hand (current)': level.onHand,
        };
        // Shopify writes Title / Default Title for a product without options.
        if (options.length === 0) {
          cells['Option1 Name'] = 'Title';
          cells['Option1 Value'] = 'Default Title';
        }
        options.forEach((option, index) => {
          const selected = variant.selectedOptions.find((each) => each.optionId === option.id);
          cells[`Option${index + 1} Name` as Heading] = option.name;
          cells[`Option${index + 1} Value` as Heading] = selected?.value ?? '';
        });
        table.push(SHOPIFY_INVENTORY_HEADINGS.map((heading) => cells[heading] ?? ''));
      }
    }
  }
  return { csv: toCsv(table), rows: table.length - 1 };
}

/**
 * Reads an inventory CSV, Shopify's or {@link writeShopifyInventory}'s: the rows that give On
 * hand (new), each with the product, variant and location it names, and On hand (current) where
 * the file has it. A blank On hand (new) changes nothing. Which product and location each row
 * names is for the caller to find; what is wrong with a row's own cells is said by row and
 * column.
 */
export function readShopifyInventory(csv: string): ShopifyInventoryResult {
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
    return { ok: false, code: 'BLANK', message: 'The file has no stock under its headings' };
  }
  if (records.length > PRODUCT_IMPORT_LIMITS.rows) {
    return {
      ok: false,
      code: 'TOO_MANY',
      message: `The file has ${records.length} rows; an import takes at most ${PRODUCT_IMPORT_LIMITS.rows.toLocaleString('en')}`,
    };
  }
  const headings = header.map((heading) => heading.trim().toLowerCase());
  const at = (heading: Heading) => headings.indexOf(heading.toLowerCase());
  if (at('Handle') < 0 || at('Location') < 0 || at('On hand (new)') < 0) {
    return {
      ok: false,
      code: 'INVALID',
      message:
        "The file needs Handle, Location and On hand (new) columns, as Shopify's inventory " +
        'export has: export inventory from Shopify, or from Hatti, with all its states',
    };
  }

  const problems: ShopifyRowProblem[] = [];
  const counts: ShopifyCount[] = [];
  let unchanged = 0;
  records.forEach((cells, position) => {
    const row = position + 2;
    const cell = (heading: Heading) => {
      const index = at(heading);
      return index < 0 ? '' : (cells[index] ?? '').trim();
    };
    const fresh = cell('On hand (new)');
    if (fresh === '') {
      unchanged += 1;
      return;
    }
    const say = (column: Heading | null, message: string) =>
      problems.push({ row, column, message });
    const raw = cell('Handle');
    const handle = toHandle(raw);
    if (handle === '') {
      say('Handle', raw === '' ? 'Handle is blank' : `"${raw}" is not a handle`);
      return;
    }
    const location = cell('Location');
    if (location === '') {
      say('Location', 'Location is blank: a row counts stock at one location');
      return;
    }
    const quantity = wholeNumber(fresh);
    if (quantity === null || quantity < 0 || quantity > MAX_QUANTITY) {
      say('On hand (new)', `On hand (new) must be a whole number from 0, not "${fresh}"`);
      return;
    }
    const was = cell('On hand (current)');
    const current = was === '' ? null : wholeNumber(was);
    if (current === null && was !== '') {
      say('On hand (current)', `On hand (current) must be a whole number, not "${was}"`);
      return;
    }
    counts.push({
      row,
      handle,
      optionValues: [cell('Option1 Value'), cell('Option2 Value'), cell('Option3 Value')],
      location,
      current,
      quantity,
    });
  });
  return { ok: true, rows: records.length, counts, unchanged, problems };
}

/**
 * A cell's whole number, with Excel's thousands separators, and the apostrophe a spreadsheet may
 * keep before one below zero; null if it is none.
 */
function wholeNumber(text: string): number | null {
  const plain = text.replace(/^'/, '').replace(/,/g, '');
  if (!/^-?\d{1,10}$/.test(plain)) return null;
  return Number(plain);
}
