import { describe, expect, it } from 'vitest';
import { listingAddresses } from './report-page.js';

describe("A rights complaint's listings (ADR-474)", () => {
  it('finds product handles in whole addresses on the store and in paths, and the lines that are not', () => {
    expect(
      listingAddresses(
        [
          'https://zari.hatti.pk/products/Eid-Lawn?variant=2',
          'zari.pk/ur/products/khussa/',
          '  /collections/sale/products/shawl  ',
          '',
          'https://other.example/products/lawn',
          '/pages/about',
          'lawn',
          '/products/%E0%A4%A',
        ].join('\n'),
        ['zari.hatti.pk', 'zari.pk'],
      ),
    ).toEqual({
      found: [
        { handle: 'eid-lawn', line: 'https://zari.hatti.pk/products/Eid-Lawn?variant=2' },
        { handle: 'khussa', line: 'zari.pk/ur/products/khussa/' },
        { handle: 'shawl', line: '/collections/sale/products/shawl' },
      ],
      wrong: ['https://other.example/products/lawn', '/pages/about', 'lawn', '/products/%E0%A4%A'],
    });
  });
});
