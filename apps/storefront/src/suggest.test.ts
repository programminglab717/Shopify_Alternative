import { describe, expect, it } from 'vitest';
import { sampleStore } from './fixtures.js';
import { suggestJson, suggestParams, suggestWanted } from './suggest.js';

const params = (query: string) => suggestParams(new URLSearchParams(query));

describe('Predictive search', () => {
  it("reads Shopify's parameters, within its bounds", () => {
    expect(params('q=+lawn+')).toEqual({
      terms: 'lawn',
      types: ['query', 'product', 'collection', 'page'],
      limit: 10,
      unavailable: 'last',
    });
    expect(
      params(
        'q=x&resources[type]=product,article,video&resources[limit]=50' +
          '&resources[options][unavailable_products]=hide',
      ),
    ).toEqual({ terms: 'x', types: ['product', 'article'], limit: 10, unavailable: 'hide' });
    expect(params('q=x&resources[limit]=0').limit).toBe(1);
    expect(params('q=x&resources[limit]=four').limit).toBe(10);

    // More are asked of the core when the sold out may go; none without words, or products.
    expect(suggestWanted(params('q=x&resources[limit]=4'))).toBe(8);
    const show = 'q=x&resources[limit]=4&resources[options][unavailable_products]=show';
    expect(suggestWanted(params(show))).toBe(4);
    expect(suggestWanted(params('q=+'))).toBe(0);
    expect(suggestWanted(params('q=x&resources[type]=page'))).toBe(0);
  });

  it("gives products as Shopify's JSON does, amounts in rupees", () => {
    const doc = sampleStore().products[0]!;
    const variant = { ...doc.variants[0]!, price: 250050, compareAtPrice: null, image: 0 };
    const product = { ...doc, variants: [variant] };
    const { resources } = suggestJson(params('q=x&resources[type]=product'), [product]);
    expect(resources.results).toEqual({
      products: [
        expect.objectContaining({
          id: doc.id,
          price: '2500.50',
          price_max: '2500.50',
          compare_at_price_max: '0.00',
          image: doc.images[0]!.src,
          variants: [
            expect.objectContaining({
              price: '2500.50',
              compare_at_price: null,
              url: `/products/${doc.handle}?variant=${variant.id}`,
              image: doc.images[0]!.src,
            }),
          ],
        }),
      ],
    });
  });
});
