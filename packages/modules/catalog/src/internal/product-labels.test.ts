import { describe, expect, it } from 'vitest';
import { ean13CheckDigit, labelsDocument, shopBarcode, type LabelFacts } from './product-labels.js';

const kurta: LabelFacts = {
  productTitle: 'Lawn kurta',
  variantTitle: 'M / Maroon',
  price: 450_000n,
  compareAtPrice: 520_000n,
  code: '2001234567893',
};

describe("Products' barcodes and labels (CAT-22, ADR-757)", () => {
  it("works out EAN-13's check digit, and makes the shop's own barcodes starting 2", () => {
    expect(ean13CheckDigit('400638133393')).toBe(1);
    expect(ean13CheckDigit('200123456789')).toBe(3);
    const digits = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(shopBarcode(() => digits.shift()!)).toBe('2001234567893');
    for (let at = 0; at < 50; at++) {
      const code = shopBarcode();
      expect(code).toMatch(/^2\d{12}$/);
      expect(Number(code[12])).toBe(ean13CheckDigit(code.slice(0, 12)));
    }
  });

  it('lays labels 24 to a sheet of A4, or one to a label of a roll, each with its price and bars', () => {
    const sheet = labelsDocument(
      Array.from({ length: 25 }, () => kurta),
      'a4',
      'PKR',
    );
    expect(sheet.match(/<article class="page">/g)).toHaveLength(2);
    expect(sheet.match(/<div class="tag">/g)).toHaveLength(25);
    expect(sheet).toContain('Rs 4,500');
    expect(sheet).toContain('<s>Rs 5,200</s>');
    expect(sheet).toContain('aria-label="2001234567893"');
    expect(sheet).toContain('M / Maroon');

    const plain: LabelFacts = {
      ...kurta,
      variantTitle: null,
      compareAtPrice: 400_000n,
      code: null,
    };
    const roll = labelsDocument([plain, plain], 'label_50x25', 'PKR');
    expect(roll.match(/<article class="page">/g)).toHaveLength(2);
    expect(roll).toContain('@page { size: 50mm 25mm; margin: 0; }');
    // A compare-at price no more than the price, and no code, show neither.
    expect(roll).not.toContain('<s>');
    expect(roll).not.toContain('class="barcode"');
    expect(roll).not.toContain('class="tag-variant"');
  });
});
