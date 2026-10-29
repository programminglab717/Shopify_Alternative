// What the storefront asks of the shop's Storefront API. Each query is whole, without
// interpolation, so Hatti's tests check it against the API's schema (ADR-869). The catalog's and
// the cart's are asked in the shopper's language, English unless they chose Urdu (ADR-926).

export const SHOP_QUERY = /* GraphQL */ `
  query Shop {
    shop {
      name
      primaryDomain {
        url
      }
    }
  }
`;

export const PRODUCTS_QUERY = /* GraphQL */ `
  query Products($first: Int!, $after: String, $query: String, $language: LanguageCode = EN)
  @inContext(language: $language) {
    products(first: $first, after: $after, query: $query) {
      nodes {
        id
        handle
        title
        availableForSale
        featuredImage {
          url(transform: { maxWidth: 600 })
          altText
          width
          height
        }
        priceRange {
          minVariantPrice {
            amount
            currencyCode
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const PRODUCT_QUERY = /* GraphQL */ `
  query Product($handle: String!, $language: LanguageCode = EN) @inContext(language: $language) {
    product(handle: $handle) {
      id
      handle
      title
      descriptionHtml
      availableForSale
      options {
        name
        values
      }
      images(first: 10) {
        nodes {
          url(transform: { maxWidth: 1200 })
          altText
          width
          height
        }
      }
      variants(first: 100) {
        nodes {
          id
          title
          availableForSale
          price {
            amount
            currencyCode
          }
          compareAtPrice {
            amount
            currencyCode
          }
          selectedOptions {
            name
            value
          }
        }
      }
    }
  }
`;

export const COLLECTION_QUERY = /* GraphQL */ `
  query Collection($handle: String!, $first: Int!, $language: LanguageCode = EN)
  @inContext(language: $language) {
    collection(handle: $handle) {
      title
      descriptionHtml
      products(first: $first) {
        nodes {
          id
          handle
          title
          availableForSale
          featuredImage {
            url(transform: { maxWidth: 600 })
            altText
            width
            height
          }
          priceRange {
            minVariantPrice {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;

export const CART_QUERY = /* GraphQL */ `
  query Cart($id: ID!, $language: LanguageCode = EN) @inContext(language: $language) {
    cart(id: $id) {
      id
      checkoutUrl
      totalQuantity
      cost {
        subtotalAmount {
          amount
          currencyCode
        }
        totalAmount {
          amount
          currencyCode
        }
      }
      lines(first: 100) {
        nodes {
          id
          quantity
          merchandise {
            ... on ProductVariant {
              id
              title
              product {
                handle
                title
              }
              image {
                url(transform: { maxWidth: 200 })
                altText
              }
            }
          }
          cost {
            totalAmount {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;

export const CART_CREATE_MUTATION = /* GraphQL */ `
  mutation CartCreate($lines: [CartLineInput!]) {
    cartCreate(input: { lines: $lines }) {
      cart {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

export const CART_LINES_ADD_MUTATION = /* GraphQL */ `
  mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) {
      cart {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

export const CART_LINES_UPDATE_MUTATION = /* GraphQL */ `
  mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
    cartLinesUpdate(cartId: $cartId, lines: $lines) {
      cart {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

export const CART_LINES_REMOVE_MUTATION = /* GraphQL */ `
  mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
    cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
      cart {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

// Shoppers' accounts (ADR-943, ADR-944): a code sent to their mobile number signs them in, and
// the customer access token it gives reads their orders.

export const CUSTOMER_LOGIN_CODE_SEND_MUTATION = /* GraphQL */ `
  mutation CustomerLoginCodeSend(
    $phone: String!
    $channel: CustomerLoginCodeChannel
    $language: LanguageCode = EN
  ) @inContext(language: $language) {
    customerLoginCodeSend(phone: $phone, channel: $channel) {
      sentTo
      channel
      customerUserErrors {
        message
        code
      }
    }
  }
`;

export const CUSTOMER_ACCESS_TOKEN_CREATE_MUTATION = /* GraphQL */ `
  mutation CustomerAccessTokenCreateWithCode($phone: String!, $code: String!) {
    customerAccessTokenCreateWithCode(phone: $phone, code: $code) {
      customerAccessToken {
        accessToken
        expiresAt
      }
      customerUserErrors {
        message
        code
      }
    }
  }
`;

export const CUSTOMER_ACCESS_TOKEN_DELETE_MUTATION = /* GraphQL */ `
  mutation CustomerAccessTokenDelete($customerAccessToken: String!) {
    customerAccessTokenDelete(customerAccessToken: $customerAccessToken) {
      deletedAccessToken
    }
  }
`;

export const CUSTOMER_QUERY = /* GraphQL */ `
  query Customer($customerAccessToken: String!) {
    customer(customerAccessToken: $customerAccessToken) {
      displayName
      phone
      storeCredit {
        amount
        currencyCode
      }
      orders(first: 20) {
        nodes {
          id
          name
          processedAt
          status
          financialStatus
          fulfillmentStatus
          totalPrice {
            amount
            currencyCode
          }
          lineItems(first: 20) {
            nodes {
              title
              variantTitle
              quantity
              merchandiseId
              availableForSale
            }
          }
        }
      }
    }
  }
`;
