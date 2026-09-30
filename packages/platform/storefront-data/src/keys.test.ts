import { describe, expect, it } from 'vitest';
import { pathTag, redirectKey } from './index.js';

describe("Shops' redirects by path", () => {
  it('keeps a path as the storefront looks it up, however a link wrote it', () => {
    expect(redirectKey('/Products/Old-Lawn/')).toBe('/products/old-lawn');
    expect(redirectKey('/pages//about///')).toBe('/pages/about');
    expect(redirectKey('/pages/%D8%B1%D8%A7%D8%A8%D8%B7%DB%81')).toBe('/pages/رابطہ');
    // Not decodable: kept as it came.
    expect(redirectKey('/100%-cotton')).toBe('/100%-cotton');
  });

  it("tags what is answered at a path with a short tag of the shop's", () => {
    const tag = pathTag('shop-1', '/pages/رابطہ');
    expect(tag).toMatch(/^hatti:shop-1:path:[\w-]{22}$/);
    expect(pathTag('shop-1', '/pages/رابطہ')).toBe(tag);
    expect(pathTag('shop-2', '/pages/رابطہ')).not.toBe(tag);
    expect(pathTag('shop-1', '/pages/about')).not.toBe(tag);
  });
});
