import { describe, expect, it } from 'vitest';
import { fingerprintOf, mutationFields } from './idempotency.js';

describe('mutationFields', () => {
  it('names the fields a mutation asks for, however it asks', () => {
    expect(mutationFields({ query: '{ shop { name } }' })).toBeNull();
    expect(mutationFields({ query: 'query { shop { name } }' })).toBeNull();
    expect(
      mutationFields({ query: 'mutation { orderConfirm(id: "x") { order { id } } }' }),
    ).toEqual(['orderConfirm']);
    // An alias hides nothing, and nor do fragments.
    expect(
      mutationFields({
        query: `mutation {
          placed: orderCreate(input: {}) { order { id } }
          ... on Mutation { orderRefund(id: "x", input: {}) { refund { id } } }
          ...Ship
        }
        fragment Ship on Mutation { orderFulfill(id: "x") { fulfillment { id } } }`,
      }),
    ).toEqual(['orderCreate', 'orderRefund', 'orderFulfill']);
  });

  it('follows the operation the request names', () => {
    const query = `
      query Read { shop { name } }
      mutation Place { orderCreate(input: {}) { order { id } } }`;
    expect(mutationFields({ query, operationName: 'Place' })).toEqual(['orderCreate']);
    expect(mutationFields({ query, operationName: 'Read' })).toBeNull();
    // Which one is meant is for the GraphQL server to refuse.
    expect(mutationFields({ query })).toBeNull();
    expect(mutationFields({ query: 'mutation {' })).toBeNull();
    expect(mutationFields({})).toBeNull();
  });
});

describe('fingerprintOf', () => {
  const query =
    'mutation ($input: OrderCreateInput!) { orderCreate(input: $input) { order { id } } }';

  it('is the same for the same request, whatever the order of its variables', () => {
    const first = fingerprintOf({ query, variables: { input: { note: 'Eid', tags: ['a'] } } });
    const again = fingerprintOf({ query, variables: { input: { tags: ['a'], note: 'Eid' } } });
    expect(first).toHaveLength(32);
    expect(again.equals(first)).toBe(true);
    expect(
      fingerprintOf({ query, variables: { input: { tags: ['a'], note: 'Eid', x: undefined } } }),
    ).toEqual(first);
  });

  it('differs for any other request', () => {
    const first = fingerprintOf({ query, variables: { input: { note: 'Eid' } } });
    for (const other of [
      { query, variables: { input: { note: 'eid' } } },
      { query, variables: { input: { note: 'Eid', tags: [] } } },
      { query: `${query} `, variables: { input: { note: 'Eid' } } },
      { query, operationName: 'Place', variables: { input: { note: 'Eid' } } },
    ]) {
      expect(fingerprintOf(other).equals(first), JSON.stringify(other)).toBe(false);
    }
  });
});
