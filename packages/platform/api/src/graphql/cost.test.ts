import { buildSchema, parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import { QUERY_COST, actualQueryCost, requestedQueryCost } from './cost.js';

const schema = buildSchema(/* GraphQL */ `
  interface Node {
    id: ID!
  }
  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }
  enum ProductStatus {
    ACTIVE
    DRAFT
  }
  type Money {
    amount: String!
    currencyCode: String!
  }
  type Variant implements Node {
    id: ID!
    title: String!
    price: Money!
  }
  type VariantEdge {
    cursor: String!
    node: Variant!
  }
  type VariantConnection {
    edges: [VariantEdge!]!
    nodes: [Variant!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }
  type ProductOption {
    name: String!
    values: [String!]!
  }
  type Product implements Node {
    id: ID!
    title: String!
    status: ProductStatus!
    price: Money
    tags: [String!]!
    options: [ProductOption!]!
    variants(first: Int, last: Int, after: String): VariantConnection!
  }
  type ProductEdge {
    cursor: String!
    node: Product!
  }
  type ProductConnection {
    edges: [ProductEdge!]!
    nodes: [Product!]!
    pageInfo: PageInfo!
  }
  type Collection implements Node {
    id: ID!
    title: String!
  }
  union SearchResult = Product | Collection
  type Invoice {
    id: ID!
    number: String!
  }
  type Shop {
    name: String!
  }
  type MetaConnection {
    status: String!
    account: Shop
  }
  type Review {
    id: ID!
  }
  type ReviewPage {
    nodes: [Review!]!
    pageInfo: PageInfo!
  }
  type Query {
    shop: Shop!
    count: Int!
    product(id: ID!): Product
    products(first: Int, last: Int, query: String): ProductConnection!
    node(id: ID!): Node
    search(term: String!): [SearchResult!]!
    invoices(first: Int! = 20): [Invoice!]!
    recentProducts(first: Int): [Product!]!
    metaConnection: MetaConnection
    reviews(first: Int): ReviewPage!
  }
  type UserError {
    field: [String!]
    message: String!
  }
  type ProductCreatePayload {
    product: Product
    userErrors: [UserError!]!
  }
  type Mutation {
    productCreate(title: String!): ProductCreatePayload!
    productDelete(id: ID!): ID
  }
`);

function requested(
  query: string,
  variables?: Record<string, unknown>,
  operationName?: string,
): number {
  return requestedQueryCost({ schema, document: parse(query), variables, operationName });
}

function actual(query: string, data: unknown, variables?: Record<string, unknown>): number {
  return actualQueryCost({ schema, document: parse(query), variables }, data);
}

const NESTED = /* GraphQL */ `
  {
    products(first: 10) {
      nodes {
        id
        price {
          amount
        }
        variants(first: 5) {
          nodes {
            id
            price {
              amount
            }
          }
        }
      }
    }
  }
`;

describe('requestedQueryCost', () => {
  it('costs objects 1, and scalars, enums and __typename nothing', () => {
    expect(requested('{ shop { name } }')).toBe(1);
    expect(requested('{ count __typename }')).toBe(0);
    expect(requested('{ product(id: "1") { id title status tags price { amount } } }')).toBe(2);
  });

  it('counts a plain list of objects as one', () => {
    expect(requested('{ product(id: "1") { options { name values } } }')).toBe(2);
  });

  it('costs a connection 2 and each node it may return, its edges free', () => {
    expect(requested('{ products(first: 10) { nodes { id title } } }')).toBe(12);
    expect(
      requested(
        '{ products(first: 10) { edges { cursor node { id } } pageInfo { hasNextPage endCursor } } }',
      ),
    ).toBe(12);
    expect(requested('{ products(last: 5) { nodes { id } } }')).toBe(7);
    // Both lists hold the same nodes, but each is fetched and shaped.
    expect(requested('{ products(first: 2) { nodes { id } edges { node { id } } } }')).toBe(6);
    // Asked for no page, a connection is counted at the default one.
    expect(requested('{ products { nodes { id } } }')).toBe(
      QUERY_COST.connection + QUERY_COST.defaultPageSize,
    );
    expect(requested('{ products(first: 0) { nodes { id } } }')).toBe(3);
    expect(requested('{ products(first: 3) { pageInfo { hasNextPage } } }')).toBe(2);
  });

  it('knows connections by the nodes they hold, named so or paged', () => {
    expect(requested('{ metaConnection { status account { name } } }')).toBe(2);
    expect(requested('{ reviews(first: 5) { nodes { id } } }')).toBe(7);
  });

  it('multiplies nested connections', () => {
    // Each product: itself, its price, and its variants: 2 + 5 × (1 + 1).
    expect(requested(NESTED)).toBe(2 + 10 * (1 + 1 + 12));
  });

  it('reads pages from variables, and from arguments’ defaults', () => {
    const query = 'query Products($n: Int) { products(first: $n) { nodes { id } } }';
    expect(requested(query, { n: 3 })).toBe(5);
    expect(requested(query)).toBe(52);
    expect(requested('{ invoices { id } }')).toBe(2 + 20);
    expect(requested('{ recentProducts(first: 4) { id price { amount } } }')).toBe(2 + 4 * 2);
  });

  it('costs mutations 10 and what their payloads select', () => {
    expect(
      requested(
        'mutation { productCreate(title: "Lawn") { product { id title } userErrors { field message } } }',
      ),
    ).toBe(12);
    expect(requested('mutation { productDelete(id: "1") }')).toBe(10);
    expect(requested('mutation { a: productDelete(id: "1") b: productDelete(id: "2") }')).toBe(20);
  });

  it('counts fragments, merging what they select twice', () => {
    expect(
      requested(/* GraphQL */ `
        {
          product(id: "1") {
            ...Priced
            price {
              amount
            }
            ... on Product {
              variants(first: 2) {
                nodes {
                  id
                }
              }
            }
          }
        }
        fragment Priced on Product {
          title
          price {
            currencyCode
          }
        }
      `),
    ).toBe(1 + 1 + 4);
  });

  it('counts the costliest type of a union or an interface', () => {
    expect(
      requested(/* GraphQL */ `
        {
          search(term: "lawn") {
            ... on Product {
              variants(first: 3) {
                nodes {
                  id
                }
              }
            }
            ... on Collection {
              id
            }
          }
        }
      `),
    ).toBe(1 + 5);
    expect(
      requested(
        '{ node(id: "1") { id ... on Product { price { amount } } ... on Variant { title } } }',
      ),
    ).toBe(2);
  });

  it('leaves out what @skip and @include leave out', () => {
    const query = /* GraphQL */ `
      query Product($variants: Boolean!) {
        product(id: "1") {
          id
          variants(first: 10) @include(if: $variants) {
            nodes {
              id
            }
          }
          ...Priced @skip(if: $variants)
        }
      }
      fragment Priced on Product {
        price {
          amount
        }
      }
    `;
    expect(requested(query, { variants: true })).toBe(1 + 12);
    expect(requested(query, { variants: false })).toBe(1 + 1);
  });

  it('costs introspection a little, whatever it asks for', () => {
    expect(requested('{ __schema { types { name fields { name type { name } } } } }')).toBe(1);
    expect(requested('{ __type(name: "Product") { name } shop { name } }')).toBe(2);
  });

  it('costs the operation named, of several', () => {
    const document = 'query A { shop { name } } query B { products(first: 3) { nodes { id } } }';
    expect(requested(document, undefined, 'A')).toBe(1);
    expect(requested(document, undefined, 'B')).toBe(5);
    expect(requested(document)).toBe(0);
  });

  it('goes far past the maximum for pages within pages', () => {
    expect(
      requested('{ products(first: 250) { nodes { variants(first: 250) { nodes { id } } } } }'),
    ).toBe(2 + 250 * (1 + 2 + 250));
  });
});

describe('actualQueryCost', () => {
  it('counts the nodes connections returned rather than the page', () => {
    const data = {
      products: {
        nodes: [
          {
            id: '1',
            price: { amount: '10.00' },
            variants: { nodes: [{ id: 'a', price: { amount: '10.00' } }] },
          },
          { id: '2', price: null, variants: { nodes: [] } },
        ],
      },
    };
    // The first product: itself, its price, its variants and their one; the second: itself, its
    // price, which came back null, and its variants, empty.
    expect(actual(NESTED, data)).toBe(2 + (1 + 1 + 2 + 2) + (1 + 1 + 2));
    expect(requested(NESTED)).toBe(142);
  });

  it('counts edges as returned', () => {
    const query = '{ products(first: 10) { edges { cursor node { id } } } }';
    const data = { products: { edges: [{ cursor: 'x', node: { id: '1' } }] } };
    expect(actual(query, data)).toBe(3);
  });

  it('counts a paged list’s items as returned', () => {
    const query = '{ recentProducts(first: 4) { id price { amount } } }';
    expect(actual(query, { recentProducts: [{ id: '1', price: null }] })).toBe(2 + 2);
  });

  it('costs an object that came back null 1, and its fields nothing', () => {
    const query = '{ product(id: "1") { id price { amount } } }';
    expect(actual(query, { product: null })).toBe(1);
    expect(actual(query, { product: { id: '1', price: null } })).toBe(2);
    expect(actual(query, { product: { id: '1', price: { amount: '1.00' } } })).toBe(2);
  });

  it('charges root fields that failed, as they ran', () => {
    expect(actual('{ products(first: 10) { nodes { id } } }', null)).toBe(2);
    expect(
      actual(
        'mutation { productCreate(title: "Lawn") { product { id } userErrors { message } } }',
        null,
      ),
    ).toBe(10);
    expect(
      actual(
        'mutation { productCreate(title: "Lawn") { product { id } userErrors { message } } }',
        {
          productCreate: { product: { id: '1' }, userErrors: [] },
        },
      ),
    ).toBe(12);
  });

  it('counts the type a union returned', () => {
    const query = /* GraphQL */ `
      {
        search(term: "lawn") {
          __typename
          ... on Product {
            variants(first: 3) {
              nodes {
                id
              }
            }
          }
          ... on Collection {
            id
          }
        }
      }
    `;
    expect(actual(query, { search: [{ __typename: 'Collection', id: '1' }] })).toBe(1);
    expect(actual(query, { search: [{ __typename: 'Product', variants: { nodes: [] } }] })).toBe(3);
    // Without __typename, the fields that came back tell.
    expect(actual(query.replace('__typename', ''), { search: [{ id: '1' }] })).toBe(1);
  });

  it('counts a plain list as its costliest item, never more than requested', () => {
    const query =
      '{ search(term: "lawn") { ... on Product { variants(first: 3) { nodes { id } } } } }';
    const product = { variants: { nodes: [{ id: '1' }, { id: '2' }, { id: '3' }] } };
    expect(actual(query, { search: [product, product, product] })).toBe(requested(query));
    expect(actual(query, { search: [] })).toBe(1);
  });

  it('honours variables as the request did', () => {
    const query =
      'query P($v: Boolean!) { product(id: "1") { id variants(first: 10) @include(if: $v) { nodes { id } } } }';
    const data = { product: { id: '1', variants: { nodes: [{ id: 'a' }] } } };
    expect(actual(query, data, { v: true })).toBe(1 + 3);
    expect(actual(query, { product: { id: '1' } }, { v: false })).toBe(1);
  });
});
