// Every GraphQL document the admin sends to the Admin API, in one place: operations.test.ts
// checks each against the schema the core generates (apps/core/schema.graphql). Each is asked on
// its own where roles differ in what they may read, so one refused leaves the others shown.

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

const TALLY = /* GraphQL */ `
  fragment Tally on HomeTally {
    count
    total {
      amount
      currencyCode
    }
  }
`;

/** Home's next actions and today's numbers (ANL-01): every role that reads orders. */
export const HomeQuery = /* GraphQL */ `
  query Home {
    shop {
      timezone
    }
    home {
      toConfirm {
        ...Tally
      }
      toReview {
        ...Tally
      }
      awaitingPayment {
        ...Tally
      }
      transfersToCheck {
        ...Tally
      }
      toPack {
        ...Tally
      }
      toBook {
        ...Tally
      }
      returning {
        ...Tally
      }
      returnsToReceive {
        ...Tally
      }
      cashToCollect {
        ...Tally
      }
      lostToClaim {
        ...Tally
      }
      claimsOpen {
        ...Tally
      }
      today {
        since
        sales {
          ...Tally
        }
        salesYesterday {
          ...Tally
        }
        delivered {
          ...Tally
        }
        returnedToOrigin {
          ...Tally
        }
      }
    }
  }
  ${TALLY}
`;

/** The setup checklist for a new shop (ONB-02): owners and managers, who read its settings. */
export const SetupChecklistQuery = /* GraphQL */ `
  query SetupChecklist {
    setupChecklist {
      done
      total
      steps {
        key
        done
        count
      }
    }
  }
`;

/** A page of the shop's orders, newest first, by stage and search, with each stage's count. */
export const OrdersQuery = /* GraphQL */ `
  query Orders($first: Int, $after: String, $query: String, $stage: OrderStage) {
    orders(first: $first, after: $after, query: $query, stage: $stage) {
      nodes {
        id
        name
        createdAt
        stage
        paymentMethod
        overPlanLimit
        totalPrice {
          amount
          currencyCode
        }
        customer {
          displayName
        }
        shippingAddress {
          name
          city
        }
        risk {
          level
        }
        lineItems {
          quantity
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
    orderStageCounts {
      stage
      count
    }
  }
`;

const MONEY = /* GraphQL */ `
  fragment Money on Money {
    amount
    currencyCode
  }
`;

/** One order, for its page. */
export const OrderQuery = /* GraphQL */ `
  query Order($id: ID!) {
    shop {
      timezone
    }
    order(id: $id) {
      id
      name
      createdAt
      stage
      status
      paymentMethod
      financialStatus
      confirmationStatus
      cancelReason
      overPlanLimit
      note
      tags
      phone
      email
      source
      lineItems {
        id
        productId
        variantId
        title
        variantTitle
        sku
        quantity
        unitPrice {
          ...Money
        }
        totalPrice {
          ...Money
        }
      }
      subtotalPrice {
        ...Money
      }
      totalShippingPrice {
        ...Money
      }
      totalDiscounts {
        ...Money
      }
      transferDiscount {
        ...Money
      }
      codFee {
        ...Money
      }
      totalPrice {
        ...Money
      }
      amountPaid {
        ...Money
      }
      amountRefunded {
        ...Money
      }
      advanceDue {
        ...Money
      }
      transferReceipts {
        id
        createdAt
        mimeType
        url
      }
      customerLink {
        expiresAt
      }
      refunds {
        id
        amount {
          ...Money
        }
        method
        note
        reference
        createdAt
        receipt {
          url
          mimeType
        }
      }
      codAmount {
        ...Money
      }
      customer {
        id
        displayName
        numberOfOrders
      }
      shippingAddress {
        name
        phone
        address1
        address2
        landmark
        city
        province
        zip
        formatted
      }
      risk {
        level
        score
        reasons {
          code
          message
        }
      }
      assignee {
        id
        name
      }
      mergedInto {
        id
        name
      }
      splitFrom {
        id
        name
      }
      fulfillments {
        id
        status
        shippedAt
        deliveredAt
        returningAt
        returnedAt
        lostAt
        trackingInfo {
          company
          number
          url
        }
        fulfillmentLineItems {
          quantity
          lineItem {
            id
            title
            variantTitle
          }
        }
        events(first: 20, reverse: true) {
          nodes {
            id
            status
            message
            happenedAt
          }
        }
        claim {
          status
        }
      }
      returns {
        id
        name
        status
        createdAt
        closedAt
        note
        trackingInfo {
          company
          number
        }
        exchangeOrder {
          id
          name
        }
        returnLineItems {
          quantity
          restockedQuantity
          returnReason
          lineItem {
            id
          }
        }
      }
      events(first: 50) {
        nodes {
          id
          kind
          message
          createdAt
          editedAt
          author {
            id
            name
          }
        }
      }
    }
    paymentSessions(orderId: $id) {
      id
      gatewayName
      environment
      status
      method
      reference
      error
      createdAt
      paidAt
      amount {
        ...Money
      }
      paidAmount {
        ...Money
      }
      applied {
        ...Money
      }
      refunds {
        id
        status
        reference
        error
        createdAt
        amount {
          ...Money
        }
      }
    }
  }
  ${MONEY}
`;

const USER_ERRORS = /* GraphQL */ `
  fragment Problems on UserError {
    field
    code
    message
  }
`;

/** An order confirmed, as on the confirmation call (COD-04). */
export const OrderConfirmMutation = /* GraphQL */ `
  mutation OrderConfirm($id: ID!) {
    orderConfirm(id: $id) {
      order {
        id
        stage
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An order packed: it waits to be booked with a courier. */
export const OrderMarkPackedMutation = /* GraphQL */ `
  mutation OrderMarkPacked($id: ID!) {
    orderMarkPacked(id: $id) {
      order {
        id
        stage
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A packed mark taken back while nothing has shipped, so the order's items can change. */
export const OrderMarkUnpackedMutation = /* GraphQL */ `
  mutation OrderMarkUnpacked($id: ID!) {
    orderMarkUnpacked(id: $id) {
      order {
        id
        stage
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const EDITED_ORDER = /* GraphQL */ `
  order {
    id
    stage
    totalPrice {
      ...Money
    }
    codAmount {
      ...Money
    }
  }
  userErrors {
    ...Problems
  }
`;

/** An order's items changed while it waits to be packed (ORD-04, ADR-131). */
export const OrderEditLineItemsMutation = /* GraphQL */ `
  mutation OrderEditLineItems($id: ID!, $input: OrderEditLineItemsInput!) {
    orderEditLineItems(id: $id, input: $input) {
      ${EDITED_ORDER}
    }
  }
  ${MONEY}
  ${USER_ERRORS}
`;

/** An order's delivery charge and discount changed while it waits to be packed (ADR-134). */
export const OrderEditChargesMutation = /* GraphQL */ `
  mutation OrderEditCharges($id: ID!, $input: OrderEditChargesInput!) {
    orderEditCharges(id: $id, input: $input) {
      ${EDITED_ORDER}
    }
  }
  ${MONEY}
  ${USER_ERRORS}
`;

/** The customer's orders an order might be merged into: those waiting to be packed. */
export const OrderMergeCandidatesQuery = /* GraphQL */ `
  query OrderMergeCandidates($id: ID!) {
    order(id: $id) {
      id
      customer {
        id
        orders(first: 20) {
          nodes {
            id
            name
            createdAt
            stage
            status
            paymentMethod
            totalPrice {
              ...Money
            }
            lineItems {
              id
              title
              quantity
            }
          }
        }
      }
    }
  }
  ${MONEY}
`;

/** An order its customer placed twice merged into the other (ORD-04, ADR-132). */
export const OrderMergeMutation = /* GraphQL */ `
  mutation OrderMerge($id: ID!, $intoId: ID!) {
    orderMerge(id: $id, intoId: $intoId) {
      order {
        id
        name
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Items sent apart from an order paid on delivery, as an order of their own (ADR-135). */
export const OrderSplitMutation = /* GraphQL */ `
  mutation OrderSplit($id: ID!, $input: OrderSplitInput!) {
    orderSplit(id: $id, input: $input) {
      splitOrder {
        id
        name
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An order cancelled, for a reason; its stock let go. */
export const OrderCancelMutation = /* GraphQL */ `
  mutation OrderCancel($id: ID!, $reason: OrderCancelReason!) {
    orderCancel(id: $id, reason: $reason) {
      order {
        id
        stage
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Up to 250 orders confirmed at once (ORD-05). */
export const OrderBulkConfirmMutation = /* GraphQL */ `
  mutation OrderBulkConfirm($ids: [ID!]!) {
    orderBulkConfirm(ids: $ids) {
      orders {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Up to 250 orders packed at once (ORD-05). */
export const OrderBulkMarkPackedMutation = /* GraphQL */ `
  mutation OrderBulkMarkPacked($ids: [ID!]!) {
    orderBulkMarkPacked(ids: $ids) {
      orders {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Up to 250 orders cancelled at once for one reason, as each is on its own (ORD-05). */
export const OrderBulkCancelMutation = /* GraphQL */ `
  mutation OrderBulkCancel($ids: [ID!]!, $reason: OrderCancelReason!, $staffNote: String) {
    orderBulkCancel(ids: $ids, reason: $reason, staffNote: $staffNote) {
      orders {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Tags added to up to 250 orders at once; those they have already stay as they are (ORD-05). */
export const OrderBulkAddTagsMutation = /* GraphQL */ `
  mutation OrderBulkAddTags($ids: [ID!]!, $tags: [String!]!) {
    orderBulkAddTags(ids: $ids, tags: $tags) {
      orders {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Tags taken off up to 250 orders at once, in any case (ORD-05). */
export const OrderBulkRemoveTagsMutation = /* GraphQL */ `
  mutation OrderBulkRemoveTags($ids: [ID!]!, $tags: [String!]!) {
    orderBulkRemoveTags(ids: $ids, tags: $tags) {
      orders {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const DESK_ITEM = /* GraphQL */ `
  fragment DeskItem on ConfirmationQueueItem {
    claimedByYou
    claimedUntil
    dueAt
    overdue
    unansweredCalls
    lastCall {
      outcome
      note
      createdAt
      callBackAt
    }
    order {
      id
      name
      createdAt
      stage
      paymentMethod
      overPlanLimit
      note
      phone
      totalPrice {
        amount
        currencyCode
      }
      codAmount {
        amount
        currencyCode
      }
      shippingAddress {
        name
        city
        formatted
      }
      customer {
        displayName
        numberOfOrders
      }
      risk {
        level
        score
        reasons {
          code
          message
        }
      }
      lineItems {
        id
        title
        variantTitle
        quantity
      }
    }
  }
`;

/** The Confirmation Desk's queue (COD-04): orders due a call now, the most urgent first. */
export const ConfirmationQueueQuery = /* GraphQL */ `
  query ConfirmationQueue($first: Int) {
    shop {
      timezone
    }
    confirmationQueue(first: $first) {
      callingNow
      callingOpensAt
      dueCount
      laterCount
      overdueCount
      nodes {
        ...DeskItem
      }
    }
  }
  ${DESK_ITEM}
`;

/** The next order due, dealt to the agent asking for 15 minutes; the one they hold already. */
export const ConfirmationQueueNextMutation = /* GraphQL */ `
  mutation ConfirmationQueueNext {
    confirmationQueueNext {
      callingOpensAt
      item {
        ...DeskItem
      }
    }
  }
  ${DESK_ITEM}
`;

/** A call that confirmed nothing: not answered, call back later, or someone else's number. */
export const OrderConfirmationCallMutation = /* GraphQL */ `
  mutation OrderConfirmationCall(
    $id: ID!
    $outcome: ConfirmationCallOutcome!
    $note: String
    $callBackAt: DateTime
  ) {
    orderConfirmationCall(id: $id, outcome: $outcome, note: $note, callBackAt: $callBackAt) {
      order {
        id
        stage
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The customer's number in full, for an agent about to call; every reveal is logged. */
export const OrderPhoneRevealMutation = /* GraphQL */ `
  mutation OrderPhoneReveal($id: ID!) {
    orderPhoneReveal(id: $id) {
      phone
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A page of the shop's products, newest first, by status and search (CAT-04). */
export const ProductsQuery = /* GraphQL */ `
  query Products($first: Int, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      nodes {
        id
        title
        status
        productType
        vendor
        totalInventory
        tracksInventory
        priceRange {
          minVariantPrice {
            amount
            currencyCode
          }
          maxVariantPrice {
            amount
            currencyCode
          }
        }
        media {
          id
          status
          previewImage {
            url
          }
        }
        variants {
          id
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const PRODUCT = /* GraphQL */ `
  fragment ProductDetail on Product {
    id
    title
    description
    handle
    status
    productType
    vendor
    tags
    totalInventory
    tracksInventory
    options {
      id
      name
      optionValues {
        id
        name
      }
    }
    media {
      id
      status
      alt
      position
      mediaContentType
      previewImage {
        url
      }
      mediaErrors {
        message
      }
    }
    variants {
      id
      title
      price {
        ...Money
      }
      compareAtPrice {
        ...Money
      }
      sku
      taxCode
      selectedOptions {
        name
        value
      }
      inventoryQuantity
      inventoryItem {
        id
        tracked
        inventoryPolicy
        inventoryLevels {
          available
          location {
            id
          }
        }
      }
    }
  }
`;

/** One product, for its page, with the location its stock is counted at. */
export const ProductQuery = /* GraphQL */ `
  query Product($id: ID!) {
    location {
      id
      name
    }
    product(id: $id) {
      ...ProductDetail
    }
  }
  ${PRODUCT}
  ${MONEY}
`;

/** The location stock is counted at when a product is added: the shop's primary one. */
export const PrimaryLocationQuery = /* GraphQL */ `
  query PrimaryLocation {
    location {
      id
      name
    }
  }
`;

/** A product added, with its options and a variant for each of their values (CAT-01). */
export const ProductCreateMutation = /* GraphQL */ `
  mutation ProductCreate($input: ProductCreateInput!) {
    productCreate(input: $input) {
      product {
        id
        variants {
          id
          inventoryItem {
            id
          }
          selectedOptions {
            name
            value
          }
        }
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A product's own details changed: title, description, status, type, vendor, tags. */
export const ProductUpdateMutation = /* GraphQL */ `
  mutation ProductUpdate($input: ProductUpdateInput!) {
    productUpdate(input: $input) {
      product {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Its variants' prices and SKUs changed, together. */
export const ProductVariantsBulkUpdateMutation = /* GraphQL */ `
  mutation ProductVariantsBulkUpdate(
    $productId: ID!
    $variants: [ProductVariantsBulkUpdateInput!]!
  ) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Stock counted: how many are available at a location, which tracks the variant from then on. */
export const InventorySetQuantitiesMutation = /* GraphQL */ `
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An option renamed, or values added to it or deleted where no variant uses them (CAT-01). */
export const ProductOptionUpdateMutation = /* GraphQL */ `
  mutation ProductOptionUpdate(
    $productId: ID!
    $option: ProductOptionUpdateInput!
    $optionValuesToAdd: [String!]
    $optionValuesToDelete: [ID!]
  ) {
    productOptionUpdate(
      productId: $productId
      option: $option
      optionValuesToAdd: $optionValuesToAdd
      optionValuesToDelete: $optionValuesToDelete
    ) {
      product {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Options added to a product, its variants given their first values or every combination made. */
export const ProductOptionsCreateMutation = /* GraphQL */ `
  mutation ProductOptionsCreate(
    $productId: ID!
    $options: [ProductOptionInput!]!
    $variantStrategy: ProductOptionCreateVariantStrategy!
  ) {
    productOptionsCreate(
      productId: $productId
      options: $options
      variantStrategy: $variantStrategy
    ) {
      product {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Options taken away, unless the variants would then be the same. */
export const ProductOptionsDeleteMutation = /* GraphQL */ `
  mutation ProductOptionsDelete($productId: ID!, $options: [ID!]!) {
    productOptionsDelete(productId: $productId, options: $options) {
      deletedOptionsIds
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Variants added for combinations the product lacks. */
export const ProductVariantsBulkCreateMutation = /* GraphQL */ `
  mutation ProductVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Variants deleted, with their stock; one always kept. */
export const ProductVariantsBulkDeleteMutation = /* GraphQL */ `
  mutation ProductVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      product {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A variant's stock tracked or not, and sold or not once none is available (INV-01). */
export const InventoryItemUpdateMutation = /* GraphQL */ `
  mutation InventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem {
        id
        tracked
        inventoryPolicy
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A product deleted, with its variants and their stock. */
export const ProductDeleteMutation = /* GraphQL */ `
  mutation ProductDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Where to upload files the merchant chose, up to 10 at a time, for an hour (ADR-079). */
export const StagedUploadsCreateMutation = /* GraphQL */ `
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        httpMethod
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Photos uploaded, added to a product after the ones it has; each is made ready in moments. */
export const ProductCreateMediaMutation = /* GraphQL */ `
  mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        id
        status
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Photos removed from a product. */
export const ProductDeleteMediaMutation = /* GraphQL */ `
  mutation ProductDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A photo's description, for screen readers and search engines (CAT-02). */
export const ProductUpdateMediaMutation = /* GraphQL */ `
  mutation ProductUpdateMedia($productId: ID!, $media: [UpdateMediaInput!]!) {
    productUpdateMedia(productId: $productId, media: $media) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A photo moved, to be the product's first: the one its listings show. */
export const ProductReorderMediaMutation = /* GraphQL */ `
  mutation ProductReorderMedia($productId: ID!, $moves: [MoveInput!]!) {
    productReorderMedia(productId: $productId, moves: $moves) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A page of the shop's customers, newest first, searched by mobile, name or email (CUS-01). */
export const CustomersQuery = /* GraphQL */ `
  query Customers($first: Int, $after: String, $query: String) {
    customers(first: $first, after: $after, query: $query) {
      nodes {
        id
        displayName
        phone
        numberOfOrders
        lastOrderAt
        tags
        amountSpent {
          amount
          currencyCode
        }
        blocklistEntry {
          id
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** One customer, for their page: what they ordered and how their deliveries went. */
export const CustomerQuery = /* GraphQL */ `
  query Customer($id: ID!) {
    shop {
      timezone
    }
    customer(id: $id) {
      id
      displayName
      name
      phone
      otherPhones
      email
      note
      tags
      createdAt
      numberOfOrders
      lastOrderAt
      amountSpent {
        ...Money
      }
      deliveryHistory {
        delivered
        returned
        cancelled
        inProgress
        lost
      }
      blocklistEntry {
        id
        reason
        note
        createdAt
      }
      whatsappMarketingConsent {
        marketingState
      }
      smsMarketingConsent {
        marketingState
      }
      emailMarketingConsent {
        marketingState
      }
      erasureScheduledAt
      addresses {
        formatted
      }
      orders(first: 20) {
        nodes {
          id
          name
          createdAt
          stage
          totalPrice {
            ...Money
          }
        }
      }
    }
  }
  ${MONEY}
`;

/** A customer's note or tags changed. */
export const CustomerUpdateMutation = /* GraphQL */ `
  mutation CustomerUpdate($id: ID!, $input: CustomerUpdateInput!) {
    customerUpdate(id: $id, input: $input) {
      customer {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A customer's numbers in full, for staff who see them masked; every reveal is logged. */
export const CustomerPhoneRevealMutation = /* GraphQL */ `
  mutation CustomerPhoneReveal($id: ID!) {
    customerPhoneReveal(id: $id) {
      phone
      otherPhones
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's blocked numbers, the latest blocked first, found by a number or its digits (COD-07). */
export const BlocklistQuery = /* GraphQL */ `
  query Blocklist($first: Int!, $after: String, $query: String) {
    blocklist(first: $first, after: $after, query: $query) {
      nodes {
        id
        phone
        reason
        note
        createdAt
        customer {
          id
          displayName
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** A number blocked: its new orders wait for review (COD-07). */
export const BlocklistAddMutation = /* GraphQL */ `
  mutation BlocklistAdd($input: BlocklistAddInput!) {
    blocklistAdd(input: $input) {
      blocklistEntry {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A number taken off the blocklist; orders already held stay held. */
export const BlocklistRemoveMutation = /* GraphQL */ `
  mutation BlocklistRemove($phone: String!) {
    blocklistRemove(phone: $phone) {
      deletedBlocklistEntryId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const BOOKING = /* GraphQL */ `
  fragment Booking on CourierBooking {
    id
    accountId
    orderId
    orderName
    courierName
    status
    parcelStatus
    trackingNumber
    error
    createdAt
    bookedAt
    codAmount {
      amount
      currencyCode
    }
  }
`;

/** The shop's courier accounts and its latest bookings with them (SHP-01, SHP-02). */
export const ShippingQuery = /* GraphQL */ `
  query Shipping($first: Int, $after: String) {
    shop {
      timezone
    }
    courierAccounts {
      id
      name
      courierName
      isDefault
    }
    courierBookings(first: $first, after: $after) {
      nodes {
        ...Booking
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
  ${BOOKING}
`;

/** Packed orders booked with a courier account, each on its own; some refused, with why. */
export const OrdersBookMutation = /* GraphQL */ `
  mutation OrdersBook($ids: [ID!]!, $accountId: ID) {
    ordersBook(ids: $ids, accountId: $accountId) {
      bookings {
        id
        orderName
      }
      refused {
        orderId
        message
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const COURIER_CITY_MATCH = /* GraphQL */ `
  fragment CityMatch on CourierCityMatch {
    city
    courierCity
    source
    suggestions
    listError
  }
`;

/** The city an order goes to, as its address writes it, for its courier's name for it. */
export const OrderCityQuery = /* GraphQL */ `
  query OrderCity($id: ID!) {
    order(id: $id) {
      id
      name
      shippingAddress {
        city
      }
    }
  }
`;

/** How a city matches a courier account's courier's names for its cities, or the nearest (SHP-03). */
export const CourierCityMatchQuery = /* GraphQL */ `
  query CourierCityMatch($accountId: ID!, $city: String!) {
    courierCityMatch(accountId: $accountId, city: $city) {
      ...CityMatch
    }
  }
  ${COURIER_CITY_MATCH}
`;

/** The shop's own names for cities with a courier account's courier, and its accounts. */
export const CourierCityNamesQuery = /* GraphQL */ `
  query CourierCityNames($accountId: ID!) {
    courierAccounts {
      id
      name
      courierName
    }
    courierCityNames(accountId: $accountId) {
      city
      courierCity
      updatedAt
    }
  }
`;

/** The shop's own name for a city with a courier account's courier kept, or forgotten (null). */
export const CourierCityNameSetMutation = /* GraphQL */ `
  mutation CourierCityNameSet($input: CourierCityNameInput!) {
    courierCityNameSet(input: $input) {
      match {
        ...CityMatch
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${COURIER_CITY_MATCH}
  ${USER_ERRORS}
`;

/** A booking cancelled while it waits to be booked. */
export const CourierBookingCancelMutation = /* GraphQL */ `
  mutation CourierBookingCancel($id: ID!) {
    courierBookingCancel(id: $id) {
      courierBooking {
        id
        status
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Booked parcels' labels, a page to print. */
export const CourierLabelsQuery = /* GraphQL */ `
  query CourierLabels($ids: [ID!]!, $language: DocumentLanguage!, $paper: PaperSize!) {
    courierLabels(ids: $ids, language: $language, paper: $paper) {
      title
      html
    }
  }
`;

/**
 * Packing slips or invoices for orders, a page each, to print from the browser (ORD-06): on A4 or
 * thermal paper, in English, Urdu or both.
 */
export const OrderDocumentQuery = /* GraphQL */ `
  query OrderDocument(
    $ids: [ID!]!
    $kind: OrderDocumentKind!
    $language: DocumentLanguage!
    $paper: PaperSize!
  ) {
    orderDocument(ids: $ids, kind: $kind, language: $language, paper: $paper) {
      title
      html
    }
  }
`;

/** A courier account's load sheet: its parcels waiting for the rider, a page to print. */
export const CourierLoadSheetQuery = /* GraphQL */ `
  query CourierLoadSheet($accountId: ID, $language: DocumentLanguage!, $pickupId: ID) {
    courierLoadSheet(accountId: $accountId, language: $language, pickupId: $pickupId) {
      title
      html
    }
  }
`;

const PICKUP = /* GraphQL */ `
  fragment Pickup on CourierPickup {
    id
    accountId
    courierName
    status
    parcelCount
    reference
    loadSheetUrl
    error
    riderName
    riderCode
    createdAt
    requestedAt
  }
`;

/** The pickups asked of couriers, the latest first, and which couriers take them (SHP-02). */
export const PickupsQuery = /* GraphQL */ `
  query Pickups {
    shop {
      timezone
    }
    couriers {
      courier
      pickups {
        rider
      }
    }
    courierAccounts {
      id
      name
      courier
      courierName
      isDefault
    }
    courierPickups(first: 20) {
      ...Pickup
    }
  }
  ${PICKUP}
`;

/** A courier asked to collect the parcels waiting, through its API. */
export const CourierPickupRequestMutation = /* GraphQL */ `
  mutation CourierPickupRequest($input: CourierPickupInput!) {
    courierPickupRequest(input: $input) {
      courierPickup {
        ...Pickup
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${PICKUP}
  ${USER_ERRORS}
`;

/** The couriers shops book with here, with what each asks for to connect (SHP-01). */
export const CourierAccountsQuery = /* GraphQL */ `
  query CourierAccounts {
    couriers {
      courier
      name
      test
      pickupCode
      credentials {
        key
        label
      }
    }
    courierAccounts {
      id
      name
      courier
      courierName
      isDefault
      credentialsHint
      pickupCode
      createdAt
    }
  }
`;

const COURIER_ACCOUNT_PAYLOAD = /* GraphQL */ `
  fragment AccountPayload on CourierAccountPayload {
    courierAccount {
      id
      name
      isDefault
    }
    userErrors {
      ...Problems
    }
  }
`;

/** The shop's own account with a courier connected, its credentials sealed. */
export const CourierAccountConnectMutation = /* GraphQL */ `
  mutation CourierAccountConnect($input: CourierAccountInput!) {
    courierAccountConnect(input: $input) {
      ...AccountPayload
    }
  }
  ${COURIER_ACCOUNT_PAYLOAD}
  ${USER_ERRORS}
`;

/** A courier account renamed, given new credentials, or made the default. */
export const CourierAccountUpdateMutation = /* GraphQL */ `
  mutation CourierAccountUpdate($id: ID!, $input: CourierAccountInput!) {
    courierAccountUpdate(id: $id, input: $input) {
      ...AccountPayload
    }
  }
  ${COURIER_ACCOUNT_PAYLOAD}
  ${USER_ERRORS}
`;

/** A courier account archived: no more bookings with it; its parcels still followed. */
export const CourierAccountArchiveMutation = /* GraphQL */ `
  mutation CourierAccountArchive($id: ID!) {
    courierAccountArchive(id: $id) {
      ...AccountPayload
    }
  }
  ${COURIER_ACCOUNT_PAYLOAD}
  ${USER_ERRORS}
`;

/** Who works in the shop, and the invitations still open (ADR-101). */
export const StaffQuery = /* GraphQL */ `
  query Staff {
    staffMembers {
      id
      name
      email
      role
      joinedAt
    }
    staffInvitations {
      id
      role
      note
      email
      invitedBy
      expiresAt
    }
  }
`;

/** Someone invited to work in the shop by a link, emailed too where an address is given. */
export const StaffInvitationCreateMutation = /* GraphQL */ `
  mutation StaffInvitationCreate(
    $role: StaffMemberRole!
    $note: String
    $email: String
    $language: EmailLanguage
  ) {
    staffInvitationCreate(role: $role, note: $note, email: $email, language: $language) {
      token
      emailed
      invitation {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An invitation still waiting emailed again, by a new link that takes its place (ADR-196). */
export const StaffInvitationResendMutation = /* GraphQL */ `
  mutation StaffInvitationResend($id: ID!, $language: EmailLanguage) {
    staffInvitationResend(id: $id, language: $language) {
      token
      emailed
      invitation {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop handed to one of its managers; the owner stays on as a manager. */
export const ShopOwnershipTransferMutation = /* GraphQL */ `
  mutation ShopOwnershipTransfer($staffMemberId: ID!) {
    shopOwnershipTransfer(staffMemberId: $staffMemberId) {
      owner {
        id
        name
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An invitation taken back: its link opens nothing after. */
export const StaffInvitationRevokeMutation = /* GraphQL */ `
  mutation StaffInvitationRevoke($id: ID!) {
    staffInvitationRevoke(id: $id) {
      invitation {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A staff member given another role, from their next request. */
export const StaffMemberRoleUpdateMutation = /* GraphQL */ `
  mutation StaffMemberRoleUpdate($id: ID!, $role: StaffMemberRole!) {
    staffMemberRoleUpdate(id: $id, role: $role) {
      staffMember {
        id
        role
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A staff member let go: the shop is closed to them from their next request. */
export const StaffMemberRemoveMutation = /* GraphQL */ `
  mutation StaffMemberRemove($id: ID!) {
    staffMemberRemove(id: $id) {
      removedStaffMemberId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const DELIVERY_SETTINGS = /* GraphQL */ `
  fragment Delivery on DeliverySettings {
    charge {
      ...Money
    }
    freeAbove {
      ...Money
    }
    days {
      min
      max
    }
    zones {
      name
      cities
      charge {
        ...Money
      }
      days {
        min
        max
      }
    }
    updatedAt
  }
`;

/** What the shop charges to deliver an order, and how long delivery takes (CHK-22). */
export const DeliverySettingsQuery = /* GraphQL */ `
  query DeliverySettings {
    deliverySettings {
      ...Delivery
    }
  }
  ${DELIVERY_SETTINGS}
  ${MONEY}
`;

/** Delivery's charges and days changed, its zones replaced; for checkouts from now on. */
export const DeliverySettingsUpdateMutation = /* GraphQL */ `
  mutation DeliverySettingsUpdate($input: DeliverySettingsUpdateInput!) {
    deliverySettingsUpdate(input: $input) {
      deliverySettings {
        ...Delivery
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${DELIVERY_SETTINGS}
  ${MONEY}
  ${USER_ERRORS}
`;

const COD_SETTINGS = /* GraphQL */ `
  fragment CashOnDelivery on CashOnDeliverySettings {
    fee {
      ...Money
    }
    maxOrderTotal {
      ...Money
    }
    refusedDeliveriesLimit
    riskScoreLimit
    verifyFromScore
    unavailableCities
    unavailableProductTags
    advance {
      kind
      amount {
        ...Money
      }
      percentage
      above {
        ...Money
      }
      cities
      productTags
      newCustomers
      refusedDeliveries
      riskScore
    }
    updatedAt
  }
`;

/** The shop's rules for cash on delivery at checkout (CHK-07, CHK-08, CHK-09, CHK-10). */
export const CashOnDeliverySettingsQuery = /* GraphQL */ `
  query CashOnDeliverySettings {
    cashOnDeliverySettings {
      ...CashOnDelivery
    }
    bankTransferSettings {
      enabled
      account {
        iban
      }
    }
  }
  ${COD_SETTINGS}
  ${MONEY}
`;

/** Cash on delivery's rules changed, for checkouts from now on. */
export const CashOnDeliverySettingsUpdateMutation = /* GraphQL */ `
  mutation CashOnDeliverySettingsUpdate($input: CashOnDeliverySettingsInput!) {
    cashOnDeliverySettingsUpdate(input: $input) {
      cashOnDeliverySettings {
        ...CashOnDelivery
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${COD_SETTINGS}
  ${MONEY}
  ${USER_ERRORS}
`;

const BANK_TRANSFER_SETTINGS = /* GraphQL */ `
  fragment BankTransfer on BankTransferSettings {
    enabled
    account {
      bankName
      title
      iban
      raastId
      instructions
    }
    discount {
      kind
      amount {
        ...Money
      }
      percentage
      cap {
        ...Money
      }
    }
    updatedAt
  }
`;

/** The account customers pay into by bank transfer, and whether checkout offers it (PAY-02). */
export const BankTransferSettingsQuery = /* GraphQL */ `
  query BankTransferSettings {
    bankTransferSettings {
      ...BankTransfer
    }
  }
  ${BANK_TRANSFER_SETTINGS}
  ${MONEY}
`;

/** Bank transfer turned on or off, its account or discount changed; confirmed recently. */
export const BankTransferSettingsUpdateMutation = /* GraphQL */ `
  mutation BankTransferSettingsUpdate($input: BankTransferSettingsInput!) {
    bankTransferSettingsUpdate(input: $input) {
      bankTransferSettings {
        ...BankTransfer
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${BANK_TRANSFER_SETTINGS}
  ${MONEY}
  ${USER_ERRORS}
`;

const GATEWAY_ACCOUNT = /* GraphQL */ `
  fragment GatewayAccount on PaymentGatewayAccount {
    id
    gateway
    gatewayName
    environment
    credentialsHint
    webhookUrl
    createdAt
  }
`;

/** What checkout takes off orders paid online (PAY-05, CHK-08). */
const ONLINE_PAYMENT_SETTINGS = /* GraphQL */ `
  fragment OnlinePaymentSettingsFields on OnlinePaymentSettings {
    updatedAt
    discount {
      kind
      percentage
      cap {
        ...Money
      }
      amount {
        ...Money
      }
    }
  }
`;

/** The gateways shops take payments online through, and the shop's accounts with them (PAY-01). */
export const PaymentGatewaysQuery = /* GraphQL */ `
  query PaymentGateways {
    paymentGateways {
      gateway
      name
      test
      refunds
      credentials {
        key
        label
        optional
      }
    }
    paymentGatewayAccounts {
      ...GatewayAccount
    }
    onlinePaymentSettings {
      ...OnlinePaymentSettingsFields
    }
  }
  ${GATEWAY_ACCOUNT}
  ${ONLINE_PAYMENT_SETTINGS}
  ${MONEY}
`;

/** What checkout takes off orders paid online, replaced; null takes it away (PAY-05, CHK-08). */
export const OnlinePaymentSettingsUpdateMutation = /* GraphQL */ `
  mutation OnlinePaymentSettingsUpdate($input: OnlinePaymentSettingsInput!) {
    onlinePaymentSettingsUpdate(input: $input) {
      onlinePaymentSettings {
        ...OnlinePaymentSettingsFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${ONLINE_PAYMENT_SETTINGS}
  ${MONEY}
  ${USER_ERRORS}
`;

/** The shop's own account with a gateway connected, its credentials sealed; confirmed recently. */
export const PaymentGatewayAccountConnectMutation = /* GraphQL */ `
  mutation PaymentGatewayAccountConnect($input: PaymentGatewayAccountInput!) {
    paymentGatewayAccountConnect(input: $input) {
      paymentGatewayAccount {
        ...GatewayAccount
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${GATEWAY_ACCOUNT}
  ${USER_ERRORS}
`;

/** A gateway account archived: no new payments through it. */
export const PaymentGatewayAccountArchiveMutation = /* GraphQL */ `
  mutation PaymentGatewayAccountArchive($id: ID!) {
    paymentGatewayAccountArchive(id: $id) {
      paymentGatewayAccount {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The order customers are offered the shop's gateways in (PAY-05). */
export const PaymentGatewayAccountsReorderMutation = /* GraphQL */ `
  mutation PaymentGatewayAccountsReorder($ids: [ID!]!) {
    paymentGatewayAccountsReorder(ids: $ids) {
      paymentGatewayAccounts {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's logos and WhatsApp number, as its storefront, checkout and links show them. */
export const ShopDetailsQuery = /* GraphQL */ `
  query ShopDetails {
    shop {
      brand {
        logo {
          id
          url
        }
        squareLogo {
          id
          url
        }
      }
    }
    onlineStorePreferences {
      whatsappNumber
    }
  }
`;

/** Uploads made files of the shop's (ADR-079), to use as its logos. */
export const FileCreateMutation = /* GraphQL */ `
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's logo or square logo set, or taken away (ADR-081, ADR-205). */
export const ShopBrandUpdateMutation = /* GraphQL */ `
  mutation ShopBrandUpdate($input: ShopBrandInput!) {
    shopBrandUpdate(input: $input) {
      brand {
        updatedAt
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The number the storefront's "Order on WhatsApp" links go to, among its preferences. */
export const OnlineStorePreferencesUpdateMutation = /* GraphQL */ `
  mutation OnlineStorePreferencesUpdate($input: OnlineStorePreferencesInput!) {
    onlineStorePreferencesUpdate(input: $input) {
      preferences {
        whatsappNumber
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const BILLING_PLAN = /* GraphQL */ `
  fragment Plan on BillingPlan {
    code
    name
    monthlyPrice {
      ...Money
    }
    yearlyPrice {
      ...Money
    }
    orderLimit
    staffLimit
    locationLimit
    customDomains
    onlineGateways
  }
`;

const BILLING_INVOICE = /* GraphQL */ `
  fragment Invoice on BillingInvoice {
    id
    name
    reason
    status
    interval
    createdAt
    paidAt
    amount {
      ...Money
    }
    plan {
      name
    }
    transfers {
      id
      reference
      status
      refusal
      reportedAt
    }
  }
`;

/** The shop's plan with Hatti, the plans, its message credit and its invoices (BIL-01, BIL-03). */
export const BillingQuery = /* GraphQL */ `
  query Billing {
    billingSubscription {
      plan {
        ...Plan
      }
      interval
      periodEnd
      pastDue
      nextPlan {
        name
      }
      openInvoice {
        ...Invoice
      }
    }
    billingPlans {
      ...Plan
    }
    billingWallet {
      balance {
        ...Money
      }
      openInvoice {
        ...Invoice
      }
    }
    billingInvoices(first: 20) {
      ...Invoice
    }
    billingBankAccount {
      bankName
      title
      iban
      raastId
    }
  }
  ${BILLING_PLAN}
  ${BILLING_INVOICE}
  ${MONEY}
`;

/** Another plan chosen: a bigger one invoiced now, a smaller one from the period's end. */
export const BillingPlanChangeMutation = /* GraphQL */ `
  mutation BillingPlanChange($input: BillingPlanChangeInput!) {
    billingPlanChange(input: $input) {
      invoice {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An invoice paid through Hatti's own gateway: its page to send the owner to. */
export const BillingInvoicePayMutation = /* GraphQL */ `
  mutation BillingInvoicePay($id: ID!) {
    billingInvoicePay(id: $id) {
      checkoutUrl
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An invoice said to be paid by transfer or Raast, for Hatti's people to find. */
export const BillingInvoiceTransferReportMutation = /* GraphQL */ `
  mutation BillingInvoiceTransferReport($id: ID!, $reference: String!) {
    billingInvoiceTransferReport(id: $id, reference: $reference) {
      transfer {
        id
        status
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Message credit chosen to buy: an invoice, the shop's credit once paid. */
export const BillingCreditsBuyMutation = /* GraphQL */ `
  mutation BillingCreditsBuy($input: BillingCreditsBuyInput!) {
    billingCreditsBuy(input: $input) {
      invoice {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const DISCOUNT_CODE = /* GraphQL */ `
  fragment Discount on DiscountCode {
    id
    code
    title
    kind
    summary
    status
    usageCount
    usageLimit
    startsAt
    endsAt
  }
`;

/** The shop's discount codes, newest first, with what each gives and how often it was used. */
export const DiscountCodesQuery = /* GraphQL */ `
  query DiscountCodes($query: String) {
    discountCodes(first: 100, query: $query) {
      nodes {
        ...Discount
      }
    }
  }
  ${DISCOUNT_CODE}
`;

/** A discount code made (CHK-06). */
export const DiscountCodeCreateMutation = /* GraphQL */ `
  mutation DiscountCodeCreate($discountCode: DiscountCodeInput!) {
    discountCodeCreate(discountCode: $discountCode) {
      discountCode {
        ...Discount
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${DISCOUNT_CODE}
  ${USER_ERRORS}
`;

/** A discount code changed: here, ended now. */
export const DiscountCodeUpdateMutation = /* GraphQL */ `
  mutation DiscountCodeUpdate($id: ID!, $discountCode: DiscountCodeInput!) {
    discountCodeUpdate(id: $id, discountCode: $discountCode) {
      discountCode {
        id
        status
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A discount code deleted; orders placed with it keep what it took off. */
export const DiscountCodeDeleteMutation = /* GraphQL */ `
  mutation DiscountCodeDelete($id: ID!) {
    discountCodeDelete(id: $id) {
      deletedDiscountCodeId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's draft orders, newest first, open or completed (ORD-03). */
export const DraftOrdersQuery = /* GraphQL */ `
  query DraftOrders($query: String, $status: DraftOrderStatus) {
    draftOrders(first: 50, query: $query, status: $status) {
      nodes {
        id
        name
        status
        source
        createdAt
        totalPrice {
          ...Money
        }
        shippingAddress {
          name
          city
        }
        lineItems {
          quantity
        }
      }
    }
  }
  ${MONEY}
`;

/** One draft, for its page. */
export const DraftOrderQuery = /* GraphQL */ `
  query DraftOrder($id: ID!) {
    draftOrder(id: $id) {
      id
      name
      status
      source
      paymentMethod
      note
      createdAt
      linkExpiresAt
      phone
      lineItems {
        variantId
        title
        variantTitle
        quantity
        unitPrice {
          ...Money
        }
        totalPrice {
          ...Money
        }
      }
      shippingAddress {
        formatted
        name
        phone
        city
        address1
        address2
        landmark
        province
        zip
        latitude
        longitude
      }
      subtotalPrice {
        ...Money
      }
      totalShippingPrice {
        ...Money
      }
      totalDiscounts {
        ...Money
      }
      totalPrice {
        ...Money
      }
      codAmount {
        ...Money
      }
      order {
        id
        name
      }
    }
  }
  ${MONEY}
`;

/** An open draft changed: only what is given, each line at its price as sent (ORD-03). */
export const DraftOrderUpdateMutation = /* GraphQL */ `
  mutation DraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Products found by words, with their variants' prices and stock, to add to a draft. */
export const DraftVariantsQuery = /* GraphQL */ `
  query DraftVariants($query: String) {
    products(first: 10, query: $query) {
      nodes {
        id
        title
        variants {
          id
          title
          availableForSale
          inventoryQuantity
          price {
            ...Money
          }
        }
      }
    }
  }
  ${MONEY}
`;

/** A draft started, as a customer picks items in a chat or on a call. */
export const DraftOrderCreateMutation = /* GraphQL */ `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The draft's link for its customer to fill in the address and confirm, shown once. */
export const DraftOrderLinkCreateMutation = /* GraphQL */ `
  mutation DraftOrderLinkCreate($id: ID!) {
    draftOrderLinkCreate(id: $id) {
      url
      whatsappUrl
      draftOrder {
        id
        linkExpiresAt
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The draft placed as an order, as the customer agreed in the chat. */
export const DraftOrderCompleteMutation = /* GraphQL */ `
  mutation DraftOrderComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder {
        id
        order {
          id
          name
        }
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An open draft deleted, and its link with it. */
export const DraftOrderDeleteMutation = /* GraphQL */ `
  mutation DraftOrderDelete($id: ID!) {
    draftOrderDelete(id: $id) {
      deletedId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** What the shop's staff and apps changed, newest first, and who works there to name them by. */
export const ActivityQuery = /* GraphQL */ `
  query Activity($first: Int) {
    activityLog(first: $first) {
      nodes {
        id
        type
        subjectType
        subjectId
        occurredAt
        actor {
          id
          kind
          role
        }
      }
      pageInfo {
        hasNextPage
      }
    }
    staffMembers {
      id
      name
    }
  }
`;

/** What the shop may need to account for: numbers seen, exports, erasures, support's looks. */
export const AuditQuery = /* GraphQL */ `
  query Audit($first: Int) {
    auditLog(first: $first) {
      nodes {
        id
        action
        subjectId
        occurredAt
        actor {
          id
          kind
          role
        }
      }
      pageInfo {
        hasNextPage
      }
    }
    staffMembers {
      id
      name
    }
  }
`;

const SALES_TOTALS = /* GraphQL */ `
  fragment SalesTotals on Sales {
    orders
    netSales {
      ...Money
    }
    totalSales {
      ...Money
    }
    averageOrderValue {
      ...Money
    }
    returns {
      ...Money
    }
    profit {
      ...Money
    }
  }
`;

/** Sales over a period by day or week, against the period before, with what sold most (ANL-02). */
export const SalesQuery = /* GraphQL */ `
  query Sales($placedFrom: DateTime!, $placedBefore: DateTime!, $interval: SalesInterval!) {
    salesReport(
      placedFrom: $placedFrom
      placedBefore: $placedBefore
      interval: $interval
      by: SOURCE
      topProducts: 5
    ) {
      totals {
        ...SalesTotals
      }
      previous {
        totals {
          ...SalesTotals
        }
      }
      periods {
        start
        sales {
          orders
          netSales {
            ...Money
          }
        }
      }
      topProducts {
        productId
        title
        unitsSold
        grossSales {
          ...Money
        }
      }
      rows {
        key
        title
        sales {
          orders
          netSales {
            ...Money
          }
        }
      }
    }
  }
  ${SALES_TOTALS}
  ${MONEY}
`;

const STOREFRONT_SESSION_COUNTS = /* GraphQL */ `
  fragment StorefrontSessionCounts on StorefrontSessions {
    sessions
    addedToCart
    reachedCheckout
    converted
    conversionRate
  }
`;

/**
 * The online store's sessions over a period, day by day or week by week, and the period as long
 * before it, which ends where this one starts (ANL-02, ADR-180).
 */
export const StorefrontSessionsQuery = /* GraphQL */ `
  query StorefrontSessions(
    $from: DateTime!
    $before: DateTime!
    $previousFrom: DateTime!
    $interval: SalesInterval!
  ) {
    storefrontSessions(from: $from, before: $before, interval: $interval) {
      totals {
        ...StorefrontSessionCounts
      }
      periods {
        start
        sessions {
          sessions
          converted
        }
      }
    }
    previous: storefrontSessions(from: $previousFrom, before: $from, interval: $interval) {
      totals {
        ...StorefrontSessionCounts
      }
    }
  }
  ${STOREFRONT_SESSION_COUNTS}
`;

/** Who is on the online store now, and today's sessions so far (ANL-02, ADR-180). */
export const StorefrontLiveViewQuery = /* GraphQL */ `
  query StorefrontLiveView {
    storefrontLiveView {
      visitorsNow
      today {
        ...StorefrontSessionCounts
      }
    }
  }
  ${STOREFRONT_SESSION_COUNTS}
`;

const COD_DELIVERY = /* GraphQL */ `
  fragment CodDeliveryFigures on CodDelivery {
    shipped
    delivered
    returned
    inTransit
    successRate
    returnRate
    returnCharges {
      ...Money
    }
  }
`;

/** How a period's cash-on-delivery orders turned out, broken down by one thing (COD-12). */
export const CodHealthQuery = /* GraphQL */ `
  query CodHealth($placedFrom: DateTime!, $placedBefore: DateTime!, $by: CodHealthDimension) {
    codHealth(placedFrom: $placedFrom, placedBefore: $placedBefore, by: $by, first: 20) {
      confirmation {
        placed
        confirmed
        cancelled
        awaiting
        rate
      }
      delivery {
        ...CodDeliveryFigures
      }
      rows {
        key
        title
        confirmation {
          placed
          rate
        }
        delivery {
          ...CodDeliveryFigures
        }
      }
    }
  }
  ${COD_DELIVERY}
  ${MONEY}
`;

/**
 * How each agent of the Confirmation Desk did over a period (COD-11), and the staff's names for
 * them: both for owners and managers alone.
 */
export const ConfirmationAgentsQuery = /* GraphQL */ `
  query ConfirmationAgents($from: DateTime!, $before: DateTime!) {
    confirmationAgents(from: $from, before: $before) {
      id
      kind
      confirmed
      cancelled
      confirmationRate
      confirmationsPerHour
      activeHours
      calls {
        noAnswer
        callBack
        wrongNumber
      }
      delivery {
        ...CodDeliveryFigures
      }
    }
    staffMembers {
      id
      name
    }
  }
  ${COD_DELIVERY}
  ${MONEY}
`;

const COD_REMITTANCE_SUMMARY = /* GraphQL */ `
  fragment CodRemittanceSummary on CodRemittance {
    id
    courier
    reference
    createdAt
    lineCount
    issueCount
    collected {
      ...Money
    }
    paid {
      ...Money
    }
    received {
      ...Money
    }
  }
`;

const COD_AGE = /* GraphQL */ `
  fragment CodAge on CodReceivableAge {
    fromDays
    toDays
    count
    amount {
      ...Money
    }
  }
`;

/** The cash couriers hold for the shop, and their statements (COD-10). */
export const CashQuery = /* GraphQL */ `
  query Cash {
    codReceivables {
      owed {
        count
        amount {
          ...Money
        }
      }
      onTheWay {
        count
        amount {
          ...Money
        }
      }
      ages {
        ...CodAge
      }
      couriers {
        courier
        oldestDeliveredAt
        owed {
          count
          amount {
            ...Money
          }
        }
        ages {
          ...CodAge
        }
      }
    }
    codRemittances(first: 20) {
      nodes {
        ...CodRemittanceSummary
      }
      pageInfo {
        hasNextPage
      }
    }
  }
  ${COD_AGE}
  ${COD_REMITTANCE_SUMMARY}
  ${MONEY}
`;

/** A courier's statement and its lines, those to look into alone if asked. */
export const CashStatementQuery = /* GraphQL */ `
  query CashStatement($id: ID!, $issuesOnly: Boolean) {
    codRemittance(id: $id) {
      ...CodRemittanceSummary
      charges {
        ...Money
      }
      tax {
        ...Money
      }
      compensated {
        ...Money
      }
      lines(first: 250, issuesOnly: $issuesOnly) {
        row
        trackingNumber
        outcome
        orderId
        orderName
        collected {
          ...Money
        }
        received {
          ...Money
        }
        owed {
          ...Money
        }
      }
    }
  }
  ${COD_REMITTANCE_SUMMARY}
  ${MONEY}
`;

/** A courier's statement read, and imported unless only checked. */
export const CashStatementImportMutation = /* GraphQL */ `
  mutation CashStatementImport(
    $courier: String!
    $csv: String
    $xlsx: String
    $reference: String
    $dryRun: Boolean
  ) {
    codRemittanceImport(
      courier: $courier
      csv: $csv
      xlsx: $xlsx
      reference: $reference
      dryRun: $dryRun
    ) {
      dryRun
      rows
      rowErrorCount
      rowErrors {
        row
        column
        message
      }
      outcomes {
        charged
        compensated
        notOwed
        over
        received
        repeated
        short
        unmatched
      }
      collected {
        ...Money
      }
      received {
        ...Money
      }
      paid {
        ...Money
      }
      remittance {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${MONEY}
  ${USER_ERRORS}
`;

const PARCEL_CLAIM = /* GraphQL */ `
  fragment ParcelClaim on FulfillmentClaim {
    status
    amount {
      ...Money
    }
    paid {
      ...Money
    }
    note
    claimedAt
    settledAt
  }
`;

/** Parcels on their way back, the longest first (COD-09). */
export const ReturningParcelsQuery = /* GraphQL */ `
  query ReturningParcels {
    returningParcels(first: 100) {
      nodes {
        id
        orderId
        orderName
        days
        units
        trackingInfo {
          company
          number
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

/** Parcels the courier lost, the longest lost first, with their worth and claims (COD-09). */
export const LostParcelsQuery = /* GraphQL */ `
  query LostParcels {
    lostParcels(first: 100) {
      nodes {
        id
        orderId
        orderName
        days
        units
        worth {
          ...Money
        }
        trackingInfo {
          company
          number
        }
        claim {
          ...ParcelClaim
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
  ${PARCEL_CLAIM}
  ${MONEY}
`;

/** Parcels with claims on their couriers, the oldest claim first, in the states asked for. */
export const ParcelClaimsQuery = /* GraphQL */ `
  query ParcelClaims($status: [FulfillmentClaimStatus!]) {
    parcelClaims(first: 100, status: $status) {
      nodes {
        id
        orderId
        orderName
        status
        trackingInfo {
          company
          number
        }
        claim {
          ...ParcelClaim
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
  ${PARCEL_CLAIM}
  ${MONEY}
`;

/** A parcel that came back checked in, by its ID or the tracking number on its label. */
export const ParcelCheckInMutation = /* GraphQL */ `
  mutation ParcelCheckIn($id: ID, $trackingNumber: String) {
    fulfillmentReceiveReturn(id: $id, trackingNumber: $trackingNumber) {
      order {
        id
        name
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/**
 * What is left of an order shipped in one parcel, with its courier's tracking: a courier Hatti
 * does not book with, or the shop's own rider (SHP-04). Its stock goes as it ships.
 */
export const OrderFulfillMutation = /* GraphQL */ `
  mutation OrderFulfill($id: ID!, $trackingInfo: FulfillmentTrackingInput) {
    orderFulfill(id: $id, input: { trackingInfo: $trackingInfo }) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A parcel's courier, tracking number and link, corrected or added later. */
export const FulfillmentTrackingInfoUpdateMutation = /* GraphQL */ `
  mutation FulfillmentTrackingInfoUpdate($id: ID!, $trackingInfo: FulfillmentTrackingInput!) {
    fulfillmentTrackingInfoUpdate(id: $id, trackingInfo: $trackingInfo) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The courier lost a parcel on its way out or back: its items are written off. */
export const ParcelMarkLostMutation = /* GraphQL */ `
  mutation ParcelMarkLost($id: ID!) {
    fulfillmentMarkLost(id: $id) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A claim on the courier for a parcel it lost: its worth, or what the shop says. */
export const ParcelClaimCreateMutation = /* GraphQL */ `
  mutation ParcelClaimCreate($id: ID!, $amount: String, $note: String) {
    fulfillmentClaimCreate(id: $id, amount: $amount, note: $note) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** What became of a claim: paid, refused or withdrawn. */
export const ParcelClaimSettleMutation = /* GraphQL */ `
  mutation ParcelClaimSettle(
    $id: ID!
    $status: FulfillmentClaimSettlement!
    $amount: String
    $note: String
  ) {
    fulfillmentClaimSettle(id: $id, status: $status, amount: $amount, note: $note) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The courier delivered a parcel. */
export const ParcelMarkDeliveredMutation = /* GraphQL */ `
  mutation ParcelMarkDelivered($id: ID!) {
    fulfillmentMarkDelivered(id: $id) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The customer refused a parcel, or it could not be delivered: it is coming back. */
export const ParcelMarkReturningMutation = /* GraphQL */ `
  mutation ParcelMarkReturning($id: ID!) {
    fulfillmentMarkReturning(id: $id) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A step of a parcel's way, told of a courier Hatti does not follow (ADR-160). */
export const ParcelEventCreateMutation = /* GraphQL */ `
  mutation ParcelEventCreate($fulfillmentEvent: FulfillmentEventInput!) {
    fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A parcel that came back checked in, so many of each line back on the shelf, the rest written off. */
export const ParcelReceiveMutation = /* GraphQL */ `
  mutation ParcelReceive($id: ID!, $restock: [FulfillmentRestockInput!]) {
    fulfillmentReceiveReturn(id: $id, restock: $restock) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A product's variants, to send another size in exchange. */
export const ProductVariantsQuery = /* GraphQL */ `
  query ProductVariants($id: ID!) {
    product(id: $id) {
      id
      variants {
        id
        title
        availableForSale
        inventoryQuantity
      }
    }
  }
`;

/** Customer returns still on their way, the longest first (ADR-138). */
export const OpenReturnsQuery = /* GraphQL */ `
  query OpenReturns {
    openReturns(first: 100) {
      nodes {
        id
        name
        orderId
        days
        units
        exchangeOrderName
        trackingInfo {
          company
          number
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

/** A customer's return of delivered items recorded, with another size sent at once if asked. */
export const ReturnCreateMutation = /* GraphQL */ `
  mutation ReturnCreate($input: ReturnCreateInput!) {
    returnCreate(input: $input) {
      return {
        id
        name
        exchangeOrder {
          id
          name
        }
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A return checked in as it arrives: so many of each line back in stock, the rest written off. */
export const ReturnReceiveMutation = /* GraphQL */ `
  mutation ReturnReceive($id: ID!, $restock: [ReturnRestockInput!]) {
    returnReceive(id: $id, restock: $restock) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A return still on its way cancelled, as when the customer keeps the items after all. */
export const ReturnCancelMutation = /* GraphQL */ `
  mutation ReturnCancel($id: ID!) {
    returnCancel(id: $id) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Money given back on an order: sent first and recorded, through the gateway, or as store credit. */
export const OrderRefundMutation = /* GraphQL */ `
  mutation OrderRefund($id: ID!, $input: OrderRefundInput!) {
    orderRefund(id: $id, input: $input) {
      refund {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/**
 * A refund through the gateway whose answer never came, settled as its dashboard shows it: given
 * back, with its reference, which records the order's refund; or not, which frees what it held.
 */
export const PaymentRefundSettleMutation = /* GraphQL */ `
  mutation PaymentRefundSettle($id: ID!, $input: PaymentRefundSettleInput!) {
    paymentRefundSettle(id: $id, input: $input) {
      paymentRefund {
        id
        status
        reference
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/**
 * Money an order's customer sent, recorded by hand: the amount given, or what the order waits for
 * by transfer (its advance, or the rest), else the rest; an order waiting for it moves on.
 */
export const OrderCreateManualPaymentMutation = /* GraphQL */ `
  mutation OrderCreateManualPayment($id: ID!, $amount: String) {
    orderCreateManualPayment(id: $id, amount: $amount) {
      order {
        id
        stage
        amountPaid {
          ...Money
        }
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${MONEY}
  ${USER_ERRORS}
`;

/**
 * A new link for the order's customer, to confirm or follow it, shown once: the one before stops
 * working. With it, WhatsApp opened with a message carrying it.
 */
export const OrderLinkCreateMutation = /* GraphQL */ `
  mutation OrderLinkCreate($id: ID!) {
    orderLinkCreate(id: $id) {
      url
      whatsappUrl
      order {
        id
        customerLink {
          expiresAt
        }
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An order recorded as paid in full: cash collected at the door, or a transfer received. */
export const OrderMarkAsPaidMutation = /* GraphQL */ `
  mutation OrderMarkAsPaid($id: ID!) {
    orderMarkAsPaid(id: $id) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A comment on an order's timeline, for whoever picks it up next (ORD-02). */
export const OrderCommentCreateMutation = /* GraphQL */ `
  mutation OrderCommentCreate($orderId: ID!, $message: String!) {
    orderCommentCreate(orderId: $orderId, message: $message) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A comment's words changed, by its author. */
export const OrderCommentUpdateMutation = /* GraphQL */ `
  mutation OrderCommentUpdate($id: ID!, $message: String!) {
    orderCommentUpdate(id: $id, message: $message) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A comment deleted: its author's own, or anyone's by owners and managers. */
export const OrderCommentDeleteMutation = /* GraphQL */ `
  mutation OrderCommentDelete($id: ID!) {
    orderCommentDelete(id: $id) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An order given to a member of staff to see through, or to no one (ORD-10). */
export const OrderAssignMutation = /* GraphQL */ `
  mutation OrderAssign($id: ID!, $staffMemberId: ID) {
    orderAssign(id: $id, staffMemberId: $staffMemberId) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An order's note, tags or address changed; the address only before anything ships. */
export const OrderUpdateMutation = /* GraphQL */ `
  mutation OrderUpdate($id: ID!, $input: OrderUpdateInput!) {
    orderUpdate(id: $id, input: $input) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** How many variants run low or out of stock, for Home (INV-01, ADR-125). */
export const HomeStockQuery = /* GraphQL */ `
  query HomeStock {
    home {
      lowStock {
        low
        out
        threshold
      }
    }
  }
`;

/** The variants running low or out, the fewest for sale first, and what the shop calls low. */
export const LowStockQuery = /* GraphQL */ `
  query LowStock {
    inventorySettings {
      lowStockThreshold
    }
    inventoryLowStock(first: 100) {
      nodes {
        variantId
        variantTitle
        productId
        productTitle
        sku
        available
        inventoryItem {
          id
        }
      }
    }
  }
`;

/** Products found by words, each variant with what it has for sale and its stock's item. */
export const StockSearchQuery = /* GraphQL */ `
  query StockSearch($query: String) {
    products(first: 10, query: $query) {
      nodes {
        id
        title
        variants {
          id
          title
          sku
          inventoryQuantity
          inventoryItem {
            id
            tracked
          }
        }
      }
    }
  }
`;

/** A variant's stock at each location, its latest changes, and the primary location. */
export const InventoryItemQuery = /* GraphQL */ `
  query InventoryItem($id: ID!) {
    location {
      id
      name
    }
    inventoryItem(id: $id) {
      id
      tracked
      inventoryLevels {
        id
        available
        onHand
        committed
        reserved
        safetyStock
        location {
          id
          name
        }
      }
      changes(first: 10) {
        nodes {
          createdAt
          delta
          name
          reason
          quantityAfterChange
          location {
            id
            name
          }
        }
      }
    }
  }
`;

/** Stock added or taken away at a location, and why (INV-01). */
export const InventoryAdjustMutation = /* GraphQL */ `
  mutation InventoryAdjust($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** What the shop calls low stock. */
export const InventorySettingsUpdateMutation = /* GraphQL */ `
  mutation InventorySettingsUpdate($input: InventorySettingsInput!) {
    inventorySettingsUpdate(input: $input) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's collections, found by words in their titles. */
export const CollectionsQuery = /* GraphQL */ `
  query Collections($query: String) {
    collections(first: 100, query: $query) {
      nodes {
        id
        title
        productsCount
        ruleSet {
          appliedDisjunctively
        }
      }
    }
  }
`;

/** A collection with its rules and its products, in its order. */
export const CollectionQuery = /* GraphQL */ `
  query Collection($id: ID!) {
    collection(id: $id) {
      id
      title
      handle
      description
      sortOrder
      productsCount
      ruleSet {
        appliedDisjunctively
        rules {
          column
          relation
          condition
        }
      }
      products(first: 250) {
        nodes {
          id
          title
          status
        }
      }
    }
  }
`;

/** Products found by words, to add to a collection made by hand. */
export const CollectionProductSearchQuery = /* GraphQL */ `
  query CollectionProductSearch($query: String) {
    products(first: 10, query: $query) {
      nodes {
        id
        title
        status
      }
    }
  }
`;

const COLLECTION_PAYLOAD = /* GraphQL */ `
  collection {
    id
  }
  userErrors {
    ...Problems
  }
`;

/** A collection made, by hand or by rules (CAT-03). */
export const CollectionCreateMutation = /* GraphQL */ `
  mutation CollectionCreate($input: CollectionCreateInput!) {
    collectionCreate(input: $input) {
      ${COLLECTION_PAYLOAD}
    }
  }
  ${USER_ERRORS}
`;

/** A collection's title, description, handle, order or rules changed. */
export const CollectionUpdateMutation = /* GraphQL */ `
  mutation CollectionUpdate($input: CollectionUpdateInput!) {
    collectionUpdate(input: $input) {
      ${COLLECTION_PAYLOAD}
    }
  }
  ${USER_ERRORS}
`;

/** Products added to the end of a collection made by hand. */
export const CollectionAddProductsMutation = /* GraphQL */ `
  mutation CollectionAddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      ${COLLECTION_PAYLOAD}
    }
  }
  ${USER_ERRORS}
`;

/** Products taken out of a collection made by hand; they stay in the catalog. */
export const CollectionRemoveProductsMutation = /* GraphQL */ `
  mutation CollectionRemoveProducts($id: ID!, $productIds: [ID!]!) {
    collectionRemoveProducts(id: $id, productIds: $productIds) {
      ${COLLECTION_PAYLOAD}
    }
  }
  ${USER_ERRORS}
`;

/** A product moved within a collection made by hand, to a position counted from 1. */
export const CollectionReorderProductsMutation = /* GraphQL */ `
  mutation CollectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
    collectionReorderProducts(id: $id, moves: $moves) {
      ${COLLECTION_PAYLOAD}
    }
  }
  ${USER_ERRORS}
`;

/** A collection deleted; its products stay. */
export const CollectionDeleteMutation = /* GraphQL */ `
  mutation CollectionDelete($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) {
      deletedCollectionId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's pages, oldest first (OS-07). */
export const PagesQuery = /* GraphQL */ `
  query Pages {
    pages(first: 250) {
      nodes {
        id
        title
        handle
        isPublished
        publishedAt
      }
    }
  }
`;

/** A page with its body, to change. */
export const PageQuery = /* GraphQL */ `
  query Page($id: ID!) {
    page(id: $id) {
      id
      title
      handle
      body
      isPublished
      publishedAt
    }
  }
`;

/** A page written, shown on the storefront unless it is hidden. */
export const PageCreateMutation = /* GraphQL */ `
  mutation PageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A page's fields changed: those given; the others stay. */
export const PageUpdateMutation = /* GraphQL */ `
  mutation PageUpdate($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A page deleted; menus linking to it leave the link out. */
export const PageDeleteMutation = /* GraphQL */ `
  mutation PageDelete($id: ID!) {
    pageDelete(id: $id) {
      deletedPageId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const MENU_ITEM = /* GraphQL */ `
  fragment MenuLink on MenuItem {
    id
    title
    type
    resourceId
    url
  }
`;

/** The shop's menus, the main and footer menus first, each with its links three levels deep. */
export const MenusQuery = /* GraphQL */ `
  query Menus {
    menus(first: 100) {
      nodes {
        id
        title
        handle
        isDefault
        items {
          ...MenuLink
          items {
            ...MenuLink
            items {
              ...MenuLink
            }
          }
        }
      }
    }
  }
  ${MENU_ITEM}
`;

/** A menu made, with its links; the storefront publishes it a moment later. */
export const MenuCreateMutation = /* GraphQL */ `
  mutation MenuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
    menuCreate(title: $title, handle: $handle, items: $items) {
      menu {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A menu's title and all its links, those left out going. */
export const MenuUpdateMutation = /* GraphQL */ `
  mutation MenuUpdate($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, items: $items) {
      menu {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A menu deleted: not the main or footer menu. */
export const MenuDeleteMutation = /* GraphQL */ `
  mutation MenuDelete($id: ID!) {
    menuDelete(id: $id) {
      deletedMenuId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's policies as the storefront shows them at /policies/ (ONB-09). */
export const PoliciesQuery = /* GraphQL */ `
  query Policies {
    shop {
      shopPolicies {
        id
        type
        title
        body
        url
      }
    }
  }
`;

/** Hatti's first draft of a policy in English or Urdu, filled in from the shop's settings. */
export const PolicyDraftQuery = /* GraphQL */ `
  query PolicyDraft($type: ShopPolicyType!, $locale: String!) {
    shopPolicyDraft(type: $type, locale: $locale) {
      title
      body
    }
  }
`;

/** A policy set, or taken away with a blank body. */
export const PolicyUpdateMutation = /* GraphQL */ `
  mutation PolicyUpdate($shopPolicy: ShopPolicyInput!) {
    shopPolicyUpdate(shopPolicy: $shopPolicy) {
      shopPolicy {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A policy's words as kept, with their digests, and its Urdu. */
export const PolicyTranslationQuery = /* GraphQL */ `
  query PolicyTranslation($id: ID!) {
    translatableResource(resourceId: $id) {
      resourceId
      translatableContent {
        key
        digest
      }
      translations(locale: "ur") {
        key
        value
        outdated
      }
    }
  }
`;

/**
 * Things of the shop's whose words may be put in Urdu, by their IDs, such as a product with its
 * options and their values (OS-06): each field with words, its digest, and its Urdu as kept.
 */
export const InUrduQuery = /* GraphQL */ `
  query InUrdu($ids: [ID!]!) {
    translatableResourcesByIds(resourceIds: $ids, first: 250) {
      nodes {
        resourceId
        translatableContent {
          key
          value
          digest
        }
        translations(locale: "ur") {
          key
          value
          outdated
        }
      }
    }
  }
`;

/** Urdu forgotten: the storefront's Urdu pages show the shop's own words again (OS-06). */
export const TranslationsRemoveMutation = /* GraphQL */ `
  mutation TranslationsRemove($resourceId: ID!, $keys: [String!]!) {
    translationsRemove(resourceId: $resourceId, translationKeys: $keys, locales: ["ur"]) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Translations kept, each naming the digest of the words it translates (OS-06). */
export const TranslationsRegisterMutation = /* GraphQL */ `
  mutation TranslationsRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's blogs, oldest first, with how many articles each has (OS-07). */
export const BlogsQuery = /* GraphQL */ `
  query Blogs {
    blogs(first: 250) {
      nodes {
        id
        title
        handle
        commentPolicy
        articlesCount
      }
    }
  }
`;

/** A blog with its articles, the newest last, and each article's comments waiting. */
export const BlogQuery = /* GraphQL */ `
  query Blog($id: ID!) {
    blog(id: $id) {
      id
      title
      handle
      commentPolicy
      articlesCount
      articles(first: 250) {
        nodes {
          id
          title
          handle
          isPublished
          publishedAt
          commentsCount
        }
      }
    }
  }
`;

/** A blog started; its articles are written on their own pages. */
export const BlogCreateMutation = /* GraphQL */ `
  mutation BlogCreate($blog: BlogCreateInput!) {
    blogCreate(blog: $blog) {
      blog {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A blog's title or comment policy changed. */
export const BlogUpdateMutation = /* GraphQL */ `
  mutation BlogUpdate($id: ID!, $blog: BlogUpdateInput!) {
    blogUpdate(id: $id, blog: $blog) {
      blog {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A blog deleted with its articles and their comments. */
export const BlogDeleteMutation = /* GraphQL */ `
  mutation BlogDelete($id: ID!) {
    blogDelete(id: $id) {
      deletedBlogId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const COMMENT = /* GraphQL */ `
  fragment ArticleComment on Comment {
    id
    body
    status
    createdAt
    author {
      name
      email
    }
  }
`;

/** An article to change, its blog, and its comments, the latest first. */
export const ArticleQuery = /* GraphQL */ `
  query Article($id: ID!) {
    article(id: $id) {
      id
      title
      handle
      body
      summary
      tags
      isPublished
      publishedAt
      author {
        name
      }
      image {
        fileId
        altText
      }
      blog {
        id
        title
        handle
        commentPolicy
      }
      comments(first: 100) {
        nodes {
          ...ArticleComment
        }
      }
    }
  }
  ${COMMENT}
`;

/** A file the shop uploaded, for its address: an article's image shown from it. */
export const FileQuery = /* GraphQL */ `
  query ShopFile($id: ID!) {
    file(id: $id) {
      id
      url
      alt
    }
  }
`;

/** An article written in a blog, shown now, at a time ahead, or hidden. */
export const ArticleCreateMutation = /* GraphQL */ `
  mutation ArticleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An article's fields changed: those given; the others stay. */
export const ArticleUpdateMutation = /* GraphQL */ `
  mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An article deleted with its comments. */
export const ArticleDeleteMutation = /* GraphQL */ `
  mutation ArticleDelete($id: ID!) {
    articleDelete(id: $id) {
      deletedArticleId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A comment shown on its article. */
export const CommentApproveMutation = /* GraphQL */ `
  mutation CommentApprove($id: ID!) {
    commentApprove(id: $id) {
      comment {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A comment marked as spam, and hidden. */
export const CommentSpamMutation = /* GraphQL */ `
  mutation CommentSpam($id: ID!) {
    commentSpam(id: $id) {
      comment {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A comment marked as spam by mistake, back to waiting. */
export const CommentNotSpamMutation = /* GraphQL */ `
  mutation CommentNotSpam($id: ID!) {
    commentNotSpam(id: $id) {
      comment {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A comment deleted for good. */
export const CommentDeleteMutation = /* GraphQL */ `
  mutation CommentDelete($id: ID!) {
    commentDelete(id: $id) {
      deletedCommentId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const STOREFRONT_PREFERENCES = /* GraphQL */ `
  fragment StorefrontPreferences on OnlineStorePreferences {
    passwordEnabled
    password
    passwordMessage
    maintenanceEnabled
    maintenanceMessage
    maintenanceUntil
    seo {
      title
      description
    }
  }
`;

/** The storefront's password, its pause, and its home page for search engines (OS-09, OS-15). */
export const StorefrontPreferencesQuery = /* GraphQL */ `
  query StorefrontPreferences {
    onlineStorePreferences {
      ...StorefrontPreferences
    }
  }
  ${STOREFRONT_PREFERENCES}
`;

/** Some of the storefront's preferences changed: those given; the others stay. */
export const StorefrontPreferencesUpdateMutation = /* GraphQL */ `
  mutation StorefrontPreferencesUpdate($input: OnlineStorePreferencesInput!) {
    onlineStorePreferencesUpdate(input: $input) {
      preferences {
        ...StorefrontPreferences
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${STOREFRONT_PREFERENCES}
  ${USER_ERRORS}
`;

/** The shop's redirects from old addresses, found by any part of either address (OS-09). */
export const UrlRedirectsQuery = /* GraphQL */ `
  query UrlRedirects($query: String) {
    urlRedirects(first: 100, query: $query) {
      nodes {
        id
        path
        target
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

/** A redirect from an old address to a page of the shop or another site. */
export const UrlRedirectCreateMutation = /* GraphQL */ `
  mutation UrlRedirectCreate($urlRedirect: UrlRedirectInput!) {
    urlRedirectCreate(urlRedirect: $urlRedirect) {
      urlRedirect {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A redirect deleted: its old address is not found again. */
export const UrlRedirectDeleteMutation = /* GraphQL */ `
  mutation UrlRedirectDelete($id: ID!) {
    urlRedirectDelete(id: $id) {
      deletedUrlRedirectId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Redirects from Shopify's CSV (ONB-05): checked first as a dry run, then added. */
export const UrlRedirectsImportMutation = /* GraphQL */ `
  mutation UrlRedirectsImport($csv: String!, $dryRun: Boolean) {
    urlRedirectsImport(csv: $csv, dryRun: $dryRun) {
      dryRun
      rows
      created
      skipped
      rowErrorCount
      rowErrors {
        row
        column
        message
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's redirects as Shopify's CSV, to keep or to take elsewhere. */
export const UrlRedirectsExportQuery = /* GraphQL */ `
  query UrlRedirectsExport {
    urlRedirectsExport {
      count
      csv
    }
  }
`;

/** The shop's segments, newest first, with how many customers each holds now (CUS-03). */
export const SegmentsQuery = /* GraphQL */ `
  query Segments {
    segments(first: 250) {
      nodes {
        id
        name
        query
        memberCount
      }
    }
  }
`;

/** A segment to change. */
export const SegmentQuery = /* GraphQL */ `
  query Segment($id: ID!) {
    segment(id: $id) {
      id
      name
      query
      memberCount
    }
  }
`;

/** The fields a segment's conditions can use, with the conditions each takes. */
export const SegmentFiltersQuery = /* GraphQL */ `
  query SegmentFilters {
    segmentFilters {
      name
      type
      description
      example
      operators
    }
  }
`;

/** What a segment's conditions match now: how many customers, and the newest of them. */
export const SegmentPreviewQuery = /* GraphQL */ `
  query SegmentPreview($query: String!) {
    segmentPreview(query: $query, first: 20) {
      memberCount
      members {
        id
        displayName
        phone
        numberOfOrders
        lastOrderAt
        tags
        amountSpent {
          amount
          currencyCode
        }
        blocklistEntry {
          id
        }
      }
    }
  }
`;

/** A segment kept by its name; its conditions are checked by the core. */
export const SegmentCreateMutation = /* GraphQL */ `
  mutation SegmentCreate($name: String!, $query: String!) {
    segmentCreate(name: $name, query: $query) {
      segment {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A segment renamed, or its conditions changed. */
export const SegmentUpdateMutation = /* GraphQL */ `
  mutation SegmentUpdate($id: ID!, $name: String, $query: String) {
    segmentUpdate(id: $id, name: $name, query: $query) {
      segment {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A segment deleted; its customers stay. */
export const SegmentDeleteMutation = /* GraphQL */ `
  mutation SegmentDelete($id: ID!) {
    segmentDelete(id: $id) {
      deletedSegmentId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Customers as CSV, everyone or a segment's (CUS-07); owners and managers, recently signed in. */
export const CustomersExportMutation = /* GraphQL */ `
  mutation CustomersExport($segmentId: ID) {
    customersExport(segmentId: $segmentId) {
      csv
      rowCount
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Customers from a CSV: checked first as a dry run, then added, updating those here if asked. */
export const CustomersImportMutation = /* GraphQL */ `
  mutation CustomersImport($csv: String!, $dryRun: Boolean, $overwrite: Boolean) {
    customersImport(csv: $csv, dryRun: $dryRun, overwrite: $overwrite) {
      dryRun
      rows
      created
      updated
      skipped
      rowErrorCount
      rowErrors {
        row
        column
        message
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const LINK_PAGE = /* GraphQL */ `
  fragment LinkPageParts on LinkPage {
    bio
    links {
      title
      url
    }
    products {
      productId
      variantId
    }
  }
`;

/** The shop's link page (CH-07), where its storefront serves it, and its WhatsApp number. */
export const LinkPageQuery = /* GraphQL */ `
  query LinkPage {
    shop {
      id
      url
    }
    onlineStorePreferences {
      whatsappNumber
      linkPage {
        ...LinkPageParts
      }
    }
  }
  ${LINK_PAGE}
`;

/** The link page changed: its bio, its links and its products, each replacing what it had. */
export const LinkPageUpdateMutation = /* GraphQL */ `
  mutation LinkPageUpdate($input: OnlineStorePreferencesInput!) {
    onlineStorePreferencesUpdate(input: $input) {
      preferences {
        linkPage {
          ...LinkPageParts
        }
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${LINK_PAGE}
  ${USER_ERRORS}
`;

/** One of the link page's products: its title, picture and variants to choose among. */
export const LinkPageProductQuery = /* GraphQL */ `
  query LinkPageProduct($id: ID!) {
    product(id: $id) {
      id
      title
      status
      media {
        id
        previewImage {
          url
        }
      }
      variants {
        id
        title
        price {
          ...Money
        }
      }
    }
  }
  ${MONEY}
`;

/** Taps on the link page's links over a period (ADR-204), the most tapped first. */
export const LinkPageTapsQuery = /* GraphQL */ `
  query LinkPageTaps($from: DateTime!, $before: DateTime!) {
    linkPageTaps(from: $from, before: $before) {
      total
      links {
        url
        title
        source
        taps
      }
    }
  }
`;

/** A customer's store credit (ORD-09): what each of their accounts holds, for those who read it. */
export const CustomerStoreCreditQuery = /* GraphQL */ `
  query CustomerStoreCredit($id: ID!) {
    customer(id: $id) {
      id
      storeCreditAccounts(first: 5) {
        nodes {
          id
          balance {
            ...Money
          }
        }
      }
    }
  }
  ${MONEY}
`;

/** A customer's store credit with its ledger, the newest first, for those who keep it. */
export const CustomerStoreCreditLedgerQuery = /* GraphQL */ `
  query CustomerStoreCreditLedger($id: ID!) {
    customer(id: $id) {
      id
      storeCreditAccounts(first: 5) {
        nodes {
          id
          balance {
            ...Money
          }
          transactions(first: 25) {
            nodes {
              id
              kind
              event
              amount {
                ...Money
              }
              balanceAfterTransaction {
                ...Money
              }
              remainingAmount {
                ...Money
              }
              expiresAt
              createdAt
              note
              orderId
            }
          }
        }
      }
    }
  }
  ${MONEY}
`;

/** Store credit given to a customer by hand, opening their account if they have none. */
export const StoreCreditCreditMutation = /* GraphQL */ `
  mutation StoreCreditCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
    storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
      storeCreditAccountTransaction {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Store credit taken back from a customer, the credits that expire soonest first. */
export const StoreCreditDebitMutation = /* GraphQL */ `
  mutation StoreCreditDebit($id: ID!, $debitInput: StoreCreditAccountDebitInput!) {
    storeCreditAccountDebit(id: $id, debitInput: $debitInput) {
      storeCreditAccountTransaction {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An order paid, or part of it, with its customer's store credit (ADR-185). */
export const OrderPayWithStoreCreditMutation = /* GraphQL */ `
  mutation OrderPayWithStoreCredit($id: ID!, $amount: String) {
    orderPayWithStoreCredit(id: $id, amount: $amount) {
      order {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const PAYMENT_LINK = /* GraphQL */ `
  fragment PaymentLinkParts on PaymentLink {
    id
    title
    url
    active
    open
    ordersPlaced
    usageLimit
    prepaidOnly
    discountCode
    expiresAt
    lastOrderAt
    createdAt
    items {
      variantId
      title
      quantity
    }
  }
`;

/** The shop's payment links (PAY-04), the newest first: what each sells, and its orders. */
export const PaymentLinksQuery = /* GraphQL */ `
  query PaymentLinks {
    paymentLinks(first: 50) {
      ...PaymentLinkParts
    }
  }
  ${PAYMENT_LINK}
`;

/** A payment link made, open at once at its own address. */
export const PaymentLinkCreateMutation = /* GraphQL */ `
  mutation PaymentLinkCreate($input: PaymentLinkInput!) {
    paymentLinkCreate(input: $input) {
      paymentLink {
        ...PaymentLinkParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${PAYMENT_LINK}
  ${USER_ERRORS}
`;

/** A payment link changed: closed, or opened again. */
export const PaymentLinkUpdateMutation = /* GraphQL */ `
  mutation PaymentLinkUpdate($id: ID!, $input: PaymentLinkInput!) {
    paymentLinkUpdate(id: $id, input: $input) {
      paymentLink {
        id
        active
        open
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const SUPPORT_GRANT = /* GraphQL */ `
  fragment SupportGrant on SupportAccessGrant {
    id
    open
    note
    grantedBy
    createdAt
    expiresAt
    endedAt
    endedBy
  }
`;

/** Whether Hatti's support may look at the shop now (ADM-08), and each time it was let in. */
export const SupportAccessQuery = /* GraphQL */ `
  query SupportAccess {
    supportAccess {
      ...SupportGrant
    }
    supportAccessGrants(first: 20) {
      ...SupportGrant
    }
  }
  ${SUPPORT_GRANT}
`;

/** Hatti's support let in to look for a while: the owner alone, signed in lately. */
export const SupportAccessGrantMutation = /* GraphQL */ `
  mutation SupportAccessGrant($minutes: Int, $note: String) {
    supportAccessGrant(minutes: $minutes, note: $note) {
      grant {
        ...SupportGrant
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${SUPPORT_GRANT}
  ${USER_ERRORS}
`;

/** Hatti's support's access ended now. */
export const SupportAccessEndMutation = /* GraphQL */ `
  mutation SupportAccessEnd {
    supportAccessEnd {
      grant {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Orders as CSV or Excel, filtered as the list is (ORD-11): every export is on the audit log. */
export const OrdersExportMutation = /* GraphQL */ `
  mutation OrdersExport(
    $format: OrderExportFormat!
    $layout: OrderExportLayout!
    $query: String
    $stage: OrderStage
    $placedFrom: DateTime
    $placedBefore: DateTime
  ) {
    ordersExport(
      format: $format
      layout: $layout
      query: $query
      stage: $stage
      placedFrom: $placedFrom
      placedBefore: $placedBefore
    ) {
      rowCount
      file {
        content
        contentType
        filename
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const EXPORT_SCHEDULE = /* GraphQL */ `
  fragment ExportSchedule on OrderExportSchedule {
    id
    frequency
    hour
    format
    layout
    query
    staffMemberId
    nextSendAt
    nextPeriodFirstDay
    nextPeriodLastDay
    lastSentAt
    lastError
  }
`;

/** The shop's scheduled order exports, each emailed to the member of staff who made it. */
export const OrderExportSchedulesQuery = /* GraphQL */ `
  query OrderExportSchedules {
    orderExportSchedules {
      ...ExportSchedule
    }
  }
  ${EXPORT_SCHEDULE}
`;

/** An order export scheduled, emailed to the member asking every day, week or month. */
export const OrderExportScheduleCreateMutation = /* GraphQL */ `
  mutation OrderExportScheduleCreate($input: OrderExportScheduleInput!) {
    orderExportScheduleCreate(input: $input) {
      exportSchedule {
        ...ExportSchedule
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${EXPORT_SCHEDULE}
  ${USER_ERRORS}
`;

/** A scheduled order export stopped. */
export const OrderExportScheduleDeleteMutation = /* GraphQL */ `
  mutation OrderExportScheduleDelete($id: ID!) {
    orderExportScheduleDelete(id: $id) {
      deletedExportScheduleId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const TAX_SETTINGS = /* GraphQL */ `
  fragment TaxSettingsParts on TaxSettings {
    rate
    taxDelivery
    ntn
    strn
    updatedAt
    categories {
      code
      name
      rate
    }
  }
`;

/** The sales tax the shop charges (TAX-01), included in its prices, and its registration. */
export const TaxSettingsQuery = /* GraphQL */ `
  query TaxSettings {
    taxSettings {
      ...TaxSettingsParts
    }
  }
  ${TAX_SETTINGS}
`;

/** The shop's sales tax changed, for orders placed from now on. */
export const TaxSettingsUpdateMutation = /* GraphQL */ `
  mutation TaxSettingsUpdate($input: TaxSettingsUpdateInput!) {
    taxSettingsUpdate(input: $input) {
      taxSettings {
        ...TaxSettingsParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${TAX_SETTINGS}
  ${USER_ERRORS}
`;

const META_CONVERSIONS = /* GraphQL */ `
  fragment MetaConversionsParts on MetaConversions {
    pixelId
    accessTokenHint
    purchaseAt
    testEventCode
    updatedAt
  }
`;

/** The shop's Meta dataset, if it connected one, and its catalog feed's address (ADR-142, ADR-143). */
export const MetaConversionsQuery = /* GraphQL */ `
  query MetaConversions {
    metaConversions {
      ...MetaConversionsParts
    }
    shop {
      id
      productFeedUrl
    }
  }
  ${META_CONVERSIONS}
`;

/** The shop's Meta dataset connected, or how its orders go to it changed. */
export const MetaConversionsUpdateMutation = /* GraphQL */ `
  mutation MetaConversionsUpdate($input: MetaConversionsInput!) {
    metaConversionsUpdate(input: $input) {
      metaConversions {
        ...MetaConversionsParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${META_CONVERSIONS}
  ${USER_ERRORS}
`;

/** The shop's Meta dataset disconnected: its token forgotten, moments waiting not sent. */
export const MetaConversionsDeleteMutation = /* GraphQL */ `
  mutation MetaConversionsDelete {
    metaConversionsDelete {
      deletedPixelId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The latest moments of the shop's orders sent, or to be sent, to Meta, and how each went. */
export const ConversionEventsQuery = /* GraphQL */ `
  query ConversionEvents($status: ConversionStatus) {
    conversionEvents(first: 50, status: $status) {
      nodes {
        id
        orderId
        moment
        eventName
        status
        attempts
        error
        traceId
        occurredAt
        sentAt
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

const MESSAGING_SETTINGS = /* GraphQL */ `
  fragment MessagingSettingsParts on MessagingSettings {
    routing
    language
    disabledNotifications
    alertsPhone
    updatedAt
  }
`;

/** How the shop's customers are told of their orders, and what a message costs it. */
export const MessagingSettingsQuery = /* GraphQL */ `
  query MessagingSettings {
    messagingSettings {
      ...MessagingSettingsParts
    }
    billingMessagePrices {
      category
      channel
      price {
        amount
        currencyCode
      }
    }
  }
  ${MESSAGING_SETTINGS}
`;

/** How the shop's customers are told of their orders, changed. */
export const MessagingSettingsUpdateMutation = /* GraphQL */ `
  mutation MessagingSettingsUpdate($input: MessagingSettingsInput!) {
    messagingSettingsUpdate(input: $input) {
      messagingSettings {
        ...MessagingSettingsParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${MESSAGING_SETTINGS}
  ${USER_ERRORS}
`;

/** The latest messages about the shop's orders, or one order's, and how sending each went. */
export const MessagesQuery = /* GraphQL */ `
  query Messages($orderId: ID, $status: MessageStatus) {
    messages(first: 50, orderId: $orderId, status: $status) {
      nodes {
        id
        kind
        channel
        status
        recipient
        orderId
        error
        attempts
        createdAt
        sentAt
        deliveredAt
        readAt
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

const ORDER_SETTINGS = /* GraphQL */ `
  fragment OrderSettingsParts on OrderSettings {
    callingHours {
      opens
      closes
    }
    firstCallMinutes
    deskWaitsForReminder
    cancelUnpaidAfterDays
    cancelUnreachableAfterDays
    customerCancellation
    updatedAt
  }
`;

const ORDER_RISK_SETTINGS = /* GraphQL */ `
  fragment OrderRiskSettingsParts on OrderRiskSettings {
    highValue {
      amount
      currencyCode
    }
    holdAt
    updatedAt
  }
`;

/** The shop's policies for its orders: the desk's hours, cancelling, and risky orders. */
export const OrderPoliciesQuery = /* GraphQL */ `
  query OrderPolicies {
    orderSettings {
      ...OrderSettingsParts
    }
    orderRiskSettings {
      ...OrderRiskSettingsParts
    }
  }
  ${ORDER_SETTINGS}
  ${ORDER_RISK_SETTINGS}
`;

/** The shop's order settings changed, for what happens from now on. */
export const OrderSettingsUpdateMutation = /* GraphQL */ `
  mutation OrderSettingsUpdate($input: OrderSettingsInput!) {
    orderSettingsUpdate(input: $input) {
      orderSettings {
        ...OrderSettingsParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${ORDER_SETTINGS}
  ${USER_ERRORS}
`;

/** When risky cash-on-delivery orders wait for review, changed for orders from now on. */
export const OrderRiskSettingsUpdateMutation = /* GraphQL */ `
  mutation OrderRiskSettingsUpdate($input: OrderRiskSettingsInput!) {
    orderRiskSettingsUpdate(input: $input) {
      riskSettings {
        ...OrderRiskSettingsParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${ORDER_RISK_SETTINGS}
  ${USER_ERRORS}
`;

/** A customer added by hand, before they order. */
export const CustomerCreateMutation = /* GraphQL */ `
  mutation CustomerCreate($input: CustomerCreateInput!) {
    customerCreate(input: $input) {
      customer {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A duplicate merged into a customer, and deleted. */
export const CustomerMergeMutation = /* GraphQL */ `
  mutation CustomerMerge($customerId: ID!, $duplicateId: ID!) {
    customerMerge(customerId: $customerId, duplicateId: $duplicateId) {
      customer {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** What a customer agreed to, or withdrew from, recorded in the consent ledger. */
export const CustomerMarketingConsentUpdateMutation = /* GraphQL */ `
  mutation CustomerMarketingConsentUpdate($id: ID!, $marketingConsent: [MarketingConsentInput!]!) {
    customerMarketingConsentUpdate(id: $id, marketingConsent: $marketingConsent) {
      customer {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Everything the shop keeps of a customer, as a file to give them. */
export const CustomerDataExportMutation = /* GraphQL */ `
  mutation CustomerDataExport($id: ID!) {
    customerDataExport(id: $id) {
      fileName
      json
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A customer's erasure asked for, ten days on unless it is cancelled. */
export const CustomerErasureRequestMutation = /* GraphQL */ `
  mutation CustomerErasureRequest($id: ID!) {
    customerErasureRequest(id: $id) {
      erasureScheduledAt
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A customer's erasure waiting to happen, stopped. */
export const CustomerErasureCancelMutation = /* GraphQL */ `
  mutation CustomerErasureCancel($id: ID!) {
    customerErasureCancel(id: $id) {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Customers' erasures waiting to happen, the soonest first. */
export const CustomerErasureRequestsQuery = /* GraphQL */ `
  query CustomerErasureRequests {
    customerErasureRequests(first: 100) {
      nodes {
        requestedAt
        scheduledAt
        customer {
          id
          displayName
          phone
        }
      }
    }
  }
`;

/** What the checkout's page shows under its button, and the boxes it offers for marketing. */
export const CheckoutPageQuery = /* GraphQL */ `
  query CheckoutPage {
    checkoutTrustBadges {
      kind
      days
    }
    checkoutMarketingChannels
    onlineStorePreferences {
      whatsappNumber
    }
  }
`;

/** The checkout's badges replaced, in the order given. */
export const CheckoutTrustBadgesUpdateMutation = /* GraphQL */ `
  mutation CheckoutTrustBadgesUpdate($badges: [CheckoutTrustBadgeInput!]!) {
    checkoutTrustBadgesUpdate(badges: $badges) {
      checkoutTrustBadges {
        kind
        days
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The channels the checkout offers a box for the shop's news and offers on. */
export const CheckoutMarketingChannelsUpdateMutation = /* GraphQL */ `
  mutation CheckoutMarketingChannelsUpdate($channels: [MarketingChannel!]!) {
    checkoutMarketingChannelsUpdate(channels: $channels) {
      checkoutMarketingChannels
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's products as Shopify's product CSV, as a search finds them. */
export const ProductsExportQuery = /* GraphQL */ `
  query ProductsExport($query: String) {
    productsExport(query: $query) {
      csv
      productCount
      rowCount
    }
  }
`;

/** Products from Shopify's product CSV, checked first in a dry run. */
export const ProductsImportMutation = /* GraphQL */ `
  mutation ProductsImport($csv: String!, $dryRun: Boolean, $overwrite: Boolean) {
    productsImport(csv: $csv, dryRun: $dryRun, overwrite: $overwrite) {
      dryRun
      rows
      created
      updated
      skipped
      variants
      images
      stocked
      rowErrorCount
      rowErrors {
        row
        column
        message
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's active locations, to export one's stock alone. */
export const LocationsQuery = /* GraphQL */ `
  query Locations {
    locations(first: 50) {
      nodes {
        id
        name
        isPrimary
      }
    }
  }
`;

/** The shop's stock as Shopify's inventory CSV, for a count in a spreadsheet. */
export const InventoryExportQuery = /* GraphQL */ `
  query InventoryExport($locationId: ID, $query: String) {
    inventoryExport(locationId: $locationId, query: $query) {
      csv
      productCount
      rowCount
    }
  }
`;

/** A stock count from Shopify's inventory CSV, checked first in a dry run. */
export const InventoryImportMutation = /* GraphQL */ `
  mutation InventoryImport($csv: String!, $dryRun: Boolean) {
    inventoryImport(csv: $csv, dryRun: $dryRun) {
      dryRun
      rows
      counted
      unchanged
      rowErrorCount
      rowErrors {
        row
        column
        message
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const SHOP_LOCATION = /* GraphQL */ `
  fragment ShopLocationParts on Location {
    id
    name
    isPrimary
    isActive
    fulfillsOnlineOrders
    address {
      address1
      address2
      city
      province
      zip
      phone
      formatted
    }
  }
`;

/** The shop's locations, those out of use too, for settings. */
export const ShopLocationsQuery = /* GraphQL */ `
  query ShopLocations {
    locations(first: 100, includeInactive: true) {
      nodes {
        ...ShopLocationParts
      }
    }
  }
  ${SHOP_LOCATION}
`;

/** A location added: a warehouse or a shop of the business's. */
export const LocationAddMutation = /* GraphQL */ `
  mutation LocationAdd($input: LocationAddInput!) {
    locationAdd(input: $input) {
      location {
        ...ShopLocationParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${SHOP_LOCATION}
  ${USER_ERRORS}
`;

/** A location's name, address or whether it fulfils online orders, changed. */
export const LocationEditMutation = /* GraphQL */ `
  mutation LocationEdit($id: ID!, $input: LocationEditInput!) {
    locationEdit(id: $id, input: $input) {
      location {
        ...ShopLocationParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${SHOP_LOCATION}
  ${USER_ERRORS}
`;

/** A location taken out of use, holding no stock and waited on by no order. */
export const LocationDeactivateMutation = /* GraphQL */ `
  mutation LocationDeactivate($locationId: ID!) {
    locationDeactivate(locationId: $locationId) {
      location {
        ...ShopLocationParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${SHOP_LOCATION}
  ${USER_ERRORS}
`;

/** A location put back in use. */
export const LocationActivateMutation = /* GraphQL */ `
  mutation LocationActivate($locationId: ID!) {
    locationActivate(locationId: $locationId) {
      location {
        ...ShopLocationParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${SHOP_LOCATION}
  ${USER_ERRORS}
`;

/** A location that never held stock, deleted. */
export const LocationDeleteMutation = /* GraphQL */ `
  mutation LocationDelete($locationId: ID!) {
    locationDelete(locationId: $locationId) {
      deletedLocationId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const SAVED_SEARCH = /* GraphQL */ `
  fragment Saved on SavedSearch {
    id
    name
    query
  }
`;

/** The searches of the orders list its staff saved, oldest first, as their tabs were added. */
export const OrderSavedSearchesQuery = /* GraphQL */ `
  query OrderSavedSearches {
    savedSearches: orderSavedSearches(first: 100) {
      nodes {
        ...Saved
      }
    }
  }
  ${SAVED_SEARCH}
`;

/** The searches of the products list its staff saved. */
export const ProductSavedSearchesQuery = /* GraphQL */ `
  query ProductSavedSearches {
    savedSearches: productSavedSearches(first: 100) {
      nodes {
        ...Saved
      }
    }
  }
  ${SAVED_SEARCH}
`;

/** The searches of the drafts list its staff saved (ORD-03). */
export const DraftOrderSavedSearchesQuery = /* GraphQL */ `
  query DraftOrderSavedSearches {
    savedSearches: draftOrderSavedSearches(first: 100) {
      nodes {
        ...Saved
      }
    }
  }
  ${SAVED_SEARCH}
`;

/** A search of a list kept by name for all the shop's staff (ORD-01, CAT-04). */
export const SavedSearchCreateMutation = /* GraphQL */ `
  mutation SavedSearchCreate($input: SavedSearchCreateInput!) {
    savedSearchCreate(input: $input) {
      savedSearch {
        ...Saved
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${SAVED_SEARCH}
  ${USER_ERRORS}
`;

/** A saved search renamed, or its search changed. */
export const SavedSearchUpdateMutation = /* GraphQL */ `
  mutation SavedSearchUpdate($input: SavedSearchUpdateInput!) {
    savedSearchUpdate(input: $input) {
      savedSearch {
        ...Saved
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${SAVED_SEARCH}
  ${USER_ERRORS}
`;

/** A saved search deleted. */
export const SavedSearchDeleteMutation = /* GraphQL */ `
  mutation SavedSearchDelete($input: SavedSearchDeleteInput!) {
    savedSearchDelete(input: $input) {
      deletedSavedSearchId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const DOMAIN = /* GraphQL */ `
  fragment ShopDomain on Domain {
    id
    host
    url
    dnsTarget
    isPrimary
    isVerified
    verifiedAt
    unpointedSince
  }
`;

/** The shop's address and its own domains (ONB-07). */
export const ShopDomainsQuery = /* GraphQL */ `
  query ShopDomains {
    shop {
      url
    }
    domains {
      ...ShopDomain
    }
  }
  ${DOMAIN}
`;

/** A domain of the shop's own connected, to be pointed at Hatti. */
export const DomainCreateMutation = /* GraphQL */ `
  mutation DomainCreate($domain: DomainCreateInput!) {
    domainCreate(domain: $domain) {
      domain {
        ...ShopDomain
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${DOMAIN}
  ${USER_ERRORS}
`;

/** A domain checked: whether DNS points it at Hatti now. */
export const DomainVerifyMutation = /* GraphQL */ `
  mutation DomainVerify($id: ID!) {
    domainVerify(id: $id) {
      domain {
        ...ShopDomain
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${DOMAIN}
  ${USER_ERRORS}
`;

/** A verified domain made primary, where the storefront sends shoppers, or not. */
export const DomainUpdateMutation = /* GraphQL */ `
  mutation DomainUpdate($id: ID!, $domain: DomainUpdateInput!) {
    domainUpdate(id: $id, domain: $domain) {
      domain {
        ...ShopDomain
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${DOMAIN}
  ${USER_ERRORS}
`;

/** A domain let go: the storefront no longer answers at it. */
export const DomainDeleteMutation = /* GraphQL */ `
  mutation DomainDelete($id: ID!) {
    domainDelete(id: $id) {
      deletedDomainId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const THEME = /* GraphQL */ `
  fragment Theme on OnlineStoreTheme {
    id
    name
    role
    base
    previewUrl
    createdAt
    updatedAt
  }
`;

/** The shop's themes: the one its storefront shows, and those being prepared (OS-02). */
export const ThemesQuery = /* GraphQL */ `
  query Themes {
    themes(first: 50) {
      nodes {
        ...Theme
      }
    }
  }
  ${THEME}
`;

/**
 * A theme as its editor needs it (ADR-323): the platform theme's settings and sections in the
 * admin's language, and the theme's files as the storefront reads them.
 */
export const ThemeEditorQuery = /* GraphQL */ `
  query ThemeEditor($id: ID!, $locale: String!) {
    theme(id: $id) {
      ...Theme
      version
      editor(locale: $locale) {
        settingsSchema
        sections {
          type
          name
          schema
        }
        files {
          filename
          body
          own
          problems
        }
      }
    }
  }
  ${THEME}
`;

/**
 * What a theme's settings may point at, the shop's menus and collections by handle, and pages of
 * the shop's for the editor's preview to open a template on: a product, and pages, blogs and
 * posts with the templates they ask for.
 */
export const ThemeChoicesQuery = /* GraphQL */ `
  query ThemeChoices {
    menus(first: 100) {
      nodes {
        handle
        title
      }
    }
    collections(first: 100) {
      nodes {
        handle
        title
      }
    }
    products(first: 1, query: "status:active") {
      nodes {
        handle
      }
    }
    pages(first: 100) {
      nodes {
        handle
        templateSuffix
        isPublished
        publishedAt
      }
    }
    blogs(first: 50) {
      nodes {
        handle
        templateSuffix
      }
    }
    articles(first: 100) {
      nodes {
        handle
        templateSuffix
        isPublished
        publishedAt
        blog {
          handle
        }
      }
    }
  }
`;

/** A theme's changed files saved, all of them or none, as Theme Check passes them. */
export const ThemeFilesUpsertMutation = /* GraphQL */ `
  mutation ThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      theme {
        id
        version
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's own files of a theme deleted, so that the platform theme's show again. */
export const ThemeFilesDeleteMutation = /* GraphQL */ `
  mutation ThemeFilesDelete($themeId: ID!, $files: [String!]!) {
    themeFilesDelete(themeId: $themeId, files: $files) {
      deletedThemeFiles
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A theme added, a copy of one the shop has or on the platform theme afresh. */
export const ThemeCreateMutation = /* GraphQL */ `
  mutation ThemeCreate($name: String!, $copyFrom: ID) {
    themeCreate(name: $name, copyFrom: $copyFrom) {
      theme {
        ...Theme
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${THEME}
  ${USER_ERRORS}
`;

/** A theme made the one the storefront shows; the one before it unpublished. */
export const ThemePublishMutation = /* GraphQL */ `
  mutation ThemePublish($id: ID!) {
    themePublish(id: $id) {
      theme {
        ...Theme
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${THEME}
  ${USER_ERRORS}
`;

/** A theme other than the live one deleted. */
export const ThemeDeleteMutation = /* GraphQL */ `
  mutation ThemeDelete($id: ID!) {
    themeDelete(id: $id) {
      deletedThemeId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;
