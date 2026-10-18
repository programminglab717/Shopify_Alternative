import { describe, expect, it } from 'vitest';
import { translatedProduct, type ProductDoc } from './index.js';

const KURTA: ProductDoc = {
  id: 'p-1',
  handle: 'kurta',
  title: 'Kurta',
  descriptionHtml: '',
  vendor: 'Zari',
  productType: 'Kurta',
  tags: [],
  options: [
    { name: 'Size', values: ['S', 'M'] },
    { name: 'Colour', values: ['Red'] },
  ],
  variants: ['S', 'M'].map((size) => ({
    id: `v-${size}`,
    title: `${size} / Red`,
    sku: null,
    price: 100_000,
    compareAtPrice: null,
    available: true,
    options: [size, 'Red'],
    image: null,
  })),
  images: [],
  translations: {
    ur: {
      options: [
        { name: 'سائز', values: ['چھوٹا', 'درمیانہ'] },
        { name: 'Colour', values: ['لال'] },
      ],
    },
  },
};

describe('A product on a page in another language', () => {
  it("shows its options in the language, a translated one's own name kept (ADR-568)", () => {
    const shown = translatedProduct(KURTA, 'ur');
    expect(shown.options).toEqual([
      { name: 'سائز', values: ['چھوٹا', 'درمیانہ'], ownName: 'Size' },
      { name: 'Colour', values: ['لال'] },
    ]);
    expect(shown.variants.map((variant) => variant.title)).toEqual([
      'چھوٹا / لال',
      'درمیانہ / لال',
    ]);
    // In its own language, as it is.
    expect(translatedProduct(KURTA, 'en')).toBe(KURTA);
  });
});
