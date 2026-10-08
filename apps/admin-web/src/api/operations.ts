// Every GraphQL document the admin sends to the Admin API, in one place: operations.test.ts
// checks each against the schema the core generates (apps/core/schema.graphql).

/** The shop the admin is open on. */
export const ShopQuery = /* GraphQL */ `
  query Shop {
    shop {
      id
      name
      handle
      currencyCode
      timezone
    }
  }
`;
