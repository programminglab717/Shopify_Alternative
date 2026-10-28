import { parseCsv, toCsv } from '@hatti/csv';
import { describe, expect, it } from 'vitest';
import { rescaledShopifyPrices } from './shopify-csv.js';

describe("Expansion stores' prices (CH-11, ADR-859)", () => {
  it('multiplies prices, compare-at prices and costs by the rate, to two places, and leaves the rest', () => {
    const csv = toCsv([
      [
        'Handle',
        'Title',
        'Variant Price',
        'Variant Compare At Price',
        'Cost per item',
        'Body (HTML)',
      ],
      ['kurta', 'Kurta', '2500.00', '3000.00', '1,200.00', '<p>Rs 2500, lawn</p>'],
      ['kurta', '', '2999.00', '', '', ''],
    ]);
    const rows = parseCsv(rescaledShopifyPrices(csv, 0.0036));
    expect(rows).toEqual([
      [
        'Handle',
        'Title',
        'Variant Price',
        'Variant Compare At Price',
        'Cost per item',
        'Body (HTML)',
      ],
      ['kurta', 'Kurta', '9.00', '10.80', '4.32', '<p>Rs 2500, lawn</p>'],
      ['kurta', '', '10.80', '', '', ''],
    ]);
    // The same currency keeps its prices.
    expect(parseCsv(rescaledShopifyPrices(csv, 1))[1]!.slice(2, 5)).toEqual([
      '2500.00',
      '3000.00',
      '1200.00',
    ]);
  });
});
