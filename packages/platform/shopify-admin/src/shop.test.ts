import { describe, expect, it } from 'vitest';
import { shopDomainOf } from './shop.js';

describe("A Shopify store's own address (ADR-749)", () => {
  it("takes the store's name, its address, a link to it, or a link to its admin", () => {
    for (const typed of [
      'zari-kurtas',
      ' Zari-Kurtas.myshopify.com ',
      'https://zari-kurtas.myshopify.com/admin/products',
      'admin.shopify.com/store/zari-kurtas/products',
    ]) {
      expect(shopDomainOf(typed)).toBe('zari-kurtas.myshopify.com');
    }
  });

  it('refuses any other host, so credentials go to Shopify alone', () => {
    for (const typed of [
      '',
      'zari.pk',
      'https://zari.pk/products',
      'zari-kurtas.myshopify.com.evil.example',
      'https://user:pass@zari-kurtas.myshopify.com',
      'https://zari-kurtas.myshopify.com:8443',
      'admin.shopify.com/apps/zari',
      'ftp://zari-kurtas.myshopify.com',
      '-zari.myshopify.com',
      'zari kurtas',
    ]) {
      expect(shopDomainOf(typed), typed).toBeNull();
    }
  });
});
