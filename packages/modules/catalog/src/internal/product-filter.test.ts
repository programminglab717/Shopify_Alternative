import { describe, expect, it } from 'vitest';
import { parseProductSearch } from './product-filter.js';

describe('Products searches', () => {
  it("reads filters among the words, as Shopify's search syntax writes them", () => {
    expect(parseProductSearch('status:DRAFT lawn -vendor:"Gul Ahmed" sku:KRT-001')).toEqual({
      ok: true,
      value: {
        filters: [
          { key: 'status', value: 'draft', negated: false },
          // Values a filter takes any of, as written: they match in any letter case.
          { key: 'vendor', value: 'Gul Ahmed', negated: true },
          { key: 'sku', value: 'KRT-001', negated: false },
        ],
        terms: 'lawn',
      },
    });
  });

  it('refuses a filter it does not know, or a status there is not', () => {
    expect(parseProductSearch('colour:red')).toEqual({
      ok: false,
      error:
        "Products can't be filtered by colour; filters are status, vendor, product_type, tag, " +
        'sku, barcode, handle',
    });
    expect(parseProductSearch('status:published')).toEqual({
      ok: false,
      error: 'status is one of draft, active, archived, not published',
    });
    expect(parseProductSearch('vendor:')).toEqual({
      ok: false,
      error: 'Give vendor a value, such as vendor:Khaadi',
    });
  });
});
