import { describe, expect, it } from 'vitest';
import { parseOrderSearch } from './order-filter.js';

describe('Orders searches', () => {
  it("reads filters among the words, as Shopify's search syntax writes them", () => {
    expect(parseOrderSearch('stage:TO_PACK  Ayesha -tag:"Gift wrap" 0300 1234567')).toEqual({
      ok: true,
      value: {
        filters: [
          { key: 'stage', value: 'to_pack', negated: false },
          // A tag as written: tags match in any letter case.
          { key: 'tag', value: 'Gift wrap', negated: true },
        ],
        terms: 'Ayesha 0300 1234567',
      },
    });
    // A phrase in quotes, an order number and words with a colon in them stay words.
    expect(parseOrderSearch('"Gulshan e Iqbal" #1001 10:30 Block5:A')).toEqual({
      ok: true,
      value: { filters: [], terms: 'Gulshan e Iqbal #1001 10:30 Block5:A' },
    });
    expect(parseOrderSearch('')).toEqual({ ok: true, value: { filters: [], terms: '' } });
  });

  it('refuses a filter it does not know, or a value its filter does not take', () => {
    expect(parseOrderSearch('stag:to_pack')).toEqual({
      ok: false,
      error:
        "Orders can't be filtered by stag; filters are stage, status, confirmation_status, " +
        'financial_status, fulfillment_status, payment_method, source, risk_level, tag, ' +
        'has_transfer_receipt',
    });
    expect(parseOrderSearch('risk_level:extreme')).toEqual({
      ok: false,
      error: 'risk_level is one of low, medium, high, not extreme',
    });
    expect(parseOrderSearch('tag:')).toEqual({
      ok: false,
      error: 'Give tag a value, such as tag:vip',
    });
    expect(parseOrderSearch('has_transfer_receipt:yes')).toEqual({
      ok: false,
      error: 'has_transfer_receipt is one of true, false, not yes',
    });
  });
});
