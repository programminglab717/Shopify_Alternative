import { describe, expect, it } from 'vitest';
import { ShopifyAdmin } from './admin.js';
import { readStoreDiscounts } from './discounts.js';

const common = (title: string, codes: string[]) => ({
  title,
  status: 'ACTIVE',
  startsAt: '2026-03-01T00:00:00Z',
  endsAt: null,
  usageLimit: null,
  asyncUsageCount: 0,
  appliesOncePerCustomer: false,
  codesCount: { count: codes.length },
  codes: { nodes: codes.map((code) => ({ code })) },
});

const PAGES = [
  {
    pageInfo: { hasNextPage: true, endCursor: 'c1' },
    nodes: [
      {
        codeDiscount: {
          __typename: 'DiscountCodeBasic',
          ...common('Eid 10%', ['EID10']),
          usageLimit: 100,
          asyncUsageCount: 40,
          appliesOncePerCustomer: true,
          minimumRequirement: { greaterThanOrEqualToSubtotal: { amount: '3000.0' } },
          customerGets: {
            value: { percentage: 0.1 },
            items: { collections: { nodes: [{ handle: 'lawn' }] } },
          },
        },
      },
      {
        codeDiscount: {
          __typename: 'DiscountCodeFreeShipping',
          ...common('Free delivery', ['FREESHIP']),
          minimumRequirement: null,
        },
      },
    ],
  },
  {
    pageInfo: { hasNextPage: false, endCursor: 'c2' },
    nodes: [
      {
        codeDiscount: {
          __typename: 'DiscountCodeBxgy',
          ...common('Buy 2 get 1', ['B2G1']),
          customerBuys: {
            value: { quantity: '2' },
            items: {
              products: { nodes: [{ handle: 'lawn-suit' }] },
              productVariants: { nodes: [{ product: { handle: 'silk-dupatta' } }] },
            },
          },
          customerGets: {
            value: { quantity: { quantity: '1' }, effect: { percentage: 1 } },
            items: { allItems: true },
          },
        },
      },
      { codeDiscount: { __typename: 'DiscountCodeApp', ...common('By an app', ['APP']) } },
    ],
  },
];

const store = () => {
  const afters: (string | null)[] = [];
  const admin = new ShopifyAdmin({
    shop: 'zari-kurtas.myshopify.com',
    credentials: { accessToken: 't' },
    fetch: (async (_url: string, init?: RequestInit) => {
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { after: string | null };
      };
      if (query.includes('shop {')) {
        return new Response(
          JSON.stringify({ data: { shop: { name: 'Zari Kurtas', currencyCode: 'PKR' } } }),
        );
      }
      afters.push(variables?.after ?? null);
      return new Response(
        JSON.stringify({ data: { codeDiscountNodes: PAGES[afters.length - 1] } }),
      );
    }) as typeof fetch,
  });
  return { admin, afters };
};

describe("A store's discount codes through its Admin API (ADR-756)", () => {
  it('reads every page of them, each with its codes, value, items and minimum', async () => {
    const { admin, afters } = store();
    const read = await readStoreDiscounts(admin);
    expect(afters).toEqual([null, 'c1']);
    expect(read).toMatchObject({ ok: true, value: { storeName: 'Zari Kurtas', currency: 'PKR' } });
    const discounts = read.ok ? read.value.discounts : [];
    expect(discounts.map((each) => [each.kind, each.codes])).toEqual([
      ['DiscountCodeBasic', ['EID10']],
      ['DiscountCodeFreeShipping', ['FREESHIP']],
      ['DiscountCodeBxgy', ['B2G1']],
      ['DiscountCodeApp', ['APP']],
    ]);
    expect(discounts[0]).toMatchObject({
      title: 'Eid 10%',
      usageLimit: 100,
      used: 40,
      oncePerCustomer: true,
      percentage: 0.1,
      amount: null,
      minimumSubtotal: '3000.0',
      items: { collections: ['lawn'] },
      buyItems: null,
    });
    expect(discounts[2]).toMatchObject({
      buyQuantity: 2,
      getQuantity: 1,
      percentage: 1,
      buyItems: { products: ['lawn-suit', 'silk-dupatta'] },
      items: { all: true },
    });
  });
});
