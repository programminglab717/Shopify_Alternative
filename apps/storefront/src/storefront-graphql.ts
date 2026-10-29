import { createHash } from 'node:crypto';
import type {
  AccountAddress,
  AccountAddressRequest,
  AccountErrorResponse,
  AccountJson,
  AccountLoginStartRequest,
  AccountLoginStartResult,
  AccountLoginVerifyRequest,
  AccountLoginVerifyResult,
  AccountOrderJson,
  CartActionResult,
  CartError,
  CartJson,
  CartLineJson,
} from '@hatti/storefront-api';
import {
  articleHandle,
  type ArticleDoc,
  type BlogDoc,
  type CollectionDoc,
  type ImageDoc,
  type MenuLinkDoc,
  type MetafieldsDoc,
  type PageDoc,
  type ProductDoc,
  type SeoDoc,
  type ShopDoc,
  type StoreData,
  type VariantDoc,
} from '@hatti/storefront-data';
import {
  GraphQLError,
  Kind,
  buildSchema,
  execute,
  getDirectiveValues,
  parse,
  validate,
  type DocumentNode,
  type ExecutionResult,
  type SelectionSetNode,
} from 'graphql';
import { imageAddress, unescapeHtml } from './liquid.js';
import { POLICIES, policyTitle } from './policies.js';

// The Storefront API (DEV-02, ADR-848): GraphQL for headless storefronts and shopping apps, at
// the shop's own address, /api/<version>/graphql.json, as Shopify's, with a token of the shop's,
// public or private. It reads the shop's catalog from its storefront documents, as its pages do,
// and changes carts through the core, as its cart does; a cart's checkoutUrl is the shop's own
// checkout. A subset of Shopify's schema, its names and shapes kept, so its clients ask it alike.
// Shoppers sign in as on the shop's own pages, with a code sent to their mobile number (ADR-943),
// and the access token it gives reads their account, as Shopify's customer access token does,
// and keeps their address book (ADR-946) and wishlist (ADR-951).

export const STOREFRONT_API_LIMITS = {
  /** The longest query read, and how deep it may ask. */
  query: 20_000,
  depth: 12,
  /** The most of a list one field gives. */
  first: 250,
  /** Lines a mutation adds or changes at once. */
  lines: 100,
} as const;

/** The headers a token comes in, as Shopify's: a public one, and a private one. */
export const STOREFRONT_TOKEN_HEADERS = {
  public: 'x-shopify-storefront-access-token',
  private: 'shopify-storefront-private-token',
} as const;

/**
 * The header a shop's own server names its shopper's address in (ADR-943), as Shopify's: read
 * with a private token alone, so that each shopper's sign-ins are counted, not the server's.
 */
export const STOREFRONT_BUYER_IP_HEADER = 'shopify-storefront-buyer-ip';

const SDL = /* GraphQL */ `
  """
  The language and country a query is answered in (ADR-903), as Shopify's: in UR, the shop's
  Urdu words where it gave them, and its pages' Urdu addresses; any other language, its own words.
  The country is taken and changes nothing: prices are in the shop's currency.
  """
  directive @inContext(country: CountryCode, language: LanguageCode) on QUERY | MUTATION

  """
  Languages a query may ask for: the shop's own, English, and Urdu; the others are answered in
  English.
  """
  enum LanguageCode {
    EN
    UR
    AR
    HI
    PA
  }

  """
  Countries a query may name, Pakistan's and those of its shoppers abroad.
  """
  enum CountryCode {
    PK
    AE
    SA
    QA
    OM
    KW
    BH
    GB
    US
    CA
    AU
    NZ
    IE
    DE
    FR
    IT
    ES
    NL
    NO
    SE
    DK
    MY
    SG
    IN
    BD
    CN
    JP
    TR
    ZA
  }

  type Language {
    isoCode: LanguageCode!
    """
    Its name in English: "Urdu".
    """
    name: String!
    """
    Its name in itself: "اردو".
    """
    endonymName: String!
  }

  type Country {
    isoCode: CountryCode!
  }

  """
  The language and country a query is answered in, and the languages the shop's storefront offers.
  """
  type Localization {
    language: Language!
    availableLanguages: [Language!]!
    country: Country!
  }

  """
  A shop's Storefront API (ADR-848): its catalog as its pages show it, and carts its checkout takes.
  """
  type Query {
    shop: Shop!
    """
    The language and country the query is answered in (ADR-903).
    """
    localization: Localization!
    product(id: ID, handle: String): Product
    """
    The shop's products: those a search finds, the likeliest first, where query is given.
    """
    products(first: Int, after: String, query: String): ProductConnection!
    collection(id: ID, handle: String): Collection
    collections(first: Int, after: String): CollectionConnection!
    cart(id: ID!): Cart
    """
    A menu of the shop's, by its handle: "main-menu", "footer" (ADR-890).
    """
    menu(handle: String!): Menu
    page(id: ID, handle: String): Page
    """
    The shop's published pages, by their handles.
    """
    pages(first: Int, after: String): PageConnection!
    blog(id: ID, handle: String): Blog
    blogs(first: Int, after: String): BlogConnection!
    """
    Every blog's published articles, by their blogs' handles and their own.
    """
    articles(first: Int, after: String): ArticleConnection!
    """
    The shopper a customer access token signed in (ADR-943); null once it is none: signed out,
    expired or unknown.
    """
    customer(customerAccessToken: String!): Customer
  }

  type Mutation {
    """
    Sends a code to sign in with to a Pakistani mobile number (ADR-943), on WhatsApp unless SMS is
    asked, as the shop's sign-in page does: the same answer whether or not the number shops there.
    """
    customerLoginCodeSend(
      phone: String!
      channel: CustomerLoginCodeChannel = WHATSAPP
    ): CustomerLoginCodeSendPayload
    """
    The code sent, typed with the number it went to: a customer access token, for \`customer\`.
    """
    customerAccessTokenCreateWithCode(
      phone: String!
      code: String!
    ): CustomerAccessTokenCreatePayload
    customerAccessTokenDelete(customerAccessToken: String!): CustomerAccessTokenDeletePayload
    """
    An address added to the signed-in shopper's book (ADR-946), checked as checkout's are; 20 at
    most. A number that has never ordered has no book yet: its addresses come with its first order.
    """
    customerAddressCreate(
      customerAccessToken: String!
      address: MailingAddressInput!
    ): CustomerAddressCreatePayload
    customerAddressUpdate(
      customerAccessToken: String!
      id: ID!
      address: MailingAddressInput!
    ): CustomerAddressUpdatePayload
    customerAddressDelete(customerAccessToken: String!, id: ID!): CustomerAddressDeletePayload
    """
    The address delivered to first.
    """
    customerDefaultAddressUpdate(
      customerAccessToken: String!
      addressId: ID!
    ): CustomerDefaultAddressUpdatePayload
    """
    Products put first on the signed-in shopper's wishlist (ADR-951), as their account on the
    shop's own pages keeps it; 100 at most, the oldest going to make room.
    """
    customerWishlistAdd(customerAccessToken: String!, productIds: [ID!]!): CustomerWishlistPayload
    customerWishlistRemove(customerAccessToken: String!, productId: ID!): CustomerWishlistPayload
    cartCreate(input: CartInput): CartCreatePayload
    cartLinesAdd(cartId: ID!, lines: [CartLineInput!]!): CartLinesAddPayload
    cartLinesUpdate(cartId: ID!, lines: [CartLineUpdateInput!]!): CartLinesUpdatePayload
    cartLinesRemove(cartId: ID!, lineIds: [ID!]!): CartLinesRemovePayload
    cartNoteUpdate(cartId: ID!, note: String!): CartNoteUpdatePayload
    cartDiscountCodesUpdate(cartId: ID!, discountCodes: [String!]): CartDiscountCodesUpdatePayload
  }

  type Shop {
    name: String!
    primaryDomain: Domain!
    moneyFormat: String!
    """
    The shop's policies, each null where it has none (ADR-890).
    """
    privacyPolicy: ShopPolicy
    refundPolicy: ShopPolicy
    shippingPolicy: ShopPolicy
    termsOfService: ShopPolicy
  }

  type ShopPolicy {
    id: ID!
    handle: String!
    title: String!
    """
    Its text, as HTML the online store cleaned.
    """
    body: String!
    url: String!
  }

  type SEO {
    title: String
    description: String
  }

  enum MenuItemType {
    FRONTPAGE
    CATALOG
    COLLECTION
    COLLECTIONS
    PRODUCT
    PAGE
    BLOG
    ARTICLE
    SEARCH
    POLICY
    HTTP
  }

  type MenuItem {
    id: ID!
    title: String!
    """
    A path on the storefront, absolute, or an address elsewhere.
    """
    url: String
    type: MenuItemType!
    items: [MenuItem!]!
  }

  type Menu {
    id: ID!
    handle: String!
    title: String!
    itemsCount: Int!
    items: [MenuItem!]!
  }

  type Page {
    id: ID!
    handle: String!
    title: String!
    """
    Its content, as HTML the online store cleaned.
    """
    body: String!
    bodySummary: String!
    createdAt: String!
    updatedAt: String!
    onlineStoreUrl: String
    seo: SEO
  }

  type ArticleAuthor {
    name: String!
  }

  type Article {
    id: ID!
    handle: String!
    title: String!
    content: String!
    contentHtml: String!
    excerpt: String
    excerptHtml: String
    authorV2: ArticleAuthor
    tags: [String!]!
    publishedAt: String!
    image: Image
    onlineStoreUrl: String
    seo: SEO
    blog: Blog!
  }

  type Blog {
    id: ID!
    handle: String!
    title: String!
    onlineStoreUrl: String
    seo: SEO
    """
    Its published articles, the latest first.
    """
    articles(first: Int, after: String): ArticleConnection!
    articleByHandle(handle: String!): Article
  }

  type PageEdge {
    cursor: String!
    node: Page!
  }
  type PageConnection {
    edges: [PageEdge!]!
    nodes: [Page!]!
    pageInfo: PageInfo!
  }
  type BlogEdge {
    cursor: String!
    node: Blog!
  }
  type BlogConnection {
    edges: [BlogEdge!]!
    nodes: [Blog!]!
    pageInfo: PageInfo!
  }
  type ArticleEdge {
    cursor: String!
    node: Article!
  }
  type ArticleConnection {
    edges: [ArticleEdge!]!
    nodes: [Article!]!
    pageInfo: PageInfo!
  }

  type Domain {
    host: String!
    url: String!
  }

  type MoneyV2 {
    """
    A decimal, as Shopify's: "2499.0".
    """
    amount: String!
    currencyCode: String!
  }

  type Image {
    id: ID
    url(transform: ImageTransformInput): String!
    altText: String
    width: Int
    height: Int
  }

  input ImageTransformInput {
    maxWidth: Int
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  type ProductOption {
    id: ID!
    name: String!
    values: [String!]!
  }

  type ProductPriceRange {
    minVariantPrice: MoneyV2!
    maxVariantPrice: MoneyV2!
  }

  type SelectedOption {
    name: String!
    value: String!
  }

  input SelectedOptionInput {
    name: String!
    value: String!
  }

  type Product {
    id: ID!
    handle: String!
    title: String!
    description: String!
    descriptionHtml: String!
    vendor: String!
    productType: String!
    tags: [String!]!
    availableForSale: Boolean!
    onlineStoreUrl: String
    createdAt: String
    updatedAt: String
    options(first: Int): [ProductOption!]!
    priceRange: ProductPriceRange!
    compareAtPriceRange: ProductPriceRange!
    featuredImage: Image
    images(first: Int, after: String): ImageConnection!
    variants(first: Int, after: String): ProductVariantConnection!
    variantBySelectedOptions(selectedOptions: [SelectedOptionInput!]!): ProductVariant
    """
    A metafield the shop shows on its storefront (ADR-903), by its namespace and key; null where
    it has none by them.
    """
    metafield(namespace: String, key: String!): Metafield
    """
    The metafields named, in their order, each null where it has none by it.
    """
    metafields(identifiers: [HasMetafieldsIdentifier!]!): [Metafield]!
  }

  """
  A metafield the shop shows on its storefront (ADR-489), as Shopify's: its value as text, a list
  or reference as JSON.
  """
  type Metafield {
    id: ID!
    namespace: String!
    key: String!
    type: String!
    value: String!
  }

  input HasMetafieldsIdentifier {
    namespace: String!
    key: String!
  }

  type ProductVariant {
    id: ID!
    title: String!
    sku: String
    availableForSale: Boolean!
    currentlyNotInStock: Boolean!
    price: MoneyV2!
    compareAtPrice: MoneyV2
    selectedOptions: [SelectedOption!]!
    image: Image
    product: Product!
    """
    A metafield the shop shows on its storefront (ADR-903), by its namespace and key; null where
    it has none by them.
    """
    metafield(namespace: String, key: String!): Metafield
    """
    The metafields named, in their order, each null where it has none by it.
    """
    metafields(identifiers: [HasMetafieldsIdentifier!]!): [Metafield]!
  }

  type Collection {
    id: ID!
    handle: String!
    title: String!
    description: String!
    descriptionHtml: String!
    image: Image
    onlineStoreUrl: String
    products(first: Int, after: String): ProductConnection!
    """
    A metafield the shop shows on its storefront (ADR-903), by its namespace and key; null where
    it has none by them.
    """
    metafield(namespace: String, key: String!): Metafield
    """
    The metafields named, in their order, each null where it has none by it.
    """
    metafields(identifiers: [HasMetafieldsIdentifier!]!): [Metafield]!
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
  type ProductVariantEdge {
    cursor: String!
    node: ProductVariant!
  }
  type ProductVariantConnection {
    edges: [ProductVariantEdge!]!
    nodes: [ProductVariant!]!
    pageInfo: PageInfo!
  }
  type ImageEdge {
    cursor: String!
    node: Image!
  }
  type ImageConnection {
    edges: [ImageEdge!]!
    nodes: [Image!]!
    pageInfo: PageInfo!
  }
  type CollectionEdge {
    cursor: String!
    node: Collection!
  }
  type CollectionConnection {
    edges: [CollectionEdge!]!
    nodes: [Collection!]!
    pageInfo: PageInfo!
  }

  union Merchandise = ProductVariant

  type Attribute {
    key: String!
    value: String
  }

  input AttributeInput {
    key: String!
    value: String!
  }

  type CartCost {
    subtotalAmount: MoneyV2!
    totalAmount: MoneyV2!
  }

  type CartLineCost {
    amountPerQuantity: MoneyV2!
    totalAmount: MoneyV2!
  }

  type CartLine {
    id: ID!
    quantity: Int!
    merchandise: Merchandise!
    attributes: [Attribute!]!
    cost: CartLineCost!
  }

  type BaseCartLineEdge {
    cursor: String!
    node: CartLine!
  }
  type BaseCartLineConnection {
    edges: [BaseCartLineEdge!]!
    nodes: [CartLine!]!
    pageInfo: PageInfo!
  }

  type CartDiscountCode {
    code: String!
    applicable: Boolean!
  }

  type Cart {
    id: ID!
    """
    The shop's own checkout with this cart: the shopper gives their address and pays there.
    """
    checkoutUrl: String!
    totalQuantity: Int!
    note: String
    attributes: [Attribute!]!
    discountCodes: [CartDiscountCode!]!
    lines(first: Int, after: String): BaseCartLineConnection!
    cost: CartCost!
  }

  input CartLineInput {
    merchandiseId: ID!
    quantity: Int
    attributes: [AttributeInput!]
  }

  input CartLineUpdateInput {
    id: ID!
    quantity: Int
  }

  input CartInput {
    lines: [CartLineInput!]
    note: String
    attributes: [AttributeInput!]
    discountCodes: [String!]
  }

  type CartUserError {
    field: [String!]
    message: String!
    code: String
  }

  type CartCreatePayload {
    cart: Cart
    userErrors: [CartUserError!]!
  }
  type CartLinesAddPayload {
    cart: Cart
    userErrors: [CartUserError!]!
  }
  type CartLinesUpdatePayload {
    cart: Cart
    userErrors: [CartUserError!]!
  }
  type CartLinesRemovePayload {
    cart: Cart
    userErrors: [CartUserError!]!
  }
  type CartNoteUpdatePayload {
    cart: Cart
    userErrors: [CartUserError!]!
  }
  type CartDiscountCodesUpdatePayload {
    cart: Cart
    userErrors: [CartUserError!]!
  }

  enum CustomerLoginCodeChannel {
    WHATSAPP
    SMS
  }

  enum CustomerErrorCode {
    INVALID
    """
    The code is not the one sent; tries are left.
    """
    CODE_WRONG
    """
    Its ten minutes are up, its tries used, or none was sent: ask for another.
    """
    CODE_EXPIRED
    TOO_MANY_REQUESTS
    """
    The access token is no one's: signed out, expired or unknown.
    """
    UNIDENTIFIED_CUSTOMER
    NOT_FOUND
  }

  type CustomerUserError {
    field: [String!]
    message: String!
    code: CustomerErrorCode
  }

  type CustomerLoginCodeSendPayload {
    """
    The number, masked, for the page to say where the code went: "0300 ••••567".
    """
    sentTo: String
    channel: CustomerLoginCodeChannel
    customerUserErrors: [CustomerUserError!]!
  }

  type CustomerAccessToken {
    accessToken: String!
    expiresAt: String!
  }

  type CustomerAccessTokenCreatePayload {
    customerAccessToken: CustomerAccessToken
    customerUserErrors: [CustomerUserError!]!
  }

  type CustomerAccessTokenDeletePayload {
    deletedAccessToken: String
    userErrors: [CartUserError!]!
  }

  """
  A shopper signed in with their mobile number: their orders with the shop, the newest first, and
  their store credit.
  """
  type Customer {
    id: ID!
    """
    E.164: the number they proved.
    """
    phone: String!
    displayName: String!
    firstName: String
    lastName: String
    storeCredit: MoneyV2!
    orders(first: Int, after: String): OrderConnection!
    """
    Their address book, the default first (ADR-946).
    """
    addresses(first: Int, after: String): MailingAddressConnection!
    defaultAddress: MailingAddress
    """
    The products they keep to buy later, the newest first, those the shop still sells (ADR-951).
    """
    wishlist(first: Int, after: String): ProductConnection!
  }

  type CustomerWishlistPayload {
    customer: Customer
    customerUserErrors: [CustomerUserError!]!
  }

  """
  An address in Pakistan, as checkout takes it.
  """
  type MailingAddress {
    id: ID!
    name: String!
    firstName: String
    lastName: String
    phone: String!
    address1: String!
    address2: String
    """
    A place a rider finds it by: "near the Jamia Masjid".
    """
    landmark: String
    city: String!
    province: String
    provinceCode: String
    zip: String
    country: String!
    countryCodeV2: String!
    """
    Its lines, as a label shows them.
    """
    formatted: [String!]!
  }

  input MailingAddressInput {
    firstName: String
    lastName: String
    phone: String
    address1: String
    address2: String
    landmark: String
    city: String
    """
    Its name or its code: "Punjab", or "PB".
    """
    province: String
    zip: String
    """
    Pakistan alone is delivered to: any other is refused.
    """
    country: String
  }

  type MailingAddressEdge {
    cursor: String!
    node: MailingAddress!
  }
  type MailingAddressConnection {
    edges: [MailingAddressEdge!]!
    nodes: [MailingAddress!]!
    pageInfo: PageInfo!
  }

  type CustomerAddressCreatePayload {
    customerAddress: MailingAddress
    customerUserErrors: [CustomerUserError!]!
  }
  type CustomerAddressUpdatePayload {
    customerAddress: MailingAddress
    customerUserErrors: [CustomerUserError!]!
  }
  type CustomerAddressDeletePayload {
    deletedCustomerAddressId: String
    customerUserErrors: [CustomerUserError!]!
  }
  type CustomerDefaultAddressUpdatePayload {
    customer: Customer
    customerUserErrors: [CustomerUserError!]!
  }

  enum OrderStatus {
    OPEN
    CLOSED
    CANCELLED
  }

  enum OrderFinancialStatus {
    PENDING
    AUTHORIZED
    PAID
    PARTIALLY_PAID
    PARTIALLY_REFUNDED
    REFUNDED
    VOIDED
  }

  enum OrderFulfillmentStatus {
    UNFULFILLED
    PARTIALLY_FULFILLED
    FULFILLED
    RETURNED
    PARTIALLY_RETURNED
  }

  type Order {
    id: ID!
    """
    "#1001".
    """
    name: String!
    orderNumber: Int!
    processedAt: String!
    status: OrderStatus!
    financialStatus: OrderFinancialStatus
    fulfillmentStatus: OrderFulfillmentStatus!
    totalPrice: MoneyV2!
    lineItems(first: Int, after: String): OrderLineItemConnection!
  }

  type OrderLineItem {
    title: String!
    """
    "M / Red", as it was sold; null for a product without options.
    """
    variantTitle: String
    quantity: Int!
    """
    The variant, for cartLinesAdd to buy it again; null for one the shop no longer has.
    """
    merchandiseId: ID
    availableForSale: Boolean!
  }

  type OrderEdge {
    cursor: String!
    node: Order!
  }
  type OrderConnection {
    edges: [OrderEdge!]!
    nodes: [Order!]!
    pageInfo: PageInfo!
  }
  type OrderLineItemEdge {
    cursor: String!
    node: OrderLineItem!
  }
  type OrderLineItemConnection {
    edges: [OrderLineItemEdge!]!
    nodes: [OrderLineItem!]!
    pageInfo: PageInfo!
  }
`;

const SCHEMA = buildSchema(SDL);

/** The Storefront API's schema, for what checks queries against it: the headless starter's (ADR-869). */
export const STOREFRONT_API_SCHEMA = SCHEMA;

/** The carts of the shop, as the core keeps them (ADR-042). */
export interface StorefrontApiCarts {
  read(shopId: string, token: string | null): Promise<CartJson | null>;
  act(
    shopId: string,
    token: string | null,
    action: string,
    body: unknown,
  ): Promise<CartActionResult>;
}

/**
 * Shoppers' sign-in and accounts, as the core keeps them (ADR-570), for the shop and the buyer the
 * request is of (ADR-943): the buyer's address, and how many sign-ins it asked of late, are the
 * caller's to bind.
 */
export interface StorefrontApiAccounts {
  /** Sends a code; `too_many_requests` where the buyer asked too many of late. */
  sendCode(
    request: AccountLoginStartRequest,
  ): Promise<AccountLoginStartResult | 'too_many_requests'>;
  /** Checks the code; `too_many_requests` likewise. */
  signIn(
    request: AccountLoginVerifyRequest,
  ): Promise<AccountLoginVerifyResult | 'too_many_requests'>;
  account(token: string): Promise<AccountJson | null>;
  signOut(token: string): Promise<void>;
  /** The account's address book (ADR-946); null without a session. */
  addresses(token: string): Promise<AccountAddress[] | null>;
  /** Adds an address, or changes the one `id` names: the book now, or why not; null without one. */
  saveAddress(
    token: string,
    address: AccountAddressRequest,
    id?: string,
  ): Promise<
    { ok: true; addresses: AccountAddress[] } | ({ ok: false } & AccountErrorResponse) | null
  >;
  deleteAddress(token: string, id: string): Promise<AccountAddress[] | null>;
  /** The account's wishlist, its products' IDs the newest first (ADR-951); null without one. */
  wishlist(token: string): Promise<string[] | null>;
  wishlistAdd(token: string, productIds: readonly string[]): Promise<string[] | null>;
  wishlistRemove(token: string, productId: string): Promise<string[] | null>;
}

/** What a request of the Storefront API reads and changes. */
export interface StorefrontApiShop {
  shopId: string;
  store: Pick<
    StoreData,
    | 'products'
    | 'productByHandle'
    | 'productIds'
    | 'collectionByHandle'
    | 'handles'
    | 'menu'
    | 'pageByHandle'
    | 'blogByHandle'
    | 'articleByHandle'
    | 'articles'
    | 'policy'
  >;
  shop: Pick<ShopDoc, 'name' | 'policies'>;
  /** The shop's products a search finds, the likeliest first. */
  search: (terms: string) => Promise<string[]>;
  carts: StorefrontApiCarts | null;
  /** Shoppers' sign-in and accounts (ADR-943); without them, none is signed in. */
  accounts?: StorefrontApiAccounts | null;
  /** Where the shop answers: "https://zari.hatti.pk". */
  origin: string;
  currency: string;
  /**
   * The shop's documents as its pages in `locale` show them (ADR-903): its Urdu words in "ur".
   * Without it, every language is answered in the shop's own words.
   */
  inLanguage?: (locale: string) => StorefrontApiShop['store'];
  /** The language the answer is in: "en", the shop's own, unless a query asks for "ur". */
  locale?: string;
  /** What the answer's page addresses start with after the origin: "/ur" in Urdu, else "". */
  prefix?: string;
  /** The country a query named, as given; Pakistan where it named none. */
  country?: string;
}

/** The languages the Storefront API answers in, as Shopify's Language (ADR-903). */
const LANGUAGES = {
  EN: { isoCode: 'EN', name: 'English', endonymName: 'English' },
  UR: { isoCode: 'UR', name: 'Urdu', endonymName: 'اردو' },
} as const;

/**
 * The `metafield` and `metafields` fields of a resource whose document holds `fields` (ADR-903),
 * Shopify's namespace "custom" where a query names none.
 */
function metafieldsOf(owner: string, fields: MetafieldsDoc | undefined) {
  const one = (namespace: unknown, key: unknown) => {
    const space = typeof namespace === 'string' && namespace !== '' ? namespace : 'custom';
    const name = String(key);
    const field = fields?.[space]?.[name];
    if (!field) return null;
    return {
      id: gid('Metafield', `${owner}/${space}.${name}`),
      namespace: space,
      key: name,
      type: field.type,
      value: field.value,
    };
  };
  return {
    metafield: (args: { namespace?: string | null; key: string }) => one(args.namespace, args.key),
    metafields: (args: { identifiers: { namespace: string; key: string }[] }) =>
      args.identifiers
        .slice(0, STOREFRONT_API_LIMITS.first)
        .map((each) => one(each.namespace, each.key)),
  };
}

/** A page of the shop at `path`, in the answer's language. */
function pageUrl(api: StorefrontApiShop, path: string): string {
  return `${api.origin}${api.prefix ?? ''}${path}`;
}

/**
 * The token a request carries, checked against the shop's (ADR-848): `public` or `private` for
 * one of its own, null for none of them.
 */
export function storefrontTokenOf(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  tokens: readonly { digest: string; private: boolean }[] | undefined,
): 'public' | 'private' | null {
  const header = (name: string) => {
    const value = headers[name];
    return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
  };
  for (const kind of ['private', 'public'] as const) {
    const token = header(STOREFRONT_TOKEN_HEADERS[kind]);
    if (!token) continue;
    const digest = createHash('sha256').update(token).digest('hex');
    if (
      (tokens ?? []).some((each) => each.digest === digest && each.private === (kind === 'private'))
    ) {
      return kind;
    }
  }
  return null;
}

// IDs as Shopify's are: global IDs, here Hatti's.
const gid = (type: string, id: string) => `gid://hatti/${type}/${id}`;
function idOf(type: string, value: unknown): string | null {
  const prefix = `gid://hatti/${type}/`;
  return typeof value === 'string' && value.startsWith(prefix) && value.length <= 300
    ? value.slice(prefix.length)
    : null;
}

const money = (paisa: number, currency: string) => ({
  amount: (paisa / 100).toFixed(2),
  currencyCode: currency,
});

function plainOf(html: string): string {
  return unescapeHtml(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** A list given a page at a time, as Shopify's connections are, by an opaque cursor. */
function connection<T>(
  items: readonly T[],
  args: { first?: number | null; after?: string | null },
) {
  const first = Math.min(Math.max(args.first ?? 20, 0), STOREFRONT_API_LIMITS.first);
  const at = args.after ? offsetOf(args.after) + 1 : 0;
  const page = items.slice(at, at + first);
  const edges = page.map((node, index) => ({ node, cursor: cursorOf(at + index) }));
  return {
    edges,
    nodes: page,
    pageInfo: {
      hasNextPage: at + first < items.length,
      hasPreviousPage: at > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
  };
}

const cursorOf = (at: number) => Buffer.from(`o:${at}`).toString('base64url');
function offsetOf(cursor: string): number {
  const match = /^o:(\d{1,6})$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match) throw new GraphQLError('That cursor is not one this API gave');
  return Number(match[1]);
}

function imageOf(image: ImageDoc | undefined | null, origin: string) {
  if (!image) return null;
  return {
    url: (args: { transform?: { maxWidth?: number | null } | null }) =>
      imageAddress(image.src, origin, args.transform?.maxWidth ?? null),
    altText: image.alt,
    width: image.width || null,
    height: image.height || null,
  };
}

function priceRange(prices: readonly number[], currency: string) {
  const known = prices.length > 0 ? prices : [0];
  return {
    minVariantPrice: money(Math.min(...known), currency),
    maxVariantPrice: money(Math.max(...known), currency),
  };
}

function productOf(doc: ProductDoc, api: StorefrontApiShop): Record<string, unknown> {
  const variants = () => doc.variants.map((variant) => variantOf(doc, variant, api));
  return {
    id: gid('Product', doc.id),
    handle: doc.handle,
    title: doc.title,
    description: plainOf(doc.descriptionHtml),
    descriptionHtml: doc.descriptionHtml,
    vendor: doc.vendor,
    productType: doc.productType,
    tags: doc.tags,
    availableForSale: doc.variants.some((variant) => variant.available),
    onlineStoreUrl: pageUrl(api, `/products/${encodeURIComponent(doc.handle)}`),
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
    options: (args: { first?: number | null }) =>
      doc.options.slice(0, args.first ?? undefined).map((option, index) => ({
        id: gid('ProductOption', `${doc.id}-${index}`),
        name: option.name,
        values: option.values,
      })),
    priceRange: priceRange(
      doc.variants.map((variant) => variant.price),
      api.currency,
    ),
    compareAtPriceRange: priceRange(
      doc.variants.map((variant) => variant.compareAtPrice ?? variant.price),
      api.currency,
    ),
    featuredImage: imageOf(doc.images[0], api.origin),
    images: (args: { first?: number; after?: string }) =>
      connection(
        doc.images.map((image) => imageOf(image, api.origin)!),
        args,
      ),
    variants: (args: { first?: number; after?: string }) => connection(variants(), args),
    variantBySelectedOptions: (args: { selectedOptions: { name: string; value: string }[] }) => {
      const variant = doc.variants.find((each) =>
        args.selectedOptions.every((choice) => {
          const index = doc.options.findIndex((option) => option.name === choice.name);
          return index >= 0 && each.options[index] === choice.value;
        }),
      );
      return variant ? variantOf(doc, variant, api) : null;
    },
    ...metafieldsOf(`Product/${doc.id}`, doc.metafields),
  };
}

function variantOf(doc: ProductDoc, variant: VariantDoc, api: StorefrontApiShop) {
  return {
    __typename: 'ProductVariant',
    id: gid('ProductVariant', variant.id),
    title: variant.title,
    sku: variant.sku,
    availableForSale: variant.available,
    currentlyNotInStock: !variant.available,
    price: money(variant.price, api.currency),
    compareAtPrice:
      variant.compareAtPrice !== null && variant.compareAtPrice > variant.price
        ? money(variant.compareAtPrice, api.currency)
        : null,
    selectedOptions: doc.options.map((option, index) => ({
      name: option.name,
      value: variant.options[index] ?? '',
    })),
    image: imageOf(variant.image !== null ? doc.images[variant.image] : doc.images[0], api.origin),
    product: () => productOf(doc, api),
    ...metafieldsOf(`ProductVariant/${variant.id}`, variant.metafields),
  };
}

/** A menu's link, as Shopify's MenuItem: its type by what it links to (ADR-890). */
function menuItemOf(link: MenuLinkDoc, key: string, api: StorefrontApiShop): unknown {
  const types: Record<string, string> = {
    frontpage_link: 'FRONTPAGE',
    catalog_link: 'CATALOG',
    collection_link: 'COLLECTION',
    collections_link: 'COLLECTIONS',
    product_link: 'PRODUCT',
    page_link: 'PAGE',
    blog_link: 'BLOG',
    article_link: 'ARTICLE',
    search_link: 'SEARCH',
    policy_link: 'POLICY',
  };
  return {
    id: gid('MenuItem', key),
    title: link.title,
    // A path on the storefront made absolute, for an app that is not on it.
    url: link.url.startsWith('/') ? pageUrl(api, link.url) : link.url,
    type: types[link.type] ?? 'HTTP',
    items: link.links.map((each, index) => menuItemOf(each, `${key}-${index}`, api)),
  };
}

const seoOf = (seo: SeoDoc | undefined) =>
  seo ? { title: seo.title ?? null, description: seo.description ?? null } : null;

function pageOf(doc: PageDoc, api: StorefrontApiShop) {
  return {
    id: gid('Page', doc.id),
    handle: doc.handle,
    title: doc.title,
    body: doc.bodyHtml,
    bodySummary: plainOf(doc.bodyHtml).slice(0, 150),
    createdAt: doc.publishedAt,
    updatedAt: doc.updatedAt ?? doc.publishedAt,
    onlineStoreUrl: pageUrl(api, `/pages/${encodeURIComponent(doc.handle)}`),
    seo: seoOf(doc.seo),
  };
}

function blogOf(doc: BlogDoc, api: StorefrontApiShop): Record<string, unknown> {
  return {
    id: gid('Blog', doc.id),
    handle: doc.handle,
    title: doc.title,
    onlineStoreUrl: pageUrl(api, `/blogs/${encodeURIComponent(doc.handle)}`),
    seo: seoOf(doc.seo),
    articles: async (args: { first?: number; after?: string }) => {
      const page = connection(doc.articles, args);
      const docs = await api.store.articles(page.nodes.map((each) => each.id));
      const edges = page.edges.flatMap((edge, index) =>
        docs[index] ? [{ cursor: edge.cursor, node: articleOf(docs[index]!, doc, api) }] : [],
      );
      return { edges, nodes: edges.map((edge) => edge.node), pageInfo: page.pageInfo };
    },
    articleByHandle: async (args: { handle: string }) => {
      const found = await api.store.articleByHandle(
        articleHandle({ blogHandle: doc.handle, handle: args.handle }),
      );
      return found ? articleOf(found, doc, api) : null;
    },
  };
}

function articleOf(doc: ArticleDoc, blog: BlogDoc, api: StorefrontApiShop) {
  return {
    id: gid('Article', doc.id),
    handle: doc.handle,
    title: doc.title,
    content: plainOf(doc.bodyHtml),
    contentHtml: doc.bodyHtml,
    excerpt: doc.summaryHtml ? plainOf(doc.summaryHtml) : null,
    excerptHtml: doc.summaryHtml || null,
    authorV2: doc.author ? { name: doc.author } : null,
    tags: doc.tags,
    publishedAt: doc.publishedAt,
    image: imageOf(doc.image, api.origin),
    onlineStoreUrl:
      pageUrl(api, `/blogs/${encodeURIComponent(blog.handle)}/`) + encodeURIComponent(doc.handle),
    seo: seoOf(doc.seo),
    blog: () => blogOf(blog, api),
  };
}

/** A shop's policy of `type`, as Shopify's ShopPolicy; null where it has none. */
async function policyOf(type: string, api: StorefrontApiShop) {
  const kind = POLICIES.find((each) => each.type === type)!;
  if (!(api.shop.policies ?? []).includes(type)) return null;
  const body = await api.store.policy(type);
  if (body === null) return null;
  return {
    id: gid('ShopPolicy', kind.handle),
    handle: kind.handle,
    title: policyTitle(kind, api.locale ?? 'en'),
    body,
    url: pageUrl(api, `/policies/${kind.handle}`),
  };
}

/** A page of the documents `handles` name, in the handles' order; those gone left out. */
async function byHandles<T>(
  handles: readonly string[],
  args: { first?: number | null; after?: string | null },
  read: (handle: string) => Promise<T | null>,
) {
  const page = connection([...handles].sort(), args);
  const nodes = await Promise.all(page.nodes.map(read));
  const edges = page.edges.flatMap((edge, index) =>
    nodes[index] ? [{ cursor: edge.cursor, node: nodes[index]! }] : [],
  );
  return { edges, nodes: edges.map((edge) => edge.node), pageInfo: page.pageInfo };
}

function collectionOf(doc: CollectionDoc, api: StorefrontApiShop) {
  return {
    id: gid('Collection', doc.id),
    handle: doc.handle,
    title: doc.title,
    description: plainOf(doc.descriptionHtml),
    descriptionHtml: doc.descriptionHtml,
    image: imageOf(doc.image, api.origin),
    onlineStoreUrl: pageUrl(api, `/collections/${encodeURIComponent(doc.handle)}`),
    products: (args: { first?: number; after?: string }) => productPage(doc.productIds, args, api),
    ...metafieldsOf(`Collection/${doc.id}`, doc.metafields),
  };
}

/** A page of the products `ids` name, those gone left out. */
async function productPage(
  ids: readonly string[],
  args: { first?: number | null; after?: string | null },
  api: StorefrontApiShop,
) {
  const first = Math.min(Math.max(args.first ?? 20, 0), STOREFRONT_API_LIMITS.first);
  const at = args.after ? offsetOf(args.after) + 1 : 0;
  const docs = await api.store.products(ids.slice(at, at + first));
  const edges = docs.flatMap((doc, index) =>
    doc ? [{ node: productOf(doc, api), cursor: cursorOf(at + index) }] : [],
  );
  return {
    edges,
    nodes: edges.map((edge) => edge.node),
    pageInfo: {
      hasNextPage: at + first < ids.length,
      hasPreviousPage: at > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
  };
}

// Carts: their IDs carry the core's token for them, the secret a shopper's cookie keeps.
const lineIdOf = (line: CartLineJson) =>
  gid('CartLine', Buffer.from(line.key).toString('base64url'));
const lineKeyOf = (id: unknown) => {
  const encoded = idOf('CartLine', id);
  return encoded ? Buffer.from(encoded, 'base64url').toString() : null;
};

function cartOf(cart: CartJson, token: string, api: StorefrontApiShop) {
  const lines = cart.items.map((line) => ({
    id: lineIdOf(line),
    quantity: line.quantity,
    merchandise: async () => {
      const [doc] = await api.store.products([line.productId]);
      const variant = doc?.variants.find((each) => each.id === line.variantId);
      if (doc && variant) return variantOf(doc, variant, api);
      // Gone from the catalog since: what the cart knows of it.
      return {
        __typename: 'ProductVariant',
        id: gid('ProductVariant', line.variantId),
        title: line.variantTitle,
        sku: line.sku,
        availableForSale: false,
        currentlyNotInStock: true,
        price: money(line.price, api.currency),
        compareAtPrice: null,
        selectedOptions: [],
        image: null,
        product: () => {
          throw new GraphQLError('Its product is no longer sold');
        },
      };
    },
    attributes: Object.entries(line.properties).map(([key, value]) => ({ key, value })),
    cost: {
      amountPerQuantity: money(line.price, api.currency),
      totalAmount: money(line.linePrice, api.currency),
    },
  }));
  return {
    id: gid('Cart', token),
    checkoutUrl: `${api.origin}/cart/c/${encodeURIComponent(token)}`,
    totalQuantity: cart.itemCount,
    note: cart.note || null,
    attributes: Object.entries(cart.attributes).map(([key, value]) => ({ key, value })),
    discountCodes: cart.discount
      ? [{ code: cart.discount.code, applicable: cart.discount.applicable }]
      : [],
    lines: (args: { first?: number; after?: string }) => connection(lines, args),
    cost: {
      subtotalAmount: money(cart.subtotal, api.currency),
      totalAmount: money(cart.subtotal - cart.totalDiscount, api.currency),
    },
  };
}

type UserErrorJson = { field: string[] | null; message: string; code: string | null };

/** A customer access token, as the core makes a session's secret; anything else is none. */
const CUSTOMER_TOKEN = /^[\w-]{16,128}$/;

/** The longest number and code read of what a shopper typed, as the shop's pages read them. */
const PHONE_MAX = 40;
const CODE_MAX = 20;

/** An order of the shopper's, as Shopify's Order. */
function orderOf(order: AccountOrderJson) {
  const lines = order.lines.map((line) => ({
    title: line.productTitle,
    variantTitle: line.variantTitle,
    quantity: line.quantity,
    merchandiseId: line.variantId ? gid('ProductVariant', line.variantId) : null,
    availableForSale: line.available,
  }));
  return {
    id: gid('Order', order.id),
    name: order.name,
    orderNumber: Number(order.name.replace(/\D/g, '')) || 0,
    processedAt: order.placedAt,
    status: order.status.toUpperCase(),
    financialStatus: order.financialStatus.toUpperCase(),
    fulfillmentStatus: order.fulfillmentStatus.toUpperCase(),
    totalPrice: money(order.total, order.currency),
    lineItems: (args: { first?: number; after?: string }) => connection(lines, args),
  };
}

/** An address of the shopper's book, as Shopify's MailingAddress. */
function mailingAddressOf(address: AccountAddress) {
  const [firstName, ...rest] = address.name.trim().split(/\s+/);
  const street = [address.address1, address.address2].filter(Boolean).join(', ');
  return {
    id: gid('MailingAddress', address.id),
    name: address.name,
    firstName: firstName || null,
    lastName: rest.join(' ') || null,
    phone: address.phone,
    address1: address.address1,
    address2: address.address2,
    landmark: address.landmark,
    city: address.city,
    province: address.province,
    provinceCode: address.provinceCode,
    zip: address.zip,
    country: 'Pakistan',
    countryCodeV2: 'PK',
    formatted: [
      address.name,
      street,
      ...(address.landmark ? [address.landmark] : []),
      [address.city, address.province, address.zip].filter(Boolean).join(' '),
      'Pakistan',
    ],
  };
}

/** What a MailingAddressInput asks, as the core takes an address; `kept` fills what it leaves out. */
function addressRequestOf(
  input: Record<string, string | null | undefined>,
  kept?: AccountAddress,
): AccountAddressRequest | 'not_pakistan' {
  const country = input.country?.trim().toLowerCase();
  if (country && !['pakistan', 'pk', 'pak'].includes(country)) return 'not_pakistan';
  // A field left out keeps what it was; one given as null is cleared, as Shopify's are.
  const field = (key: string, was: string | null | undefined) =>
    input[key] === undefined ? (was ?? null) : (input[key] ?? null);
  const keptName = kept?.name.trim().split(/\s+/) ?? [];
  const first = field('firstName', keptName[0]);
  const last = field('lastName', keptName.slice(1).join(' '));
  return {
    name: [first, last].filter(Boolean).join(' '),
    phone: field('phone', kept?.phone) ?? '',
    address1: field('address1', kept?.address1) ?? '',
    address2: field('address2', kept?.address2),
    landmark: field('landmark', kept?.landmark),
    city: field('city', kept?.city) ?? '',
    province: field('province', kept?.provinceCode),
    zip: field('zip', kept?.zip),
    ...(kept?.default && { default: true }),
  };
}

/** The signed-in shopper's account, as Shopify's Customer, its book and wishlist read as asked. */
function customerOf(
  account: AccountJson,
  api: StorefrontApiShop,
  book: () => Promise<AccountAddress[]> = async () => [],
  wishlist: () => Promise<string[]> = async () => [],
) {
  const [firstName, ...rest] = (account.name ?? '').trim().split(/\s+/);
  const orders = account.orders.map(orderOf);
  return {
    // Not their number, which `phone` gives only to who holds the token.
    id: gid('Customer', createHash('sha256').update(account.phone).digest('hex').slice(0, 24)),
    phone: account.phone,
    displayName: account.name?.trim() || account.phone,
    firstName: firstName || null,
    lastName: rest.join(' ') || null,
    storeCredit: money(account.storeCredit.balance, account.storeCredit.currency),
    orders: (args: { first?: number; after?: string }) => connection(orders, args),
    addresses: async (args: { first?: number; after?: string }) =>
      connection((await book()).map(mailingAddressOf), args),
    defaultAddress: async () => {
      const first = (await book()).find((address) => address.default);
      return first ? mailingAddressOf(first) : null;
    },
    wishlist: async (args: { first?: number; after?: string }) =>
      productPage(await wishlist(), args, api),
  };
}

const customerError = (field: string[], message: string, code: string) => ({
  field,
  message,
  code,
});

/** Why the core refused a cart's change, as Shopify's cart says it. */
function cartUserError(error: CartError, field: string[]): UserErrorJson {
  switch (error.code) {
    case 'NOT_FOUND':
      return { field, message: 'That merchandise is not for sale', code: 'MERCHANDISE_NOT_FOUND' };
    case 'LINE_NOT_FOUND':
      return { field, message: 'The cart has no such line', code: 'INVALID_MERCHANDISE_LINE' };
    case 'MAX_QUANTITY':
      return {
        field,
        message: `Only ${error.max} of ${error.title} can be bought now`,
        code: 'INVALID',
      };
    case 'MAX_LINES':
      return { field, message: `A cart has ${error.max} lines at most`, code: 'INVALID' };
    case 'INVALID':
      return { field, message: error.message, code: 'INVALID' };
    default:
      return { field, message: 'The cart could not be changed', code: 'INVALID' };
  }
}

const userError = (field: string[], message: string, code = 'INVALID'): UserErrorJson => ({
  field,
  message,
  code,
});

/** The variant a line names, and how many: one unless said. */
function itemOf(line: {
  merchandiseId: string;
  quantity?: number | null;
  attributes?: { key: string; value: string }[] | null;
}) {
  const variantId = idOf('ProductVariant', line.merchandiseId);
  return {
    variantId,
    quantity: line.quantity ?? 1,
    properties: Object.fromEntries((line.attributes ?? []).map((each) => [each.key, each.value])),
  };
}

function rootOf(api: StorefrontApiShop) {
  const languages = api.inLanguage ? [LANGUAGES.EN, LANGUAGES.UR] : [LANGUAGES.EN];
  const localization = () => ({
    language: api.locale === 'ur' ? LANGUAGES.UR : LANGUAGES.EN,
    availableLanguages: languages,
    country: { isoCode: api.country ?? 'PK' },
  });
  const carts = () => {
    if (!api.carts) throw new GraphQLError('This storefront keeps no carts');
    return api.carts;
  };
  /** The cart `id` names now, or why there is none. */
  const cartNamed = async (id: unknown) => {
    const token = idOf('Cart', id);
    const cart = token ? await carts().read(api.shopId, token) : null;
    return cart && token ? { cart, token } : null;
  };
  /** The cart after `action`, or why not, as a mutation's payload. */
  const changed = async (
    token: string | null,
    action: string,
    body: unknown,
    field: string[],
  ): Promise<{ cart: unknown; userErrors: UserErrorJson[]; token: string | null }> => {
    const result = await carts().act(api.shopId, token, action, body);
    if (!result.ok) return { cart: null, userErrors: [cartUserError(result.error, field)], token };
    const kept = result.token ?? token;
    return {
      cart: kept ? cartOf(result.cart, kept, api) : null,
      userErrors: [],
      token: kept,
    };
  };
  const noCart = { cart: null, userErrors: [userError(['cartId'], 'No such cart', 'INVALID')] };
  const tooMany = (field: string) => ({
    cart: null,
    userErrors: [userError([field], `${STOREFRONT_API_LIMITS.lines} lines at a time at most`)],
  });

  const accounts = () => {
    if (!api.accounts) throw new GraphQLError('This storefront keeps no accounts');
    return api.accounts;
  };
  const tooManyAsked = customerError([], 'Too many sign-ins: wait a minute', 'TOO_MANY_REQUESTS');
  const unidentified = customerError(
    ['customerAccessToken'],
    "Sign in again: that access token is no one's",
    'UNIDENTIFIED_CUSTOMER',
  );
  const noAddress = (field: string[]) =>
    customerError(field, 'No such address in the book', 'NOT_FOUND');
  /** The book of the shopper `token` signed in, read once however often it is asked for. */
  const bookOf = (token: string) => {
    let read: Promise<AccountAddress[]> | null = null;
    return () =>
      (read ??= accounts()
        .addresses(token)
        .then((book) => book ?? []));
  };
  /** The wishlist of the shopper `token` signed in, read once. */
  const wishOf = (token: string) => {
    let read: Promise<string[]> | null = null;
    return () =>
      (read ??= accounts()
        .wishlist(token)
        .then((ids) => ids ?? []));
  };
  /** The wishlist after `change`, as a mutation's payload. */
  const wished = async (token: string, change: () => Promise<string[] | null>) => {
    const ids = CUSTOMER_TOKEN.test(token) ? await change() : null;
    const account = ids ? await accounts().account(token) : null;
    if (!ids || !account) return { customer: null, customerUserErrors: [unidentified] };
    return {
      customer: customerOf(account, api, bookOf(token), async () => ids),
      customerUserErrors: [],
    };
  };
  type AddressInput = Record<string, string | null | undefined>;
  /** An address added, or the one `id` names changed, as a mutation's payload. */
  const savedAddress = async (token: string, input: AddressInput, id: string | null) => {
    const none = { customerAddress: null };
    const book = CUSTOMER_TOKEN.test(token) ? await accounts().addresses(token) : null;
    if (!book) return { ...none, customerUserErrors: [unidentified] };
    const wanted = id === null ? null : idOf('MailingAddress', id);
    const kept = wanted ? book.find((address) => address.id === wanted) : undefined;
    if (id !== null && !kept) return { ...none, customerUserErrors: [noAddress(['id'])] };
    const request = addressRequestOf(input, kept);
    if (request === 'not_pakistan') {
      return {
        ...none,
        customerUserErrors: [
          customerError(
            ['address', 'country'],
            'Only addresses in Pakistan are delivered to',
            'INVALID',
          ),
        ],
      };
    }
    const saved = await accounts().saveAddress(token, request, kept?.id);
    if (!saved) return { ...none, customerUserErrors: [unidentified] };
    if (!saved.ok) {
      return {
        ...none,
        customerUserErrors: saved.errors.map((error) =>
          customerError(['address', error.field], error.message, 'INVALID'),
        ),
      };
    }
    // The one added is the one the book did not have; the one changed keeps its ID.
    const before = new Set(book.map((address) => address.id));
    const address =
      (kept && saved.addresses.find((each) => each.id === kept.id)) ??
      saved.addresses.find((each) => !before.has(each.id)) ??
      null;
    return {
      customerAddress: address && mailingAddressOf(address),
      customerUserErrors: [],
    };
  };

  return {
    localization,
    customer: async (args: { customerAccessToken: string }) => {
      if (!CUSTOMER_TOKEN.test(args.customerAccessToken)) return null;
      const account = await accounts().account(args.customerAccessToken);
      return account
        ? customerOf(
            account,
            api,
            bookOf(args.customerAccessToken),
            wishOf(args.customerAccessToken),
          )
        : null;
    },
    customerWishlistAdd: (args: { customerAccessToken: string; productIds: string[] }) => {
      const ids = args.productIds
        .slice(0, STOREFRONT_API_LIMITS.first)
        .map((id) => idOf('Product', id))
        .filter((id): id is string => id !== null);
      return wished(args.customerAccessToken, () =>
        accounts().wishlistAdd(args.customerAccessToken, ids),
      );
    },
    customerWishlistRemove: (args: { customerAccessToken: string; productId: string }) => {
      const id = idOf('Product', args.productId);
      return wished(args.customerAccessToken, async () =>
        id
          ? accounts().wishlistRemove(args.customerAccessToken, id)
          : accounts().wishlist(args.customerAccessToken),
      );
    },
    customerAddressCreate: (args: { customerAccessToken: string; address: AddressInput }) =>
      savedAddress(args.customerAccessToken, args.address, null),
    customerAddressUpdate: (args: {
      customerAccessToken: string;
      id: string;
      address: AddressInput;
    }) => savedAddress(args.customerAccessToken, args.address, args.id),
    customerAddressDelete: async (args: { customerAccessToken: string; id: string }) => {
      const id = idOf('MailingAddress', args.id);
      const book = CUSTOMER_TOKEN.test(args.customerAccessToken)
        ? await accounts().addresses(args.customerAccessToken)
        : null;
      if (!book) return { deletedCustomerAddressId: null, customerUserErrors: [unidentified] };
      if (!id || !book.some((address) => address.id === id)) {
        return { deletedCustomerAddressId: null, customerUserErrors: [noAddress(['id'])] };
      }
      await accounts().deleteAddress(args.customerAccessToken, id);
      return { deletedCustomerAddressId: args.id, customerUserErrors: [] };
    },
    customerDefaultAddressUpdate: async (args: {
      customerAccessToken: string;
      addressId: string;
    }) => {
      const token = args.customerAccessToken;
      const id = idOf('MailingAddress', args.addressId);
      const book = CUSTOMER_TOKEN.test(token) ? await accounts().addresses(token) : null;
      if (!book) return { customer: null, customerUserErrors: [unidentified] };
      const kept = book.find((address) => address.id === id);
      if (!kept) return { customer: null, customerUserErrors: [noAddress(['addressId'])] };
      const request = addressRequestOf({}, kept);
      if (request === 'not_pakistan') return { customer: null, customerUserErrors: [] };
      await accounts().saveAddress(token, { ...request, default: true }, kept.id);
      const account = await accounts().account(token);
      return {
        customer: account ? customerOf(account, api, bookOf(token), wishOf(token)) : null,
        customerUserErrors: account ? [] : [unidentified],
      };
    },
    customerLoginCodeSend: async (args: { phone: string; channel?: 'WHATSAPP' | 'SMS' | null }) => {
      const channel = args.channel === 'SMS' ? 'sms' : 'whatsapp';
      const started = await accounts().sendCode({
        phone: args.phone.trim().slice(0, PHONE_MAX),
        channel,
        locale: api.locale === 'ur' ? 'ur' : 'en',
      });
      const none = { sentTo: null, channel: null };
      if (started === 'too_many_requests') return { ...none, customerUserErrors: [tooManyAsked] };
      if (!started.ok) {
        return {
          ...none,
          customerUserErrors: [
            customerError(
              ['phone'],
              started.errors[0]?.message ?? 'Give a mobile number',
              'INVALID',
            ),
          ],
        };
      }
      if (started.state === 'too_many') {
        return {
          ...none,
          customerUserErrors: [
            customerError(
              ['phone'],
              'Too many codes sent to this number: wait a while',
              'TOO_MANY_REQUESTS',
            ),
          ],
        };
      }
      return {
        sentTo: started.phone,
        channel: started.channel.toUpperCase(),
        customerUserErrors: [],
      };
    },
    customerAccessTokenCreateWithCode: async (args: { phone: string; code: string }) => {
      const signed = await accounts().signIn({
        phone: args.phone.trim().slice(0, PHONE_MAX),
        code: args.code.replace(/\s+/g, '').slice(0, CODE_MAX),
      });
      const refused = (error: ReturnType<typeof customerError>) => ({
        customerAccessToken: null,
        customerUserErrors: [error],
      });
      if (signed === 'too_many_requests') return refused(tooManyAsked);
      if (!signed.ok) {
        switch (signed.error) {
          case 'wrong':
            return refused(customerError(['code'], 'That is not the code sent', 'CODE_WRONG'));
          case 'invalid':
            return refused(customerError(['phone'], 'Give a mobile number', 'INVALID'));
          default:
            return refused(
              customerError(['code'], 'That code is over: ask for another', 'CODE_EXPIRED'),
            );
        }
      }
      return {
        customerAccessToken: { accessToken: signed.token, expiresAt: signed.session.expiresAt },
        customerUserErrors: [],
      };
    },
    customerAccessTokenDelete: async (args: { customerAccessToken: string }) => {
      if (!CUSTOMER_TOKEN.test(args.customerAccessToken)) {
        return {
          deletedAccessToken: null,
          userErrors: [userError(['customerAccessToken'], 'No such access token')],
        };
      }
      await accounts().signOut(args.customerAccessToken);
      return { deletedAccessToken: args.customerAccessToken, userErrors: [] };
    },
    shop: () => ({
      name: api.shop.name,
      primaryDomain: { host: new URL(api.origin).host, url: api.origin },
      moneyFormat: 'Rs {{amount}}',
      privacyPolicy: () => policyOf('privacy_policy', api),
      refundPolicy: () => policyOf('refund_policy', api),
      shippingPolicy: () => policyOf('shipping_policy', api),
      termsOfService: () => policyOf('terms_of_service', api),
    }),
    menu: async (args: { handle: string }) => {
      const doc = await api.store.menu(args.handle);
      if (!doc) return null;
      return {
        id: gid('Menu', doc.handle),
        handle: doc.handle,
        title: doc.title,
        itemsCount: doc.links.length,
        items: doc.links.map((link, index) => menuItemOf(link, `${doc.handle}-${index}`, api)),
      };
    },
    page: async (args: { id?: string | null; handle?: string | null }) => {
      const wanted = args.id ? idOf('Page', args.id) : null;
      if (args.handle) {
        const doc = await api.store.pageByHandle(args.handle);
        return doc && (!wanted || doc.id === wanted) ? pageOf(doc, api) : null;
      }
      if (!wanted) return null;
      for (const handle of await api.store.handles('page')) {
        const doc = await api.store.pageByHandle(handle);
        if (doc?.id === wanted) return pageOf(doc, api);
      }
      return null;
    },
    pages: async (args: { first?: number; after?: string }) =>
      byHandles(await api.store.handles('page'), args, async (handle) => {
        const doc = await api.store.pageByHandle(handle);
        return doc && pageOf(doc, api);
      }),
    blog: async (args: { id?: string | null; handle?: string | null }) => {
      const wanted = args.id ? idOf('Blog', args.id) : null;
      if (args.handle) {
        const doc = await api.store.blogByHandle(args.handle);
        return doc && (!wanted || doc.id === wanted) ? blogOf(doc, api) : null;
      }
      if (!wanted) return null;
      for (const handle of await api.store.handles('blog')) {
        const doc = await api.store.blogByHandle(handle);
        if (doc?.id === wanted) return blogOf(doc, api);
      }
      return null;
    },
    blogs: async (args: { first?: number; after?: string }) =>
      byHandles(await api.store.handles('blog'), args, async (handle) => {
        const doc = await api.store.blogByHandle(handle);
        return doc && blogOf(doc, api);
      }),
    articles: async (args: { first?: number; after?: string }) =>
      byHandles(await api.store.handles('article'), args, async (handle) => {
        const doc = await api.store.articleByHandle(handle);
        if (!doc) return null;
        const blog = await api.store.blogByHandle(doc.blogHandle);
        return blog && articleOf(doc, blog, api);
      }),
    product: async (args: { id?: string | null; handle?: string | null }) => {
      const id = args.id ? idOf('Product', args.id) : null;
      const doc = id
        ? ((await api.store.products([id]))[0] ?? null)
        : args.handle
          ? await api.store.productByHandle(args.handle)
          : null;
      return doc ? productOf(doc, api) : null;
    },
    products: async (args: { first?: number; after?: string; query?: string | null }) => {
      const terms = args.query?.trim().slice(0, 200) ?? '';
      const ids = terms ? await api.search(terms) : await api.store.productIds();
      return productPage(ids, args, api);
    },
    collection: async (args: { id?: string | null; handle?: string | null }) => {
      const handle = args.handle ?? null;
      const doc = handle ? await api.store.collectionByHandle(handle) : null;
      const wanted = args.id ? idOf('Collection', args.id) : null;
      if (wanted && !handle) {
        // By ID: among its collections, as the storefront has them by handle.
        for (const each of await api.store.handles('collection')) {
          const found = await api.store.collectionByHandle(each);
          if (found?.id === wanted) return collectionOf(found, api);
        }
        return null;
      }
      return doc ? collectionOf(doc, api) : null;
    },
    collections: async (args: { first?: number; after?: string }) => {
      const handles = await api.store.handles('collection');
      const page = connection(handles, args);
      const docs = await Promise.all(
        page.nodes.map((handle) => api.store.collectionByHandle(handle)),
      );
      const edges = page.edges.flatMap((edge, index) =>
        docs[index] ? [{ cursor: edge.cursor, node: collectionOf(docs[index]!, api) }] : [],
      );
      return { edges, nodes: edges.map((edge) => edge.node), pageInfo: page.pageInfo };
    },
    cart: async (args: { id: string }) => {
      const named = await cartNamed(args.id);
      return named ? cartOf(named.cart, named.token, api) : null;
    },

    cartCreate: async (args: {
      input?: {
        lines?: Parameters<typeof itemOf>[0][] | null;
        note?: string | null;
        attributes?: { key: string; value: string }[] | null;
        discountCodes?: string[] | null;
      } | null;
    }) => {
      const input = args.input ?? {};
      const lines = input.lines ?? [];
      if (lines.length > STOREFRONT_API_LIMITS.lines) return tooMany('input.lines');
      const items = lines.map(itemOf);
      if (items.some((item) => !item.variantId)) {
        return {
          cart: null,
          userErrors: [userError(['input', 'lines'], 'Each merchandiseId is a ProductVariant ID')],
        };
      }
      // A cart needs a line to be: made by its first change.
      let result = await changed(
        null,
        'add',
        { items: items.map((item) => ({ ...item, variantId: item.variantId! })) },
        ['input', 'lines'],
      );
      if (result.userErrors.length > 0 || !result.token) {
        return {
          cart: result.cart,
          userErrors:
            result.userErrors.length > 0
              ? result.userErrors
              : [userError(['input', 'lines'], 'A cart starts with a line')],
        };
      }
      const update: Record<string, unknown> = {};
      if (input.note !== null && input.note !== undefined) update.note = input.note;
      if (input.attributes) {
        update.attributes = Object.fromEntries(
          input.attributes.map((each) => [each.key, each.value]),
        );
      }
      if (input.discountCodes) update.discount = input.discountCodes.join(',');
      if (Object.keys(update).length > 0) {
        result = await changed(result.token, 'update', update, ['input']);
      }
      return { cart: result.cart, userErrors: result.userErrors };
    },
    cartLinesAdd: async (args: { cartId: string; lines: Parameters<typeof itemOf>[0][] }) => {
      if (args.lines.length > STOREFRONT_API_LIMITS.lines) return tooMany('lines');
      const named = await cartNamed(args.cartId);
      if (!named) return noCart;
      const items = args.lines.map(itemOf);
      if (items.some((item) => !item.variantId)) {
        return {
          cart: null,
          userErrors: [userError(['lines'], 'Each merchandiseId is a ProductVariant ID')],
        };
      }
      const result = await changed(
        named.token,
        'add',
        { items: items.map((item) => ({ ...item, variantId: item.variantId! })) },
        ['lines'],
      );
      return { cart: result.cart, userErrors: result.userErrors };
    },
    cartLinesUpdate: async (args: {
      cartId: string;
      lines: { id: string; quantity?: number | null }[];
    }) => {
      if (args.lines.length > STOREFRONT_API_LIMITS.lines) return tooMany('lines');
      const named = await cartNamed(args.cartId);
      if (!named) return noCart;
      const updates = args.lines.map((line) => ({
        key: lineKeyOf(line.id),
        quantity: line.quantity ?? 1,
      }));
      if (updates.some((update) => !update.key)) {
        return {
          cart: null,
          userErrors: [
            userError(['lines'], 'Each id is a CartLine ID', 'INVALID_MERCHANDISE_LINE'),
          ],
        };
      }
      const result = await changed(
        named.token,
        'update',
        {
          updates: updates.map((update) => ({
            line: { key: update.key! },
            quantity: update.quantity,
          })),
        },
        ['lines'],
      );
      return { cart: result.cart, userErrors: result.userErrors };
    },
    cartLinesRemove: async (args: { cartId: string; lineIds: string[] }) => {
      if (args.lineIds.length > STOREFRONT_API_LIMITS.lines) return tooMany('lineIds');
      const named = await cartNamed(args.cartId);
      if (!named) return noCart;
      const keys = args.lineIds.map(lineKeyOf);
      if (keys.some((key) => !key)) {
        return {
          cart: null,
          userErrors: [
            userError(['lineIds'], 'Each id is a CartLine ID', 'INVALID_MERCHANDISE_LINE'),
          ],
        };
      }
      const result = await changed(
        named.token,
        'update',
        { updates: keys.map((key) => ({ line: { key: key! }, quantity: 0 })) },
        ['lineIds'],
      );
      return { cart: result.cart, userErrors: result.userErrors };
    },
    cartNoteUpdate: async (args: { cartId: string; note: string }) => {
      const named = await cartNamed(args.cartId);
      if (!named) return noCart;
      const result = await changed(named.token, 'update', { note: args.note }, ['note']);
      return { cart: result.cart, userErrors: result.userErrors };
    },
    cartDiscountCodesUpdate: async (args: { cartId: string; discountCodes?: string[] | null }) => {
      const named = await cartNamed(args.cartId);
      if (!named) return noCart;
      const result = await changed(
        named.token,
        'update',
        { discount: (args.discountCodes ?? []).join(',') },
        ['discountCodes'],
      );
      return { cart: result.cart, userErrors: result.userErrors };
    },
  };
}

/** How deep a query's selections go, its fragments followed. */
function depthOf(document: DocumentNode): number {
  const fragments = new Map(
    document.definitions.flatMap((definition) =>
      definition.kind === Kind.FRAGMENT_DEFINITION ? [[definition.name.value, definition]] : [],
    ),
  );
  const visit = (set: SelectionSetNode | undefined, depth: number, seen: Set<string>): number => {
    if (!set || depth > STOREFRONT_API_LIMITS.depth) return depth;
    let deepest = depth;
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        deepest = Math.max(deepest, visit(selection.selectionSet, depth + 1, seen));
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        deepest = Math.max(deepest, visit(selection.selectionSet, depth, seen));
      } else {
        const name = selection.name.value;
        if (seen.has(name)) continue;
        deepest = Math.max(
          deepest,
          visit(fragments.get(name)?.selectionSet, depth, new Set([...seen, name])),
        );
      }
    }
    return deepest;
  };
  return Math.max(
    0,
    ...document.definitions.map((definition) =>
      definition.kind === Kind.OPERATION_DEFINITION
        ? visit(definition.selectionSet, 0, new Set())
        : 0,
    ),
  );
}

/** A GraphQL request's answer, as its body is JSON. */
export async function storefrontApiAnswer(
  body: unknown,
  api: StorefrontApiShop,
): Promise<ExecutionResult> {
  const request = (typeof body === 'object' && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const query = request.query;
  if (typeof query !== 'string' || query.length === 0) {
    return { errors: [new GraphQLError('Give the query')] };
  }
  if (query.length > STOREFRONT_API_LIMITS.query) {
    return {
      errors: [new GraphQLError(`A query is ${STOREFRONT_API_LIMITS.query} characters at most`)],
    };
  }
  let document: DocumentNode;
  try {
    document = parse(query);
  } catch (error) {
    return { errors: [error as GraphQLError] };
  }
  const invalid = validate(SCHEMA, document);
  if (invalid.length > 0) return { errors: invalid };
  if (depthOf(document) > STOREFRONT_API_LIMITS.depth) {
    return {
      errors: [new GraphQLError(`A query asks ${STOREFRONT_API_LIMITS.depth} fields deep at most`)],
    };
  }
  const variables =
    typeof request.variables === 'object' && request.variables !== null
      ? (request.variables as Record<string, unknown>)
      : undefined;
  const operationName =
    typeof request.operationName === 'string' ? request.operationName : undefined;
  return execute({
    schema: SCHEMA,
    document,
    rootValue: rootOf(inContext(api, document, operationName, variables)),
    variableValues: variables,
    operationName,
  });
}

/**
 * `api` as the operation run asks for it with `@inContext` (ADR-903): in Urdu, the shop's Urdu
 * words and its pages' Urdu addresses; in any other language, its own.
 */
function inContext(
  api: StorefrontApiShop,
  document: DocumentNode,
  operationName: string | undefined,
  variables: Record<string, unknown> | undefined,
): StorefrontApiShop {
  const operations = document.definitions.filter(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  const operation = operationName
    ? operations.find((each) => each.name?.value === operationName)
    : operations.length === 1
      ? operations[0]
      : undefined;
  const directive = SCHEMA.getDirective('inContext')!;
  let asked: { language?: unknown; country?: unknown } | undefined;
  try {
    asked = operation && getDirectiveValues(directive, operation, variables);
  } catch {
    // A variable of the wrong kind: execution says so.
    asked = undefined;
  }
  const country = typeof asked?.country === 'string' ? asked.country : 'PK';
  if (asked?.language === 'UR' && api.inLanguage) {
    return { ...api, store: api.inLanguage('ur'), locale: 'ur', prefix: '/ur', country };
  }
  return { ...api, locale: 'en', prefix: '', country };
}
