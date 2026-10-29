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

  it('rounds prices and compare-at prices as the store asks, costs left exact (ADR-933)', () => {
    const csv = toCsv([
      ['Handle', 'Variant Price', 'Variant Compare At Price', 'Cost per item'],
      ['kurta', '2500.00', '3000.00', '1200.00'],
    ]);
    // At 0.0131 with 5% over it: AED 34.39 and 41.27; the cost AED 15.72 at the rate alone.
    const at = (rounding: 'exact' | 'whole' | 'ninety_nine') =>
      parseCsv(rescaledShopifyPrices(csv, 0.0131, { rounding, marginPercent: 5 }))[1]!.slice(1);
    expect(at('exact')).toEqual(['34.39', '41.27', '15.72']);
    expect(at('whole')).toEqual(['34.00', '41.00', '15.72']);
    expect(at('ninety_nine')).toEqual(['34.99', '41.99', '15.72']);
  });
});
