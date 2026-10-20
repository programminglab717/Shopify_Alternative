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
  query Home($locationId: ID) {
    shop {
      timezone
    }
    home(locationId: $locationId) {
      toConfirm {
        ...Tally
      }
      toReview {
        ...Tally
      }
      awaitingPayment {
        ...Tally
      }
      parcelsUnseen
      deliveriesToRescue
      transfersToCheck {
        ...Tally
      }
      toPack {
        ...Tally
      }
      toBook {
        ...Tally
      }
      readyForPickup {
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
  query Orders($first: Int, $after: String, $query: String, $stage: OrderStage, $locationId: ID) {
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
    orderStageCounts(locationId: $locationId) {
      stage
      count
    }
  }
`;

/**
 * The newest orders of a list's tab and search, which the list asks for while it is open to
 * count those newer than it shows (ADR-342): their IDs alone, which keep the order they were placed in.
 */
export const FreshOrdersQuery = /* GraphQL */ `
  query FreshOrders($first: Int, $query: String, $stage: OrderStage) {
    orders(first: $first, query: $query, stage: $stage) {
      nodes {
        id
      }
      pageInfo {
        hasNextPage
      }
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
      deliveryMethod
      financialStatus
      confirmationStatus
      cancelReason
      overPlanLimit
      invoice {
        number
        issuedAt
        fbrStatus
        fbrInvoiceNumber
      }
      note
      giftMessage
      deliveryExpectedOn
      tags
      phone
      email
      source
      location {
        id
        name
      }
      lineItems {
        id
        productId
        variantId
        title
        variantTitle
        sku
        quantity
        preorderShipsOn
        bundle {
          key
          title
          quantity
        }
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
        creditNote {
          number
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
      repeatOf {
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
        courierCharges {
          amount
          currencyCode
        }
        courierChargesEstimate {
          amount
          currencyCode
        }
        handOver {
          handedOverAt
          byHand
          riderName
          seen
          unseen
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
        worth {
          amount
          currencyCode
        }
        amountRefunded {
          amount
          currencyCode
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
/** The customer collected their pickup order: handed over, and paid at the counter (ADR-389). */
export const OrderMarkPickedUpMutation = /* GraphQL */ `
  mutation OrderMarkPickedUp($id: ID!) {
    orderMarkPickedUp(id: $id) {
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
/** An order shipped from another location, its stock moved there (INV-10). */
export const OrderLocationChangeMutation = /* GraphQL */ `
  mutation OrderLocationChange($id: ID!, $locationId: ID!) {
    orderLocationChange(id: $id, locationId: $locationId) {
      order {
        id
        location {
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
export const OrderRepeatKeepMutation = /* GraphQL */ `
  mutation OrderRepeatKeep($id: ID!) {
    orderRepeatKeep(id: $id) {
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

/** Up to 250 orders given to a member of staff, or to no one, at once (ADR-634). */
export const OrderBulkAssignMutation = /* GraphQL */ `
  mutation OrderBulkAssign($ids: [ID!]!, $staffMemberId: ID) {
    orderBulkAssign(ids: $ids, staffMemberId: $staffMemberId) {
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

const DESK_DUTY = /* GraphQL */ `
  fragment DeskDutyParts on DeskDuty {
    staffMemberId
    name
    endsAt
    waiting
    isYou
  }
`;

/** Who is on duty at the desk, to be given new orders where the shop shares them (ADR-654). */
export const ConfirmationDeskDutyQuery = /* GraphQL */ `
  query ConfirmationDeskDuty {
    confirmationDeskDuty {
      ...DeskDutyParts
    }
  }
  ${DESK_DUTY}
`;

/** The caller goes on duty at the desk for some hours, or moves when their shift ends. */
export const ConfirmationDeskDutyStartMutation = /* GraphQL */ `
  mutation ConfirmationDeskDutyStart($hours: Int) {
    confirmationDeskDutyStart(hours: $hours) {
      duty {
        ...DeskDutyParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${DESK_DUTY}
  ${USER_ERRORS}
`;

/** The caller goes off duty; the orders given to them stay theirs. */
export const ConfirmationDeskDutyEndMutation = /* GraphQL */ `
  mutation ConfirmationDeskDutyEnd {
    confirmationDeskDutyEnd {
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
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
        soldLast30Days
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
    seo {
      title
      description
    }
    status
    productType
    vendor
    tags
    totalInventory
    tracksInventory
    isGiftCard
    category
    condition
    easternWear {
      stitching
      pieces
      fabrics
      season
    }
    preorder {
      shipsOn
    }
    sizeChart {
      id
      name
    }
    bundle {
      complete
      components {
        productId
        variantId
        productTitle
        variantTitle
        quantity
      }
    }
    complementaryProducts {
      id
      title
    }
    publishAt
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
      soldLast30Days
      daysOfStockLeft
      inventoryItem {
        id
        tracked
        inventoryPolicy
        harmonizedSystemCode
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
    shop {
      url
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
/** A copy of a product, made as a draft to change (ADR-343). */
export const ProductDuplicateMutation = /* GraphQL */ `
  mutation ProductDuplicate(
    $productId: ID!
    $newTitle: String!
    $newStatus: ProductStatus
    $includeImages: Boolean
  ) {
    productDuplicate(
      productId: $productId
      newTitle: $newTitle
      newStatus: $newStatus
      includeImages: $includeImages
    ) {
      newProduct {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

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

/** The product types and vendors the shop uses, the most used first, to suggest (CAT-01). */
export const ProductSuggestionsQuery = /* GraphQL */ `
  query ProductSuggestions {
    productTypes(first: 100)
    productVendors(first: 100)
  }
`;

/** The tags the shop's products use, the most used first, to offer a menu link (ADR-646). */
export const ProductTagsQuery = /* GraphQL */ `
  query ProductTags {
    productTags(first: 30)
  }
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

/**
 * A variant's stock tracked or not, and sold or not once none is available (INV-01), and its HS
 * code (CAT-19).
 */
export const InventoryItemUpdateMutation = /* GraphQL */ `
  mutation InventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem {
        id
        tracked
        inventoryPolicy
        harmonizedSystemCode
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const PRODUCT_BULK_PAYLOAD = /* GraphQL */ `
  products {
    id
  }
  userErrors {
    ...Problems
  }
`;

/** Products chosen on the list shown, hidden or archived at once (CAT-04). */
export const ProductBulkUpdateStatusMutation = /* GraphQL */ `
  mutation ProductBulkUpdateStatus($ids: [ID!]!, $status: ProductStatus!) {
    productBulkUpdateStatus(ids: $ids, status: $status) {
      ${PRODUCT_BULK_PAYLOAD}
    }
  }
  ${USER_ERRORS}
`;

/** Tags added to the products chosen, those they have already left as they are. */
export const ProductBulkAddTagsMutation = /* GraphQL */ `
  mutation ProductBulkAddTags($ids: [ID!]!, $tags: [String!]!) {
    productBulkAddTags(ids: $ids, tags: $tags) {
      ${PRODUCT_BULK_PAYLOAD}
    }
  }
  ${USER_ERRORS}
`;

/** Tags taken off the products chosen. */
export const ProductBulkRemoveTagsMutation = /* GraphQL */ `
  mutation ProductBulkRemoveTags($ids: [ID!]!, $tags: [String!]!) {
    productBulkRemoveTags(ids: $ids, tags: $tags) {
      ${PRODUCT_BULK_PAYLOAD}
    }
  }
  ${USER_ERRORS}
`;

/** The products chosen deleted, with their variants and photos. */
export const ProductBulkDeleteMutation = /* GraphQL */ `
  mutation ProductBulkDelete($ids: [ID!]!) {
    productBulkDelete(ids: $ids) {
      deletedProductIds
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

/** A product's photos cropped to the product in each, in the shape asked (CAT-21, ADR-503). */
export const ProductAutoCropMediaMutation = /* GraphQL */ `
  mutation ProductAutoCropMedia($productId: ID!, $aspectRatio: ImageAspectRatio!) {
    productAutoCropMedia(productId: $productId, aspectRatio: $aspectRatio) {
      croppedMediaIds
      skipped {
        mediaId
        reason
      }
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

/** Tags added to the customers chosen, those they have already left as they are (CUS-01). */
export const CustomerBulkAddTagsMutation = /* GraphQL */ `
  mutation CustomerBulkAddTags($ids: [ID!]!, $tags: [String!]!) {
    customerBulkAddTags(ids: $ids, tags: $tags) {
      customers {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Tags taken off the customers chosen. */
export const CustomerBulkRemoveTagsMutation = /* GraphQL */ `
  mutation CustomerBulkRemoveTags($ids: [ID!]!, $tags: [String!]!) {
    customerBulkRemoveTags(ids: $ids, tags: $tags) {
      customers {
        id
      }
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
      savedAddresses {
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
    courierRules {
      id
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
    byHand
    parcelCount
    handedOverCount
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

/** A pickup's parcels, each with whether its rider has taken it (ADR-377). */
export const CourierPickupParcelsQuery = /* GraphQL */ `
  query CourierPickupParcels($id: ID!) {
    courierPickup(id: $id) {
      id
      parcelCount
      handedOverCount
      parcels {
        booking {
          id
          orderId
          orderName
          trackingNumber
          parcelStatus
        }
        handedOverAt
      }
    }
  }
`;

/** Parcels handed to a rider that the courier's tracking has not seen a day on (ADR-379). */
export const CourierParcelsUnseenQuery = /* GraphQL */ `
  query CourierParcelsUnseen {
    shop {
      timezone
    }
    courierParcelsUnseen(first: 50) {
      booking {
        id
        orderId
        orderName
        trackingNumber
        courierName
      }
      handedOverAt
      pickupId
      riderName
      riderCode
    }
  }
`;

/** One of a pickup's parcels checked off as its rider takes it, scanned from its label. */
export const CourierPickupParcelHandOverMutation = /* GraphQL */ `
  mutation CourierPickupParcelHandOver($pickupId: ID!, $trackingNumber: String!) {
    courierPickupParcelHandOver(pickupId: $pickupId, trackingNumber: $trackingNumber) {
      parcel {
        booking {
          id
          orderName
          trackingNumber
        }
        handedOverAt
      }
      alreadyHandedOver
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The parcels waiting recorded as handed to a courier's rider by hand (ADR-378). */
export const CourierPickupRecordByHandMutation = /* GraphQL */ `
  mutation CourierPickupRecordByHand($input: CourierPickupInput!) {
    courierPickupRecordByHand(input: $input) {
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

/** The shop's staff by name, A to Z, to name in a comment (ADR-637). */
export const StaffNamesQuery = /* GraphQL */ `
  query StaffNames {
    staffNames {
      id
      name
    }
  }
`;

/** Who works in the shop, and the invitations still open (ADR-101). */
export const StaffQuery = /* GraphQL */ `
  query Staff {
    staffMembers {
      id
      name
      email
      role
      customRole {
        id
        name
        basedOn
      }
      joinedAt
      expiresAt
    }
    staffInvitations {
      id
      role
      customRole {
        id
        name
        basedOn
      }
      note
      email
      invitedBy
      expiresAt
      accessDays
    }
  }
`;

const CUSTOM_ROLE = /* GraphQL */ `
  fragment CustomRoleParts on CustomRole {
    id
    name
    basedOn
    scopes
    capabilities
    staffMemberCount
    createdAt
    updatedAt
  }
`;

/**
 * The shop's custom roles (ADR-578), and the presets they are made from with what each holds:
 * for those who manage staff.
 */
export const CustomRolesQuery = /* GraphQL */ `
  query CustomRoles {
    customRoles {
      ...CustomRoleParts
    }
    rolePresets {
      role
      scopes
      capabilities
      customizable
    }
  }
  ${CUSTOM_ROLE}
`;

/** A custom role made from a preset, with some of its scopes and capabilities. */
export const CustomRoleCreateMutation = /* GraphQL */ `
  mutation CustomRoleCreate($input: CustomRoleCreateInput!) {
    customRoleCreate(input: $input) {
      customRole {
        ...CustomRoleParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${CUSTOM_ROLE}
  ${USER_ERRORS}
`;

/** A custom role's name, scopes or capabilities changed; its preset stays. */
export const CustomRoleUpdateMutation = /* GraphQL */ `
  mutation CustomRoleUpdate($id: ID!, $input: CustomRoleUpdateInput!) {
    customRoleUpdate(id: $id, input: $input) {
      customRole {
        ...CustomRoleParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${CUSTOM_ROLE}
  ${USER_ERRORS}
`;

/** A custom role nobody holds, nor any invitation waiting, deleted. */
export const CustomRoleDeleteMutation = /* GraphQL */ `
  mutation CustomRoleDelete($id: ID!) {
    customRoleDelete(id: $id) {
      deletedCustomRoleId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const METAFIELD_DEFINITION = /* GraphQL */ `
  fragment MetafieldDefinitionParts on MetafieldDefinition {
    id
    ownerType
    namespace
    key
    type
    name
    description
    metafieldsCount
  }
`;

/** The shop's own fields of products, variants and collections (CAT-06, ADR-489). */
export const MetafieldDefinitionsQuery = /* GraphQL */ `
  query MetafieldDefinitions {
    metafieldDefinitions {
      ...MetafieldDefinitionParts
    }
  }
  ${METAFIELD_DEFINITION}
`;

/** A field of the shop's own defined: its name, and the type its values take. */
export const MetafieldDefinitionCreateMutation = /* GraphQL */ `
  mutation MetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        ...MetafieldDefinitionParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${METAFIELD_DEFINITION}
  ${USER_ERRORS}
`;

/** A field of the shop's own deleted, with its values. */
export const MetafieldDefinitionDeleteMutation = /* GraphQL */ `
  mutation MetafieldDefinitionDelete($id: ID!) {
    metafieldDefinitionDelete(id: $id, deleteAllAssociatedMetafields: true) {
      deletedDefinitionId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A product's custom fields: the shop's definitions for products, and the product's values. */
export const ProductMetafieldsQuery = /* GraphQL */ `
  query ProductMetafields($id: ID!) {
    metafieldDefinitions(ownerType: PRODUCT) {
      ...MetafieldDefinitionParts
    }
    product(id: $id) {
      id
      metafields {
        namespace
        key
        type
        value
      }
    }
  }
  ${METAFIELD_DEFINITION}
`;

/** Metafields set on products, variants or collections, all or none. */
export const MetafieldsSetMutation = /* GraphQL */ `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
        value
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Metafields deleted by their owner, namespace and key. */
export const MetafieldsDeleteMutation = /* GraphQL */ `
  mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        key
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Accounts asking to work in the shop for some days, waiting to be decided (ADR-488). */
export const StaffAccessRequestsQuery = /* GraphQL */ `
  query StaffAccessRequests {
    staffAccessRequests {
      id
      name
      email
      role
      accessDays
      message
      createdAt
      expiresAt
    }
  }
`;

/** A request for access approved: its account works in the shop until its days are up. */
export const StaffAccessRequestApproveMutation = /* GraphQL */ `
  mutation StaffAccessRequestApprove($id: ID!) {
    staffAccessRequestApprove(id: $id) {
      staffMember {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A request for access declined. */
export const StaffAccessRequestDeclineMutation = /* GraphQL */ `
  mutation StaffAccessRequestDecline($id: ID!) {
    staffAccessRequestDecline(id: $id) {
      declinedAccessRequestId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Someone invited to work in the shop by a link, emailed too where an address is given. */
export const StaffInvitationCreateMutation = /* GraphQL */ `
  mutation StaffInvitationCreate(
    $role: StaffMemberRole
    $customRoleId: ID
    $note: String
    $email: String
    $language: EmailLanguage
    $accessDays: Int
  ) {
    staffInvitationCreate(
      role: $role
      customRoleId: $customRoleId
      note: $note
      email: $email
      language: $language
      accessDays: $accessDays
    ) {
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

/** A staff member given another role, a preset or a custom role, from their next request. */
export const StaffMemberRoleUpdateMutation = /* GraphQL */ `
  mutation StaffMemberRoleUpdate($id: ID!, $role: StaffMemberRole, $customRoleId: ID) {
    staffMemberRoleUpdate(id: $id, role: $role, customRoleId: $customRoleId) {
      staffMember {
        id
        role
        customRole {
          id
        }
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
    cutoffHour
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

/**
 * A gateway account's credentials replaced, every one, or the account moved between its test
 * environment and the real one with that one's credentials; confirmed recently.
 */
export const PaymentGatewayAccountUpdateMutation = /* GraphQL */ `
  mutation PaymentGatewayAccountUpdate($id: ID!, $input: PaymentGatewayAccountInput!) {
    paymentGatewayAccountUpdate(id: $id, input: $input) {
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
    customApps
    automations
    loyalty
    conversionsApi
    removeBranding
    trueProfit
    pixels
    aiCredits
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
    tax {
      ...Money
    }
    taxRate
    taxAuthority
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
      freeAt
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
    billingAiCredits {
      perMonth
      used
      bought
      left
      renewsAt
      packCredits
      packPrice {
        ...Money
      }
    }
  }
  ${BILLING_PLAN}
  ${BILLING_INVOICE}
  ${MONEY}
`;

/** What changed the shop's message credit, the newest first (BIL-03). */
export const BillingWalletEntriesQuery = /* GraphQL */ `
  query BillingWalletEntries($first: Int!) {
    billingWalletEntries(first: $first) {
      id
      kind
      amount {
        ...Money
      }
      balance {
        ...Money
      }
      channel
      category
      parts
      note
      createdAt
    }
  }
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

/** AI credits bought from the shop's message credit, a pack at a time (ADR-540). */
export const BillingAiCreditsBuyMutation = /* GraphQL */ `
  mutation BillingAiCreditsBuy($packs: Int!) {
    billingAiCreditsBuy(packs: $packs) {
      aiCredits {
        bought
        left
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

const AUTOMATIC_DISCOUNT = /* GraphQL */ `
  fragment Automatic on AutomaticDiscount {
    id
    title
    kind
    summary
    status
    combinesWithCodes
    startsAt
    endsAt
  }
`;

/** The shop's automatic discounts, newest first (ADR-515). */
export const AutomaticDiscountsQuery = /* GraphQL */ `
  query AutomaticDiscounts {
    automaticDiscounts {
      ...Automatic
    }
  }
  ${AUTOMATIC_DISCOUNT}
`;

/** An automatic discount made (ADR-515). */
export const AutomaticDiscountCreateMutation = /* GraphQL */ `
  mutation AutomaticDiscountCreate($automaticDiscount: AutomaticDiscountInput!) {
    automaticDiscountCreate(automaticDiscount: $automaticDiscount) {
      automaticDiscount {
        ...Automatic
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${AUTOMATIC_DISCOUNT}
  ${USER_ERRORS}
`;

/** An automatic discount changed: here, ended now. */
export const AutomaticDiscountUpdateMutation = /* GraphQL */ `
  mutation AutomaticDiscountUpdate($id: ID!, $automaticDiscount: AutomaticDiscountInput!) {
    automaticDiscountUpdate(id: $id, automaticDiscount: $automaticDiscount) {
      automaticDiscount {
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

/** An automatic discount deleted; orders placed with it keep its title. */
export const AutomaticDiscountDeleteMutation = /* GraphQL */ `
  mutation AutomaticDiscountDelete($id: ID!) {
    automaticDiscountDelete(id: $id) {
      deletedAutomaticDiscountId
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
      discountCode
      totalPrice {
        ...Money
      }
      codAmount {
        ...Money
      }
      deliveryMethod
      location {
        id
        name
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
    grossProfit {
      ...Money
    }
    profit {
      ...Money
    }
    shippingCostsEstimated {
      ...Money
    }
    adSpend {
      ...Money
    }
    returnOnAdSpend
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
      trueProfit
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

const COURIER_TALLY = /* GraphQL */ `
  fragment CourierTally on CourierPerformanceCity {
    shipped
    delivered
    returned
    lost
    inTransit
    deliveryRate
    returnRate
    daysToDeliver
    chargePerParcel {
      ...Money
    }
  }
`;

/**
 * How each courier's parcels shipped in a period went (SHP-08), everywhere and in its busiest
 * cities: delivered and returned, the days they took, and what each cost.
 */
export const CourierPerformanceQuery = /* GraphQL */ `
  query CourierPerformance($shippedFrom: DateTime!, $shippedBefore: DateTime!) {
    courierPerformance(shippedFrom: $shippedFrom, shippedBefore: $shippedBefore, cities: 10) {
      courier
      title
      shipped
      delivered
      returned
      lost
      inTransit
      deliveryRate
      returnRate
      daysToDeliver
      chargePerParcel {
        ...Money
      }
      chargesEstimated {
        ...Money
      }
      cities {
        city
        ...CourierTally
      }
    }
  }
  ${COURIER_TALLY}
  ${MONEY}
`;

/**
 * How each agent of the Confirmation Desk did over a period (COD-11), and the staff's names for
 * them: both for owners and managers alone.
 */
export const PackersQuery = /* GraphQL */ `
  query Packers($from: DateTime!, $before: DateTime!, $managing: Boolean!) {
    packers(from: $from, before: $before) {
      id
      kind
      packed
      units
      activeHours
      packedPerHour
    }
    staffMembers @include(if: $managing) {
      id
      name
    }
  }
`;

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
/**
 * A courier's dispute sheet (ADR-605): the parcels whose cash it has held a week or more, as an
 * Excel workbook to send it.
 */
export const CodDisputeSheetQuery = /* GraphQL */ `
  query CodDisputeSheet($courier: String, $olderThanDays: Int) {
    codDisputeSheet(courier: $courier, olderThanDays: $olderThanDays) {
      filename
      contentType
      content
    }
  }
`;

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

const PAYMENT_SETTLEMENT_SUMMARY = /* GraphQL */ `
  fragment PaymentSettlementSummary on PaymentSettlement {
    id
    accountId
    gateway
    gatewayName
    reference
    createdAt
    lineCount
    issueCount
    gross {
      ...Money
    }
    fees {
      ...Money
    }
    tax {
      ...Money
    }
    net {
      ...Money
    }
  }
`;

/** The gateway accounts whose settlements the shop imports, and those imported (PAY-07). */
export const PaymentSettlementsQuery = /* GraphQL */ `
  query PaymentSettlements {
    paymentSettlementAccounts {
      id
      gateway
      gatewayName
      sandbox
    }
    paymentSettlements(first: 50) {
      ...PaymentSettlementSummary
    }
  }
  ${PAYMENT_SETTLEMENT_SUMMARY}
  ${MONEY}
`;

/** A gateway's settlement with its lines, in the file's order. */
export const PaymentSettlementQuery = /* GraphQL */ `
  query PaymentSettlement($id: ID!) {
    paymentSettlement(id: $id) {
      ...PaymentSettlementSummary
      lines {
        row
        transactionRef
        orderId
        outcome
        gross {
          ...Money
        }
        fees {
          ...Money
        }
        tax {
          ...Money
        }
        paid {
          ...Money
        }
      }
    }
  }
  ${PAYMENT_SETTLEMENT_SUMMARY}
  ${MONEY}
`;

/** A gateway's settlement statement read, and imported unless only checked. */
export const PaymentSettlementImportMutation = /* GraphQL */ `
  mutation PaymentSettlementImport(
    $accountId: ID!
    $csv: String
    $xlsx: String
    $reference: String
    $dryRun: Boolean
  ) {
    paymentSettlementImport(
      accountId: $accountId
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
        matched
        differs
        unmatched
        repeated
        refund
      }
      gross {
        ...Money
      }
      fees {
        ...Money
      }
      tax {
        ...Money
      }
      net {
        ...Money
      }
      settlement {
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

/** What a period's statements, a source's or a month's came to: the same fields on each type. */
const PAYOUT_TOTAL_FIELDS = `
  statements
  gross {
    ...Money
  }
  fees {
    ...Money
  }
  tax {
    ...Money
  }
  net {
    ...Money
  }
`;

/** What gateways and couriers paid over a period, and the tax they withheld (ANL-09, TAX-03). */
export const PayoutsReportQuery = /* GraphQL */ `
  query PayoutsReport($from: DateTime!, $before: DateTime!) {
    payoutsReport(from: $from, before: $before) {
      totals {
        ${PAYOUT_TOTAL_FIELDS}
      }
      sources {
        kind
        name
        ${PAYOUT_TOTAL_FIELDS}
      }
      months {
        month
        ${PAYOUT_TOTAL_FIELDS}
      }
      withholdings {
        id
        kind
        name
        reference
        importedAt
        gross {
          ...Money
        }
        fees {
          ...Money
        }
        tax {
          ...Money
        }
        net {
          ...Money
        }
      }
      truncated
    }
  }
  ${MONEY}
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

/**
 * Parcels whose courier tried to deliver them and couldn't, with what their customers answered on
 * WhatsApp since (COD-08, ADR-388).
 */
export const DeliveriesToRescueQuery = /* GraphQL */ `
  query DeliveriesToRescue {
    deliveriesToRescue(first: 100) {
      count
      parcels {
        id
        orderId
        orderName
        customerName
        city
        trackingInfo {
          company
          number
        }
        attemptedAt
        reason
        attempts
        answer
        answeredAt
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

/** A cash-on-delivery order let go without its advance, the courier collecting it (ADR-653). */
export const OrderWaiveAdvanceMutation = /* GraphQL */ `
  mutation OrderWaiveAdvance($id: ID!) {
    orderWaiveAdvance(id: $id) {
      order {
        id
        stage
        advanceDue {
          ...Money
        }
        codAmount {
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
  query HomeStock($locationId: ID) {
    home(locationId: $locationId) {
      lowStock {
        low
        out
        threshold
      }
      transfersToReceive
    }
  }
`;

/** The variants running low or out, the fewest for sale first, and what the shop calls low. */
export const LowStockQuery = /* GraphQL */ `
  query LowStock($locationId: ID) {
    inventorySettings {
      lowStockThreshold
    }
    inventoryLowStock(first: 100, locationId: $locationId) {
      nodes {
        variantId
        variantTitle
        productId
        productTitle
        sku
        available
        incoming
        lastSupplier {
          id
          name
        }
        soldLast30Days
        daysOfStockLeft
        lastUnitCost {
          amount
        }
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
          barcode
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

/** Variants found by a barcode or SKU in a count, with what was on hand at the location counted. */
export const StockCountFindQuery = /* GraphQL */ `
  query StockCountFind($query: String!, $locationId: ID!) {
    products(first: 5, query: $query) {
      nodes {
        id
        title
        variants {
          id
          title
          sku
          barcode
          inventoryItem {
            id
            inventoryLevel(locationId: $locationId) {
              onHand
            }
          }
        }
      }
    }
  }
`;

/** A page of a variant's stock changes: each with why, what was left and what it was for. */
const STOCK_CHANGES = /* GraphQL */ `
  nodes {
    createdAt
    delta
    name
    reason
    quantityAfterChange
    referenceDocumentUri
    location {
      id
      name
    }
  }
  pageInfo {
    hasNextPage
    endCursor
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
        ${STOCK_CHANGES}
      }
    }
  }
`;

/** A variant's older stock changes, a page at a time, at every location or one (INV-03). */
export const InventoryChangesQuery = /* GraphQL */ `
  query InventoryChanges($id: ID!, $after: String, $locationId: ID) {
    inventoryItem(id: $id) {
      id
      changes(first: 20, after: $after, locationId: $locationId) {
        ${STOCK_CHANGES}
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

/** Stock sent from one location to another, taken from one's on hand and added to the other's. */
export const InventoryMoveMutation = /* GraphQL */ `
  mutation InventoryMove($input: InventoryMoveQuantitiesInput!) {
    inventoryMoveQuantities(input: $input) {
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
    shop {
      url
    }
    collection(id: $id) {
      id
      title
      handle
      seo {
        title
        description
      }
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
    shop {
      url
    }
    page(id: $id) {
      id
      title
      handle
      seo {
        title
        description
      }
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
    tags
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
        updatedAt
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

/**
 * A menu's title and all its links, those left out going; refused if it was saved since it was
 * read (ADR-642).
 */
export const MenuUpdateMutation = /* GraphQL */ `
  mutation MenuUpdate(
    $id: ID!
    $title: String!
    $items: [MenuItemUpdateInput!]!
    $ifUnchangedSince: DateTime
  ) {
    menuUpdate(id: $id, title: $title, items: $items, ifUnchangedSince: $ifUnchangedSince) {
      menu {
        id
        updatedAt
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

/** The shop's things of a kind that may be put in Urdu, the newest first, with their Urdu (OS-06). */
export const UrduOverviewQuery = /* GraphQL */ `
  query UrduOverview($type: TranslatableResourceType!, $first: Int!) {
    translatableResources(resourceType: $type, first: $first) {
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
      pageInfo {
        hasNextPage
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

/** The shop's verification by Hatti: what is verified, and its requests (ONB-11, ADR-465). */
export const ShopVerificationQuery = /* GraphQL */ `
  query ShopVerification {
    shopVerification {
      level
      requests {
        id
        level
        name
        cnicLast4
        ntn
        status
        createdAt
        decidedAt
        answer
      }
    }
  }
`;

/** The name the shop's SMS go from, and its requests for one of its own (MKT-02, ADR-469). */
export const SmsSenderQuery = /* GraphQL */ `
  query SmsSender {
    smsSender {
      name
      requests {
        id
        name
        status
        createdAt
        decidedAt
        answer
      }
    }
  }
`;

/** Asks Hatti for the shop's SMS to go from a name of its own. */
export const SmsSenderRequestMutation = /* GraphQL */ `
  mutation SmsSenderRequest($name: String!) {
    smsSenderRequest(name: $name) {
      request {
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

/** Withdraws the shop's request for a sender name waiting for Hatti. */
export const SmsSenderWithdrawMutation = /* GraphQL */ `
  mutation SmsSenderWithdraw {
    smsSenderWithdraw {
      request {
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

/** The owner asks Hatti to verify the shop, with its documents' staged uploads (ONB-11). */
export const ShopVerificationSubmitMutation = /* GraphQL */ `
  mutation ShopVerificationSubmit($input: ShopVerificationInput!) {
    shopVerificationSubmit(input: $input) {
      request {
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

/** Whether AI drafts the shop's Urdu here, and how many of the day's it asked for (CAT-07). */
/** Whether this Hatti writes products' copy with AI, and how many of the day's drafts are used. */
export const MarketingCalendarQuery = /* GraphQL */ `
  query MarketingCalendar {
    marketingCalendar {
      moment
      startsOn
      endsOn
      promoteFrom
      expected
      kit {
        code
        percentage
        messageEnglish
        messageUrdu
      }
    }
  }
`;

export const StoreSpeedQuery = /* GraphQL */ `
  query StoreSpeed {
    storeSpeed {
      pageViews
      devices {
        device
        pageViews
        score
        metrics {
          metric
          samples
          p75
          over
          good
          rating
        }
      }
      fixes {
        fix
        device
        kind
        metric
        rating
      }
    }
  }
`;

export const StarterKitsQuery = /* GraphQL */ `
  query StarterKits {
    starterKits {
      kit
      collections {
        title
        handle
        tag
      }
      sizeCharts
    }
  }
`;

export const StarterKitApplyMutation = /* GraphQL */ `
  mutation StarterKitApply($kit: StarterKit!) {
    starterKitApply(kit: $kit) {
      collectionsMade
      collectionsKept
      sizeChartsMade
      menuLinksAdded
    }
  }
`;

export const ProductCategoriesQuery = /* GraphQL */ `
  query ProductCategories {
    productCategories
  }
`;

export const ProductCopyDraftingQuery = /* GraphQL */ `
  query ProductCopyDrafting {
    productCopyDrafting {
      available
      usedToday
      limitPerDay
      creditsLeft
      creditsPerMonth
    }
  }
`;

/** A product's title and description written with AI from what its form says (CAT-20). */
export const ProductCopyDraftMutation = /* GraphQL */ `
  mutation ProductCopyDraft($input: ProductCopyDraftInput!) {
    productCopyDraft(input: $input) {
      draft {
        title
        descriptionHtml
        seoTitle
        seoDescription
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

export const TranslationDraftingQuery = /* GraphQL */ `
  query TranslationDrafting {
    translationDrafting {
      available
      usedToday
      limitPerDay
      creditsLeft
      creditsPerMonth
    }
  }
`;

/** AI drafts of a thing's fields in Urdu, each with the digest of its words; none kept (CAT-07). */
export const TranslationsDraftMutation = /* GraphQL */ `
  mutation TranslationsDraft($resourceId: ID!, $keys: [String!]) {
    translationsDraft(resourceId: $resourceId, locale: "ur", keys: $keys) {
      drafts {
        key
        value
        translatableContentDigest
      }
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
    shop {
      url
    }
    blog(id: $id) {
      id
      title
      handle
      seo {
        title
        description
      }
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
    shop {
      url
    }
    article(id: $id) {
      id
      title
      handle
      seo {
        title
        description
      }
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

/** The shop's files, the newest first, for a picture setting to choose one of (ADR-631). */
export const ShopFilesQuery = /* GraphQL */ `
  query ShopFiles($first: Int!, $after: String, $query: String) {
    files(first: $first, after: $after, query: $query) {
      nodes {
        id
        filename
        mimeType
        url
        alt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** Files of the shop's deleted, with what storage keeps of them (ADR-636). */
/** Where one of the shop's files is used, asked before it is deleted (ADR-639). */
export const FileUsesQuery = /* GraphQL */ `
  query FileUses($id: ID!) {
    file(id: $id) {
      id
      uses {
        kind
        id
        title
      }
    }
  }
`;

export const FileUpdateMutation = /* GraphQL */ `
  mutation FileUpdate($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files {
        id
        filename
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

export const FileDeleteMutation = /* GraphQL */ `
  mutation FileDelete($fileIds: [ID!]!) {
    fileDelete(fileIds: $fileIds) {
      deletedFileIds
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
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
    maintenanceCheckoutOnly
    seo {
      title
      description
    }
    returnDays
    returnExchangesOnly
    hidePoweredBy
    consentBanner
    robotsTxtRules
  }
`;

/**
 * The storefront's password, its pause, its home page for search engines, and the return window
 * its products show (OS-09, OS-11, OS-15).
 */
export const StorefrontPreferencesQuery = /* GraphQL */ `
  query StorefrontPreferences {
    onlineStorePreferences {
      ...StorefrontPreferences
    }
  }
  ${STOREFRONT_PREFERENCES}
`;

/**
 * Whether a crawler may fetch an address by the storefront's robots.txt (ADR-616), with the saved
 * rules or those being written.
 */
export const RobotsTxtTestQuery = /* GraphQL */ `
  query RobotsTxtTest($path: String!, $userAgent: String, $robotsTxtRules: String) {
    robotsTxtTest(path: $path, userAgent: $userAgent, robotsTxtRules: $robotsTxtRules) {
      allowed
      rule
      userAgent
      problems
    }
  }
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

const ONLINE_STORE_FILTERS = /* GraphQL */ `
  fragment OnlineStoreFilterFields on StorefrontFilter {
    kind
    key
    label
    labelUr
    defaultLabel
    metafieldType
  }
  fragment OnlineStoreFiltersFields on OnlineStoreFilters {
    filters {
      ...OnlineStoreFilterFields
    }
    availableFilters {
      ...OnlineStoreFilterFields
    }
  }
`;

/**
 * The filters the storefront's collection and search pages show, null for every one in the
 * platform's order, and those the shop could choose (ADR-568).
 */
export const OnlineStoreFiltersQuery = /* GraphQL */ `
  query OnlineStoreFilters {
    onlineStoreFilters {
      ...OnlineStoreFiltersFields
    }
  }
  ${ONLINE_STORE_FILTERS}
`;

/** The storefront's filters chosen, in their order and words, or null for the platform's. */
export const OnlineStoreFiltersUpdateMutation = /* GraphQL */ `
  mutation OnlineStoreFiltersUpdate($input: OnlineStoreFiltersInput!) {
    onlineStoreFiltersUpdate(input: $input) {
      onlineStoreFilters {
        ...OnlineStoreFiltersFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${ONLINE_STORE_FILTERS}
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
        finalTarget
        loops
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

/** A redirect's old address or where it goes changed, in place (OS-09). */
export const UrlRedirectUpdateMutation = /* GraphQL */ `
  mutation UrlRedirectUpdate($id: ID!, $urlRedirect: UrlRedirectInput!) {
    urlRedirectUpdate(id: $id, urlRedirect: $urlRedirect) {
      urlRedirect {
        id
        path
        target
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
export const UrlRedirectsStraightenMutation = /* GraphQL */ `
  mutation UrlRedirectsStraighten {
    urlRedirectsStraighten {
      updated
      userErrors {
        field
        code
        message
      }
    }
  }
`;

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
    orders(first: 5) {
      id
      name
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
    province
    filerStatus
    tier1
    withholding {
      digitalPercent
      cashOnDeliveryPercent
    }
    guidance {
      code
      status
    }
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

const FBR_POS = /* GraphQL */ `
  fragment FbrPosParts on FbrPos {
    system
    posId
    accessTokenHint
    environment
    pctCode
    updatedAt
  }
`;

/**
 * The shop's connection to FBR, if it made one: its POS as FBR registered it, or FBR's digital
 * invoicing (POS-04, ADR-555, ADR-562).
 */
export const FbrPosQuery = /* GraphQL */ `
  query FbrPos {
    fbrPos {
      ...FbrPosParts
    }
  }
  ${FBR_POS}
`;

/** The shop connected to FBR, or what it gave changed, or how it reports switched. */
export const FbrPosUpdateMutation = /* GraphQL */ `
  mutation FbrPosUpdate($input: FbrPosInput!) {
    fbrPosUpdate(input: $input) {
      fbrPos {
        ...FbrPosParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${FBR_POS}
  ${USER_ERRORS}
`;

/** The shop disconnected from FBR: its token forgotten, invoices waiting not sent. */
export const FbrPosDeleteMutation = /* GraphQL */ `
  mutation FbrPosDelete {
    fbrPosDelete {
      deletedSystem
      deletedPosId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The latest invoices and credit notes issued while FBR was connected, and how each went. */
export const FiscalInvoicesQuery = /* GraphQL */ `
  query FiscalInvoices($status: FiscalInvoiceStatus) {
    fiscalInvoices(first: 50, status: $status) {
      id
      system
      kind
      usin
      orderId
      status
      fbrInvoiceNumber
      attempts
      error
      reportedAt
      createdAt
    }
  }
`;

/** One FBR refused, or one disconnecting left unsent, sent to FBR again. */
export const FiscalInvoiceRetryMutation = /* GraphQL */ `
  mutation FiscalInvoiceRetry($id: ID!) {
    fiscalInvoiceRetry(id: $id) {
      fiscalInvoice {
        usin
        status
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const META_CONVERSIONS = /* GraphQL */ `
  fragment MetaConversionsParts on MetaConversions {
    pixelId
    accessTokenHint
    purchaseAt
    testEventCode
    staffOrders
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

const TIKTOK_EVENTS = /* GraphQL */ `
  fragment TikTokEventsParts on TikTokEvents {
    pixelCode
    accessTokenHint
    purchaseAt
    testEventCode
    updatedAt
  }
`;

/** The shop's TikTok pixel, if it connected one (ADR-541). */
export const TikTokEventsQuery = /* GraphQL */ `
  query TikTokEvents {
    tiktokEvents {
      ...TikTokEventsParts
    }
  }
  ${TIKTOK_EVENTS}
`;

/** The shop's TikTok pixel connected, or how its orders go to it changed. */
export const TikTokEventsUpdateMutation = /* GraphQL */ `
  mutation TikTokEventsUpdate($input: TikTokEventsInput!) {
    tiktokEventsUpdate(input: $input) {
      tiktokEvents {
        ...TikTokEventsParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${TIKTOK_EVENTS}
  ${USER_ERRORS}
`;

/** The shop's TikTok pixel disconnected: its token forgotten, moments waiting not sent. */
export const TikTokEventsDeleteMutation = /* GraphQL */ `
  mutation TikTokEventsDelete {
    tiktokEventsDelete {
      deletedPixelCode
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const GOOGLE_ANALYTICS = /* GraphQL */ `
  fragment GoogleAnalyticsParts on GoogleAnalytics {
    measurementId
    apiSecretHint
    purchaseAt
    updatedAt
  }
`;

/** The shop's Google Analytics web stream, if it connected one (ADR-547). */
export const GoogleAnalyticsQuery = /* GraphQL */ `
  query GoogleAnalytics {
    googleAnalytics {
      ...GoogleAnalyticsParts
    }
  }
  ${GOOGLE_ANALYTICS}
`;

/** The shop's Google Analytics web stream connected, or how its orders go to it changed. */
export const GoogleAnalyticsUpdateMutation = /* GraphQL */ `
  mutation GoogleAnalyticsUpdate($input: GoogleAnalyticsInput!) {
    googleAnalyticsUpdate(input: $input) {
      googleAnalytics {
        ...GoogleAnalyticsParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${GOOGLE_ANALYTICS}
  ${USER_ERRORS}
`;

/** The shop's web stream disconnected: its secret forgotten, moments waiting not sent. */
export const GoogleAnalyticsDeleteMutation = /* GraphQL */ `
  mutation GoogleAnalyticsDelete {
    googleAnalyticsDelete {
      deletedMeasurementId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/**
 * The latest moments of the shop's orders sent, or to be sent, to one ad platform, and how each
 * went.
 */
export const ConversionEventsQuery = /* GraphQL */ `
  query ConversionEvents($status: ConversionStatus, $platform: ConversionPlatform) {
    conversionEvents(first: 50, status: $status, platform: $platform) {
      nodes {
        id
        platform
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
    upsellPercentOff
    creditBackOnReturn
    confirmationCalls
    staffDiscountPercent
    shareNewOrders
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
        requestedBy
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
const GIFT_OPTIONS = /* GraphQL */ `
  fragment GiftOptions on CheckoutGiftOptions {
    wrap {
      variantId
      productTitle
      variantTitle
      price {
        ...Money
      }
      forSale
    }
    messages
  }
  ${MONEY}
`;

/** The variant sold as gift wrap, null for none, and whether checkout asks for a gift message. */
export const CheckoutGiftOptionsUpdateMutation = /* GraphQL */ `
  mutation CheckoutGiftOptionsUpdate($input: CheckoutGiftOptionsInput!) {
    checkoutGiftOptionsUpdate(input: $input) {
      checkoutGiftOptions {
        ...GiftOptions
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${GIFT_OPTIONS}
  ${USER_ERRORS}
`;

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
    checkoutRecoverySettings {
      reminderAfterMinutes
      offerAfterHours
      offerDiscountCode {
        id
        code
        summary
      }
    }
    discountCodes(first: 100) {
      nodes {
        id
        code
        kind
        summary
        status
      }
    }
    checkoutGiftOptions {
      ...GiftOptions
    }
  }
  ${GIFT_OPTIONS}
`;

/**
 * How long after a shopper leaves checkout they are reminded on WhatsApp, null for never; and the
 * shop's code offered some hours after, null for none (ADR-426).
 */
export const CheckoutRecoverySettingsUpdateMutation = /* GraphQL */ `
  mutation CheckoutRecoverySettingsUpdate(
    $reminderAfterMinutes: Int
    $offerDiscountCodeId: ID
    $offerAfterHours: Int
  ) {
    checkoutRecoverySettingsUpdate(
      reminderAfterMinutes: $reminderAfterMinutes
      offerDiscountCodeId: $offerDiscountCodeId
      offerAfterHours: $offerAfterHours
    ) {
      checkoutRecoverySettings {
        reminderAfterMinutes
        offerAfterHours
        offerDiscountCode {
          id
          code
          summary
        }
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Checkouts shoppers left after typing their number (CHK-12), the latest first. */
export const AbandonedCheckoutsQuery = /* GraphQL */ `
  query AbandonedCheckouts($first: Int, $after: ID) {
    abandonedCheckouts(first: $first, after: $after) {
      id
      createdAt
      abandonedAt
      name
      phone
      lineItems {
        variantId
        title
        variantTitle
        quantity
      }
      subtotalPrice {
        amount
        currencyCode
      }
      remindedAt
      offeredAt
      offerCode
      recoveredOrder {
        id
        name
      }
    }
    checkoutRecoverySettings {
      reminderAfterMinutes
      offerAfterHours
      offerDiscountCode {
        id
        code
      }
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

/** Products from Shopify's or WooCommerce's product CSV, checked first in a dry run. */
export const ProductsImportMutation = /* GraphQL */ `
  mutation ProductsImport(
    $csv: String!
    $dryRun: Boolean
    $overwrite: Boolean
    $format: ProductImportFormat
  ) {
    productsImport(csv: $csv, dryRun: $dryRun, overwrite: $overwrite, format: $format) {
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
        localPickupSettings {
          instructions
        }
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
    localPickupSettings {
      instructions
    }
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

/** Another location made the primary one (ADR-357). */
export const LocationMakePrimaryMutation = /* GraphQL */ `
  mutation LocationMakePrimary($locationId: ID!) {
    locationMakePrimary(locationId: $locationId) {
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

/** Customers let to pick up their orders at a location, with what it tells them (ADR-389). */
export const LocationLocalPickupEnableMutation = /* GraphQL */ `
  mutation LocationLocalPickupEnable($settings: LocalPickupSettingsInput!) {
    locationLocalPickupEnable(localPickupSettings: $settings) {
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

/** Pickup at a location stopped (ADR-389). */
export const LocationLocalPickupDisableMutation = /* GraphQL */ `
  mutation LocationLocalPickupDisable($locationId: ID!) {
    locationLocalPickupDisable(locationId: $locationId) {
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

/** A purchase order's fields as its page shows them (INV-05). */
const PURCHASE_ORDER = /* GraphQL */ `
  id
  name
  status
  reference
  note
  expectedOn
  totalQuantity
  receivedQuantity
  totalCost {
    amount
    currencyCode
  }
  supplier {
    id
    name
    phone
  }
  location {
    id
    name
  }
  closedAt
  createdAt
  lines {
    id
    productTitle
    variantTitle
    sku
    quantity
    received
    unitCost {
      amount
      currencyCode
    }
    inventoryItem {
      id
    }
  }
`;

/** Purchase orders by status, the newest first, a page at a time. */
export const PurchaseOrdersQuery = /* GraphQL */ `
  query PurchaseOrders($status: PurchaseOrderStatus, $after: String, $supplierId: ID) {
    purchaseOrders(first: 25, status: $status, after: $after, supplierId: $supplierId) {
      nodes {
        id
        name
        status
        expectedOn
        totalQuantity
        receivedQuantity
        supplier {
          name
        }
        location {
          name
        }
        createdAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const PurchaseOrderQuery = /* GraphQL */ `
  query PurchaseOrder($id: ID!) {
    purchaseOrder(id: $id) {
      ${PURCHASE_ORDER}
    }
  }
`;

/** What a new purchase order is made from: the shop's suppliers and active locations. */
export const PurchaseOrderFormQuery = /* GraphQL */ `
  query PurchaseOrderForm {
    suppliers {
      id
      name
      phone
    }
    locations(first: 50) {
      nodes {
        id
        name
        isPrimary
      }
    }
  }
`;

export const SupplierCreateMutation = /* GraphQL */ `
  mutation SupplierCreate($input: SupplierInput!) {
    supplierCreate(input: $input) {
      supplier {
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

export const PurchaseOrderCreateMutation = /* GraphQL */ `
  mutation PurchaseOrderCreate($input: PurchaseOrderCreateInput!) {
    purchaseOrderCreate(input: $input) {
      purchaseOrder {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Goods that came, into stock at the order's location. */
export const PurchaseOrderReceiveMutation = /* GraphQL */ `
  mutation PurchaseOrderReceive($id: ID!, $input: PurchaseOrderReceiveInput!) {
    purchaseOrderReceive(id: $id, input: $input) {
      purchaseOrder {
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

export const PurchaseOrderCloseMutation = /* GraphQL */ `
  mutation PurchaseOrderClose($id: ID!) {
    purchaseOrderClose(id: $id) {
      purchaseOrder {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's suppliers, by name. */
export const SuppliersQuery = /* GraphQL */ `
  query Suppliers {
    suppliers {
      id
      name
      phone
      note
      purchasing {
        purchaseOrders
        receivedQuantity
        receivedCost {
          amount
        }
        awaitingQuantity
        awaitingCost {
          amount
        }
        lastOrderedAt
      }
    }
  }
`;

export const SupplierUpdateMutation = /* GraphQL */ `
  mutation SupplierUpdate($id: ID!, $input: SupplierInput!) {
    supplierUpdate(id: $id, input: $input) {
      supplier {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** An open order changed: its details, and lines added, changed or removed. */
export const PurchaseOrderUpdateMutation = /* GraphQL */ `
  mutation PurchaseOrderUpdate($id: ID!, $input: PurchaseOrderUpdateInput!) {
    purchaseOrderUpdate(id: $id, input: $input) {
      purchaseOrder {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** A purchase order as a page to print for its supplier. */
export const PurchaseOrderDocumentQuery = /* GraphQL */ `
  query PurchaseOrderDocument($id: ID!, $language: DocumentLanguage) {
    purchaseOrderDocument(id: $id, language: $language) {
      html
      title
      fileName
    }
  }
`;

const INVENTORY_TRANSFER = /* GraphQL */ `
  id
  name
  status
  reference
  note
  totalQuantity
  receivedQuantity
  lostQuantity
  origin {
    id
    name
  }
  destination {
    id
    name
  }
  closedAt
  createdAt
  lines {
    id
    productTitle
    variantTitle
    sku
    quantity
    received
    inventoryItem {
      id
    }
  }
`;

/** Transfers between the shop's locations by status, the newest first, a page at a time. */
export const InventoryTransfersQuery = /* GraphQL */ `
  query InventoryTransfers($status: InventoryTransferStatus, $after: String, $locationId: ID) {
    inventoryTransfers(first: 25, status: $status, after: $after, locationId: $locationId) {
      nodes {
        id
        name
        status
        totalQuantity
        receivedQuantity
        origin {
          name
        }
        destination {
          name
        }
        createdAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const InventoryTransferQuery = /* GraphQL */ `
  query InventoryTransfer($id: ID!) {
    inventoryTransfer(id: $id) {
      ${INVENTORY_TRANSFER}
    }
  }
`;

/** Stock sent from one location to another, off on hand where it leaves. */
export const InventoryTransferCreateMutation = /* GraphQL */ `
  mutation InventoryTransferCreate($input: InventoryTransferCreateInput!) {
    inventoryTransferCreate(input: $input) {
      inventoryTransfer {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Stock that arrived, on hand where it went. */
export const InventoryTransferReceiveMutation = /* GraphQL */ `
  mutation InventoryTransferReceive($id: ID!, $input: InventoryTransferReceiveInput!) {
    inventoryTransferReceive(id: $id, input: $input) {
      inventoryTransfer {
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

/** What had not arrived, back where it left. */
export const InventoryTransferCancelMutation = /* GraphQL */ `
  mutation InventoryTransferCancel($id: ID!) {
    inventoryTransferCancel(id: $id) {
      inventoryTransfer {
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
 * What runs low at a location, with where else each variant is available, to send it there from
 * another of the shop's locations.
 */
export const LowStockToSendQuery = /* GraphQL */ `
  query LowStockToSend($locationId: ID!) {
    inventorySettings {
      lowStockThreshold
    }
    inventoryLowStock(first: 100, locationId: $locationId) {
      nodes {
        variantId
        variantTitle
        productTitle
        available
        incoming
        inventoryItem {
          id
          inventoryLevels {
            available
            location {
              id
            }
          }
        }
      }
    }
  }
`;

/** A transfer as a page to print, to go with the stock, in the language chosen. */
export const InventoryTransferDocumentQuery = /* GraphQL */ `
  query InventoryTransferDocument($id: ID!, $language: DocumentLanguage) {
    inventoryTransferDocument(id: $id, language: $language) {
      html
      title
      fileName
    }
  }
`;

/** A transfer closed with what arrived, the rest lost on the way. */
export const InventoryTransferCloseMutation = /* GraphQL */ `
  mutation InventoryTransferClose($id: ID!) {
    inventoryTransferClose(id: $id) {
      inventoryTransfer {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** What the stock on hand is worth at cost, in all and by location (ADR-369). */
export const InventoryValueQuery = /* GraphQL */ `
  query InventoryValue {
    inventoryValue {
      units
      unitsWithoutCost
      value {
        amount
      }
      locations {
        location {
          id
          name
        }
        units
        unitsWithoutCost
        value {
          amount
        }
      }
    }
  }
`;

export const InventoryReportQuery = /* GraphQL */ `
  query InventoryReport($days: Int!, $sortKey: InventoryReportSortKey!) {
    inventoryReport(days: $days, sortKey: $sortKey, first: 50) {
      days
      sold
      onHand
      sellThrough
      ranOut
      outNow
      ageing {
        bucket
        variants
        units
        unitsWithoutCost
        value {
          amount
        }
      }
      rows {
        variantId
        productId
        productTitle
        variantTitle
        sku
        sold
        available
        sellThrough
        daysSinceSale
        stockouts
        daysOut
      }
    }
  }
`;

const COURIER_RULE = /* GraphQL */ `
  fragment CourierRuleFields on CourierRule {
    id
    accountId
    pick
    accountArchived
    cities
    codAtLeast {
      amount
      currencyCode
    }
    codBelow {
      amount
      currencyCode
    }
  }
`;

/** The shop's courier rules, in their order (SHP-06, ADR-382). */
export const CourierRulesQuery = /* GraphQL */ `
  query CourierRules {
    courierRules {
      ...CourierRuleFields
    }
  }
  ${COURIER_RULE}
`;

/** The shop's courier rules replaced, in the order given; none for none. */
export const CourierRulesUpdateMutation = /* GraphQL */ `
  mutation CourierRulesUpdate($rules: [CourierRuleInput!]!) {
    courierRulesUpdate(rules: $rules) {
      courierRules {
        ...CourierRuleFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${COURIER_RULE}
  ${USER_ERRORS}
`;

/** The account each order would be booked with now without one named (ADR-382). */
export const CourierAccountsForQuery = /* GraphQL */ `
  query CourierAccountsFor($orderIds: [ID!]!) {
    courierAccountsFor(orderIds: $orderIds) {
      orderId
      accountId
      ruleId
      chargeEstimate {
        amount
        currencyCode
      }
    }
  }
`;

const RATE_CARD = /* GraphQL */ `
  fragment RateCardFields on CourierRateCard {
    accountId
    originCity
    localFirst {
      amount
      currencyCode
    }
    localEach {
      amount
      currencyCode
    }
    otherFirst {
      amount
      currencyCode
    }
    otherEach {
      amount
      currencyCode
    }
    codFeePercent
    returnPercent
    updatedAt
  }
`;

/** The shop's courier accounts and their rate cards (SHP-07, ADR-383). */
export const CourierRateCardsQuery = /* GraphQL */ `
  query CourierRateCards {
    courierAccounts {
      id
      name
      courierName
    }
    courierRateCards {
      ...RateCardFields
    }
  }
  ${RATE_CARD}
`;

/** A courier account's rate card set whole. */
export const CourierRateCardSetMutation = /* GraphQL */ `
  mutation CourierRateCardSet($accountId: ID!, $input: CourierRateCardInput!) {
    courierRateCardSet(accountId: $accountId, input: $input) {
      courierRateCard {
        ...RateCardFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${RATE_CARD}
  ${USER_ERRORS}
`;

/** A courier account's rate card taken away. */
export const CourierRateCardRemoveMutation = /* GraphQL */ `
  mutation CourierRateCardRemove($accountId: ID!) {
    courierRateCardRemove(accountId: $accountId) {
      removed
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const CUSTOM_APP = /* GraphQL */ `
  fragment CustomAppFields on CustomApp {
    id
    name
    scopes
    tokenHint
    secretHint
    createdAt
  }
`;

export const CustomAppsQuery = /* GraphQL */ `
  query CustomApps {
    customApps {
      ...CustomAppFields
    }
  }
  ${CUSTOM_APP}
`;

export const CustomAppCreateMutation = /* GraphQL */ `
  mutation CustomAppCreate($input: CustomAppInput!) {
    customAppCreate(input: $input) {
      customApp {
        ...CustomAppFields
      }
      accessToken
      webhookSecret
      userErrors {
        ...Problems
      }
    }
  }
  ${CUSTOM_APP}
  ${USER_ERRORS}
`;

export const CustomAppUpdateMutation = /* GraphQL */ `
  mutation CustomAppUpdate($id: ID!, $input: CustomAppInput!) {
    customAppUpdate(id: $id, input: $input) {
      customApp {
        ...CustomAppFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${CUSTOM_APP}
  ${USER_ERRORS}
`;

export const CustomAppTokenRotateMutation = /* GraphQL */ `
  mutation CustomAppTokenRotate($id: ID!) {
    customAppTokenRotate(id: $id) {
      customApp {
        ...CustomAppFields
      }
      accessToken
      userErrors {
        ...Problems
      }
    }
  }
  ${CUSTOM_APP}
  ${USER_ERRORS}
`;

export const CustomAppSecretRotateMutation = /* GraphQL */ `
  mutation CustomAppSecretRotate($id: ID!) {
    customAppSecretRotate(id: $id) {
      customApp {
        ...CustomAppFields
      }
      webhookSecret
      userErrors {
        ...Problems
      }
    }
  }
  ${CUSTOM_APP}
  ${USER_ERRORS}
`;

export const CustomAppDeleteMutation = /* GraphQL */ `
  mutation CustomAppDelete($id: ID!) {
    customAppDelete(id: $id) {
      deletedCustomAppId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const WEBHOOK_DELIVERY = /* GraphQL */ `
  fragment WebhookDeliveryFields on WebhookDelivery {
    id
    status
    attempts
    responseStatus
    error
    createdAt
    lastAttemptAt
    nextAttemptAt
  }
`;

export const WebhookSubscriptionsQuery = /* GraphQL */ `
  query WebhookSubscriptions {
    webhookSubscriptions {
      id
      topic
      callbackUrl
      appId
      createdAt
      lastDelivery {
        ...WebhookDeliveryFields
      }
    }
  }
  ${WEBHOOK_DELIVERY}
`;

export const WebhookDeliveriesQuery = /* GraphQL */ `
  query WebhookDeliveries($subscriptionId: ID!, $first: Int) {
    webhookDeliveries(subscriptionId: $subscriptionId, first: $first) {
      ...WebhookDeliveryFields
    }
  }
  ${WEBHOOK_DELIVERY}
`;

export const WebhookSubscriptionCreateMutation = /* GraphQL */ `
  mutation WebhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $callbackUrl: String!
    $appId: ID
  ) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $callbackUrl }
      appId: $appId
    ) {
      webhookSubscription {
        id
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

export const WebhookSubscriptionDeleteMutation = /* GraphQL */ `
  mutation WebhookSubscriptionDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const PRODUCT_REVIEW = /* GraphQL */ `
  fragment ProductReviewFields on ProductReview {
    id
    productId
    productTitle
    orderId
    authorName
    rating
    body
    status
    createdAt
    updatedAt
    publishedAt
  }
`;

/** The shop's products' reviews (MKT-05, ADR-399), the latest first: of a status, a page at a time. */
export const ProductReviewsQuery = /* GraphQL */ `
  query ProductReviews($first: Int, $after: ID, $status: ProductReviewStatus) {
    productReviews(first: $first, after: $after, status: $status) {
      ...ProductReviewFields
    }
  }
  ${PRODUCT_REVIEW}
`;

/** Shows a review on its product's storefront page. */
export const ProductReviewPublishMutation = /* GraphQL */ `
  mutation ProductReviewPublish($id: ID!) {
    productReviewPublish(id: $id) {
      productReview {
        ...ProductReviewFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${PRODUCT_REVIEW}
  ${USER_ERRORS}
`;

/** Keeps a review off the storefront. */
export const ProductReviewHideMutation = /* GraphQL */ `
  mutation ProductReviewHide($id: ID!) {
    productReviewHide(id: $id) {
      productReview {
        ...ProductReviewFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${PRODUCT_REVIEW}
  ${USER_ERRORS}
`;

/** From how many stars reviews publish by themselves, and when customers are asked (ADR-400). */
export const ReviewSettingsQuery = /* GraphQL */ `
  query ReviewSettings {
    reviewSettings {
      publishFrom
      requestAfterDays
    }
  }
`;

export const ReviewSettingsUpdateMutation = /* GraphQL */ `
  mutation ReviewSettingsUpdate($input: ReviewSettingsInput!) {
    reviewSettingsUpdate(input: $input) {
      reviewSettings {
        publishFrom
        requestAfterDays
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/**
 * Puts a product on pre-order, shipping by a day (YYYY-MM-DD), or takes it off with null
 * (CAT-14, ADR-403).
 */
export const ProductPreorderSetMutation = /* GraphQL */ `
  mutation ProductPreorderSet($productId: ID!, $shipsOn: String) {
    productPreorderSet(productId: $productId, shipsOn: $shipsOn) {
      preorder {
        productId
        shipsOn
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/**
 * Makes a product a bundle of other products' variants, a number of each, or no bundle with none
 * (CAT-11, ADR-409).
 */
export const ProductBundleSetMutation = /* GraphQL */ `
  mutation ProductBundleSet($productId: ID!, $components: [ProductBundleComponentInput!]!) {
    productBundleSet(productId: $productId, components: $components) {
      bundle {
        complete
        components {
          productId
          variantId
          productTitle
          variantTitle
          quantity
        }
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/**
 * Pairs a product with others, in order, in place of those it had; none, and it pairs with none
 * (MKT-09, ADR-435).
 */
export const ProductSchedulePublishMutation = /* GraphQL */ `
  mutation ProductSchedulePublish($productId: ID!, $publishAt: DateTime) {
    productSchedulePublish(productId: $productId, publishAt: $publishAt) {
      product {
        id
        status
        publishAt
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

export const ProductComplementsSetMutation = /* GraphQL */ `
  mutation ProductComplementsSet($productId: ID!, $complementIds: [ID!]!) {
    productComplementsSet(productId: $productId, complementIds: $complementIds) {
      complementaryProducts {
        id
        title
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const SIZE_CHART = /* GraphQL */ `
  fragment SizeChartFields on SizeChart {
    id
    name
    unit
    columns
    rows {
      size
      values
    }
    note
    productsCount
  }
`;

/** A sale set ahead (CAT-17, ADR-443). */
const PRICE_SALE = /* GraphQL */ `
  fragment PriceSaleFields on PriceSale {
    id
    name
    percentOff
    status
    startsAt
    endsAt
    endedAt
    productsCount
    products {
      id
      title
    }
  }
`;

export const PriceSalesQuery = /* GraphQL */ `
  query PriceSales {
    priceSales {
      ...PriceSaleFields
    }
  }
  ${PRICE_SALE}
`;

export const PriceSaleCreateMutation = /* GraphQL */ `
  mutation PriceSaleCreate($input: PriceSaleCreateInput!) {
    priceSaleCreate(input: $input) {
      priceSale {
        ...PriceSaleFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${PRICE_SALE}
  ${USER_ERRORS}
`;

export const PriceSaleCancelMutation = /* GraphQL */ `
  mutation PriceSaleCancel($id: ID!) {
    priceSaleCancel(id: $id) {
      priceSale {
        ...PriceSaleFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${PRICE_SALE}
  ${USER_ERRORS}
`;

export const SizeChartsQuery = /* GraphQL */ `
  query SizeCharts {
    sizeCharts {
      ...SizeChartFields
    }
  }
  ${SIZE_CHART}
`;

export const SizeChartQuery = /* GraphQL */ `
  query SizeChart($id: ID!) {
    sizeChart(id: $id) {
      ...SizeChartFields
    }
  }
  ${SIZE_CHART}
`;

export const SizeChartCreateMutation = /* GraphQL */ `
  mutation SizeChartCreate($input: SizeChartInput!) {
    sizeChartCreate(input: $input) {
      sizeChart {
        ...SizeChartFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${SIZE_CHART}
  ${USER_ERRORS}
`;

export const SizeChartUpdateMutation = /* GraphQL */ `
  mutation SizeChartUpdate($id: ID!, $input: SizeChartInput!) {
    sizeChartUpdate(id: $id, input: $input) {
      sizeChart {
        ...SizeChartFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${SIZE_CHART}
  ${USER_ERRORS}
`;

export const SizeChartDeleteMutation = /* GraphQL */ `
  mutation SizeChartDelete($id: ID!) {
    sizeChartDelete(id: $id) {
      deletedSizeChartId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/**
 * Gives products a size chart in place of any they had, or takes theirs away with a null chart:
 * those named, and those a collection has now.
 */
export const ProductsSizeChartSetMutation = /* GraphQL */ `
  mutation ProductsSizeChartSet($sizeChartId: ID, $productIds: [ID!], $collectionId: ID) {
    productsSizeChartSet(
      sizeChartId: $sizeChartId
      productIds: $productIds
      collectionId: $collectionId
    ) {
      productIds
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const STORE_EXPORT = /* GraphQL */ `
  fragment StoreExport on StoreExport {
    id
    status
    size
    error
    createdAt
    finishedAt
    expiresAt
    url
  }
`;

/** The whole store's exports (ADM-10, ADR-415): the owner's alone. */
export const StoreExportsQuery = /* GraphQL */ `
  query StoreExports {
    storeExports {
      ...StoreExport
    }
  }
  ${STORE_EXPORT}
`;

export const StoreExportCreateMutation = /* GraphQL */ `
  mutation StoreExportCreate {
    storeExportCreate {
      storeExport {
        ...StoreExport
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${STORE_EXPORT}
  ${USER_ERRORS}
`;

const WHATSAPP_ACCOUNT = /* GraphQL */ `
  fragment WhatsAppAccountFields on WhatsAppAccount {
    businessAccountId
    phoneNumberId
    displayPhoneNumber
    verifiedName
    qualityRating
    connectedAt
  }
`;

/**
 * The shop's own WhatsApp number (ADR-419), what Meta's Embedded Signup starts with where this
 * server is set up for it, and how far Meta has come with Hatti's order templates on it (ADR-537).
 */
export const WhatsAppAccountQuery = /* GraphQL */ `
  query WhatsAppAccount {
    whatsAppAccount {
      ...WhatsAppAccountFields
    }
    whatsAppSignup {
      appId
      configurationId
      graphVersion
    }
    whatsAppOrderTemplates {
      total
      approved
      pending
      refused
      triedAt
    }
  }
  ${WHATSAPP_ACCOUNT}
`;

/** The number the shop chose in Meta's Embedded Signup, connected with the code it gave. */
export const WhatsAppAccountConnectMutation = /* GraphQL */ `
  mutation WhatsAppAccountConnect($input: WhatsAppAccountConnectInput!) {
    whatsAppAccountConnect(input: $input) {
      whatsAppAccount {
        ...WhatsAppAccountFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${WHATSAPP_ACCOUNT}
  ${USER_ERRORS}
`;

export const WhatsAppAccountDisconnectMutation = /* GraphQL */ `
  mutation WhatsAppAccountDisconnect {
    whatsAppAccountDisconnect {
      disconnectedPhoneNumber
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const WHATSAPP_TEMPLATE = /* GraphQL */ `
  fragment WhatsAppTemplateFields on WhatsAppTemplate {
    id
    name
    language
    header
    body
    footer
    buttonText
    buttonUrl
    status
    rejectedReason
    createdAt
    updatedAt
  }
`;

/** The marketing templates of the number the shop has connected (ADR-420), the latest first. */
export const WhatsAppTemplatesQuery = /* GraphQL */ `
  query WhatsAppTemplates {
    whatsAppTemplates {
      ...WhatsAppTemplateFields
    }
  }
  ${WHATSAPP_TEMPLATE}
`;

const MARKETING_AUTOMATION = /* GraphQL */ `
  fragment AutomationFields on MarketingAutomation {
    kind
    enabled
    afterDays
    creditAmount {
      amount
      currencyCode
    }
    cashbackPercent
    creditDays
    updatedAt
    template {
      id
      name
      language
      status
    }
  }
`;

/** The shop's automations (MKT-04, ADR-425), and its templates to choose from. */
export const MarketingAutomationsQuery = /* GraphQL */ `
  query MarketingAutomations {
    marketingAutomations {
      ...AutomationFields
    }
    whatsAppTemplates {
      id
      name
      language
      status
    }
  }
  ${MARKETING_AUTOMATION}
`;

/** One of the shop's automations turned on or off, its template or its days changed. */
export const MarketingAutomationUpdateMutation = /* GraphQL */ `
  mutation MarketingAutomationUpdate(
    $kind: MarketingAutomationKind!
    $input: MarketingAutomationInput!
  ) {
    marketingAutomationUpdate(kind: $kind, input: $input) {
      marketingAutomation {
        ...AutomationFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${MARKETING_AUTOMATION}
  ${USER_ERRORS}
`;

/** A template written, sent to Meta to approve. */
export const WhatsAppTemplateCreateMutation = /* GraphQL */ `
  mutation WhatsAppTemplateCreate($input: WhatsAppTemplateInput!) {
    whatsAppTemplateCreate(input: $input) {
      whatsAppTemplate {
        ...WhatsAppTemplateFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${WHATSAPP_TEMPLATE}
  ${USER_ERRORS}
`;

export const WhatsAppTemplateDeleteMutation = /* GraphQL */ `
  mutation WhatsAppTemplateDelete($id: ID!) {
    whatsAppTemplateDelete(id: $id) {
      deletedWhatsAppTemplateId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** Meta asked again what it made of each template. */
export const WhatsAppTemplatesSyncMutation = /* GraphQL */ `
  mutation WhatsAppTemplatesSync {
    whatsAppTemplatesSync {
      whatsAppTemplates {
        ...WhatsAppTemplateFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${WHATSAPP_TEMPLATE}
  ${USER_ERRORS}
`;

const BROADCAST = /* GraphQL */ `
  fragment BroadcastFields on Broadcast {
    id
    name
    channel
    text
    templateId
    templateName
    templateLanguage
    templateBody
    segmentId
    segmentName
    sendAt
    status
    error
    recipients
    counts {
      pending
      sent
      delivered
      read
      failed
      skipped
    }
    startedAt
    finishedAt
    createdAt
  }
`;

/** The shop's broadcasts (ADR-421), the latest first, a page at a time. */
export const BroadcastsQuery = /* GraphQL */ `
  query Broadcasts($first: Int, $after: String) {
    broadcasts(first: $first, after: $after) {
      nodes {
        ...BroadcastFields
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
  ${BROADCAST}
`;

/**
 * Who a broadcast to a segment, or to everyone, would reach now, and what it would cost: by SMS,
 * by the parts its words go in (ADR-458).
 */
export const BroadcastEstimateQuery = /* GraphQL */ `
  query BroadcastEstimate(
    $segmentId: ID
    $channel: BroadcastChannel
    $text: String
    $language: MessageLanguage
  ) {
    broadcastEstimate(segmentId: $segmentId, channel: $channel, text: $text, language: $language) {
      recipients
      partsPerMessage
      pricePerMessage {
        amount
        currencyCode
      }
      cost {
        amount
        currencyCode
      }
    }
  }
`;

export const BroadcastCreateMutation = /* GraphQL */ `
  mutation BroadcastCreate($input: BroadcastInput!) {
    broadcastCreate(input: $input) {
      broadcast {
        ...BroadcastFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${BROADCAST}
  ${USER_ERRORS}
`;

export const BroadcastCancelMutation = /* GraphQL */ `
  mutation BroadcastCancel($id: ID!) {
    broadcastCancel(id: $id) {
      broadcast {
        ...BroadcastFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${BROADCAST}
  ${USER_ERRORS}
`;

/** A gift card as the admin lists it: its code's end, never the code (CAT-12, ADR-448). */
const GIFT_CARD = /* GraphQL */ `
  fragment GiftCardFields on GiftCard {
    id
    lastCharacters
    initialValue {
      amount
    }
    balance {
      amount
    }
    expiresOn
    expired
    enabled
    note
    createdAt
  }
`;

export const GiftCardsQuery = /* GraphQL */ `
  query GiftCards($query: String) {
    giftCards(first: 50, query: $query) {
      nodes {
        ...GiftCardFields
      }
    }
  }
  ${GIFT_CARD}
`;

export const GiftCardCreateMutation = /* GraphQL */ `
  mutation GiftCardCreate($input: GiftCardCreateInput!) {
    giftCardCreate(input: $input) {
      giftCard {
        ...GiftCardFields
      }
      giftCardCode
      userErrors {
        ...Problems
      }
    }
  }
  ${GIFT_CARD}
  ${USER_ERRORS}
`;

export const GiftCardCreditMutation = /* GraphQL */ `
  mutation GiftCardCredit($id: ID!, $input: GiftCardCreditInput!) {
    giftCardCredit(id: $id, creditInput: $input) {
      giftCard {
        ...GiftCardFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${GIFT_CARD}
  ${USER_ERRORS}
`;

export const GiftCardDebitMutation = /* GraphQL */ `
  mutation GiftCardDebit($id: ID!, $input: GiftCardDebitInput!) {
    giftCardDebit(id: $id, debitInput: $input) {
      giftCard {
        ...GiftCardFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${GIFT_CARD}
  ${USER_ERRORS}
`;

export const GiftCardDeactivateMutation = /* GraphQL */ `
  mutation GiftCardDeactivate($id: ID!) {
    giftCardDeactivate(id: $id) {
      giftCard {
        ...GiftCardFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${GIFT_CARD}
  ${USER_ERRORS}
`;

/** What is wrong at Hatti now, or planned within a day, for the banner above every page (ADR-499). */
export const PlatformStatusQuery = /* GraphQL */ `
  query PlatformStatus {
    platformStatus {
      statusPageUrl
      incidents {
        id
        kind
        impact
        status
        components
        title
        titleUr
        startsAt
        endsAt
        latestUpdate {
          status
          body
          bodyUr
          postedAt
        }
      }
    }
  }
`;

const STORE_BUILD_PLAN = /* GraphQL */ `
  fragment StoreBuildPlanParts on StoreBuildPlan {
    kit
    accentColour
    aboutHtml
    seoTitle
    seoDescription
  }
`;

/** What the store builder would make of a description (ONB-03), changing nothing. */
export const StoreBuildPlanQuery = /* GraphQL */ `
  query StoreBuildPlan($description: String!) {
    storeBuildPlan(description: $description) {
      ...StoreBuildPlanParts
    }
  }
  ${STORE_BUILD_PLAN}
`;

/** The shop set up from its description (ONB-03, ADR-502). */
export const StoreBuildMutation = /* GraphQL */ `
  mutation StoreBuild($input: StoreBuildInput!) {
    storeBuild(input: $input) {
      plan {
        ...StoreBuildPlanParts
      }
      collectionsMade
      sizeChartsMade
      menuLinksAdded
      accentSet
      seoSet
      aboutPage {
        id
        handle
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${STORE_BUILD_PLAN}
  ${USER_ERRORS}
`;

/** Push notifications for staff (APP-03, ADR-506): Hatti's key and this browser's subscription. */
export const PushNotificationsQuery = /* GraphQL */ `
  query PushNotifications($endpoint: String) {
    pushNotifications(endpoint: $endpoint) {
      publicKey
      subscription {
        endpoint
        kinds
      }
    }
  }
`;

export const PushSubscribeMutation = /* GraphQL */ `
  mutation PushSubscribe($input: PushSubscribeInput!) {
    pushSubscribe(input: $input) {
      subscription {
        endpoint
        kinds
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

export const PushUnsubscribeMutation = /* GraphQL */ `
  mutation PushUnsubscribe($endpoint: String!) {
    pushUnsubscribe(endpoint: $endpoint) {
      unsubscribed
    }
  }
`;

const SUPPORT_REQUEST = /* GraphQL */ `
  fragment SupportRequestFields on SupportRequest {
    id
    channel
    topic
    message
    callBack
    status
    answer
    answeredBy
    answeredAt
    createdAt
    messages {
      id
      direction
      body
      mediaKind
      at
      status
      error
    }
  }
`;

/** Hatti's support for the shop (BIL-05, ADR-508): how to reach Hatti's people, and its requests. */
export const HattiSupportQuery = /* GraphQL */ `
  query HattiSupport {
    hattiSupport {
      plan
      channel
      answerWithinHours
      whatsapp
      phone
      email
      hours {
        en
        ur
      }
      requests {
        ...SupportRequestFields
      }
    }
  }
  ${SUPPORT_REQUEST}
`;

export const SupportRequestCreateMutation = /* GraphQL */ `
  mutation SupportRequestCreate($input: SupportRequestInput!) {
    supportRequestCreate(input: $input) {
      request {
        ...SupportRequestFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${SUPPORT_REQUEST}
  ${USER_ERRORS}
`;

export const SupportRequestCloseMutation = /* GraphQL */ `
  mutation SupportRequestClose($id: ID!) {
    supportRequestClose(id: $id) {
      request {
        ...SupportRequestFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${SUPPORT_REQUEST}
  ${USER_ERRORS}
`;

const CONVERSATION_MESSAGE = /* GraphQL */ `
  fragment ConversationMessageFields on ConversationMessage {
    id
    direction
    body
    mediaKind
    at
    status
    error
  }
`;

const CONVERSATION = /* GraphQL */ `
  fragment ConversationFields on Conversation {
    id
    customerPhone
    viaOwnNumber
    status
    unread
    lastMessageAt
    lastInboundAt
    replyableUntil
    lastMessage {
      ...ConversationMessageFields
    }
    createdAt
  }
  ${CONVERSATION_MESSAGE}
`;

/**
 * The shop's WhatsApp conversations (MSG-05, ADR-545), the latest written first, and how many have
 * messages unread.
 */
const CONTACT_MESSAGE = /* GraphQL */ `
  fragment ContactMessageFields on ContactMessage {
    id
    name
    email
    phone
    body
    fields {
      name
      value
    }
    page
    language
    receivedAt
    readAt
  }
`;

export const ConversationsQuery = /* GraphQL */ `
  query Conversations($first: Int, $after: String, $unread: Boolean, $status: ConversationStatus) {
    conversations(first: $first, after: $after, unread: $unread, status: $status) {
      nodes {
        ...ConversationFields
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
    conversationsUnreadCount
  }
  ${CONVERSATION}
`;

/** What shoppers wrote through the online store's contact form, the latest first (ADR-590). */
export const ContactMessagesQuery = /* GraphQL */ `
  query ContactMessages($first: Int, $after: String, $unread: Boolean) {
    contactMessages(first: $first, after: $after, unread: $unread) {
      nodes {
        ...ContactMessageFields
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
    contactMessagesUnreadCount
  }
  ${CONTACT_MESSAGE}
`;

export const ContactMessageMarkReadMutation = /* GraphQL */ `
  mutation ContactMessageMarkRead($id: ID!, $read: Boolean) {
    contactMessageMarkRead(id: $id, read: $read) {
      contactMessage {
        ...ContactMessageFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${CONTACT_MESSAGE}
  ${USER_ERRORS}
`;

export const ContactMessageDeleteMutation = /* GraphQL */ `
  mutation ContactMessageDelete($id: ID!) {
    contactMessageDelete(id: $id) {
      deletedContactMessageId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

export const ConversationQuery = /* GraphQL */ `
  query Conversation($id: ID!) {
    conversation(id: $id) {
      ...ConversationFields
    }
  }
  ${CONVERSATION}
`;

/** A conversation's messages, the latest first: those before `before`, a page at a time. */
export const ConversationMessagesQuery = /* GraphQL */ `
  query ConversationMessages($conversationId: ID!, $first: Int, $before: ID) {
    conversationMessages(conversationId: $conversationId, first: $first, before: $before) {
      nodes {
        ...ConversationMessageFields
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
  ${CONVERSATION_MESSAGE}
`;

export const ConversationMarkReadMutation = /* GraphQL */ `
  mutation ConversationMarkRead($id: ID!) {
    conversationMarkRead(id: $id) {
      conversation {
        ...ConversationFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${CONVERSATION}
  ${USER_ERRORS}
`;

/** A conversation closed, and read, or opened again. */
export const ConversationUpdateStatusMutation = /* GraphQL */ `
  mutation ConversationUpdateStatus($id: ID!, $status: ConversationStatus!) {
    conversationUpdateStatus(id: $id, status: $status) {
      conversation {
        ...ConversationFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${CONVERSATION}
  ${USER_ERRORS}
`;

/** The shop's answer in its own words, within the day WhatsApp allows (ADR-546). */
export const ConversationReplyMutation = /* GraphQL */ `
  mutation ConversationReply($id: ID!, $body: String!) {
    conversationReply(id: $id, body: $body) {
      conversation {
        ...ConversationFields
      }
      message {
        ...ConversationMessageFields
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${CONVERSATION}
  ${USER_ERRORS}
`;

/** What the shop spent on its ads from one day to another, both included, the latest first (ADR-553). */
export const AdSpendEntriesQuery = /* GraphQL */ `
  query AdSpendEntries($from: String!, $to: String!) {
    adSpendEntries(from: $from, to: $to) {
      platform
      day
      campaign
      amount {
        ...Money
      }
      source
    }
  }
  ${MONEY}
`;

/** Days of ad spend recorded, each in place of what its day had; an amount of 0 takes it away. */
export const AdSpendSetMutation = /* GraphQL */ `
  mutation AdSpendSet($entries: [AdSpendInput!]!) {
    adSpendSet(entries: $entries) {
      count
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

const META_AD_ACCOUNT = /* GraphQL */ `
  fragment MetaAdAccountParts on MetaAdAccount {
    adAccountId
    name
    currency
    timezone
    accessTokenHint
    lastSyncedAt
    lastError
    updatedAt
  }
`;

/** The shop's Meta ad account, whose spend is pulled every few hours, if it connected one (ADR-564). */
export const MetaAdAccountQuery = /* GraphQL */ `
  query MetaAdAccount {
    metaAdAccount {
      ...MetaAdAccountParts
    }
  }
  ${META_AD_ACCOUNT}
`;

/** The shop's Meta ad account connected, in place of any it had, or given another token. */
export const MetaAdAccountConnectMutation = /* GraphQL */ `
  mutation MetaAdAccountConnect($input: MetaAdAccountConnectInput!) {
    metaAdAccountConnect(input: $input) {
      metaAdAccount {
        ...MetaAdAccountParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${META_AD_ACCOUNT}
  ${USER_ERRORS}
`;

/** The shop's Meta ad account disconnected: its token forgotten, the spend pulled kept. */
export const MetaAdAccountDisconnectMutation = /* GraphQL */ `
  mutation MetaAdAccountDisconnect {
    metaAdAccountDisconnect {
      deletedAdAccountId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's spend pulled from its Meta ad account now: at most once a minute. */
export const MetaAdSpendSyncMutation = /* GraphQL */ `
  mutation MetaAdSpendSync {
    metaAdSpendSync {
      metaAdAccount {
        ...MetaAdAccountParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${META_AD_ACCOUNT}
  ${USER_ERRORS}
`;

const TIKTOK_AD_ACCOUNT = /* GraphQL */ `
  fragment TikTokAdAccountParts on TikTokAdAccount {
    advertiserId
    name
    currency
    timezone
    accessTokenHint
    lastSyncedAt
    lastError
    updatedAt
  }
`;

/** The shop's TikTok advertiser account, its spend pulled every few hours, if it connected one. */
export const TikTokAdAccountQuery = /* GraphQL */ `
  query TikTokAdAccount {
    tiktokAdAccount {
      ...TikTokAdAccountParts
    }
  }
  ${TIKTOK_AD_ACCOUNT}
`;

/** The shop's TikTok advertiser account connected, in place of any it had, or given a new token. */
export const TikTokAdAccountConnectMutation = /* GraphQL */ `
  mutation TikTokAdAccountConnect($input: TikTokAdAccountConnectInput!) {
    tiktokAdAccountConnect(input: $input) {
      tiktokAdAccount {
        ...TikTokAdAccountParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${TIKTOK_AD_ACCOUNT}
  ${USER_ERRORS}
`;

/** The shop's TikTok advertiser account disconnected: its token forgotten, its spend pulled kept. */
export const TikTokAdAccountDisconnectMutation = /* GraphQL */ `
  mutation TikTokAdAccountDisconnect {
    tiktokAdAccountDisconnect {
      deletedAdvertiserId
      userErrors {
        ...Problems
      }
    }
  }
  ${USER_ERRORS}
`;

/** The shop's spend pulled from its TikTok advertiser account now: at most once a minute. */
export const TikTokAdSpendSyncMutation = /* GraphQL */ `
  mutation TikTokAdSpendSync {
    tiktokAdSpendSync {
      tiktokAdAccount {
        ...TikTokAdAccountParts
      }
      userErrors {
        ...Problems
      }
    }
  }
  ${TIKTOK_AD_ACCOUNT}
  ${USER_ERRORS}
`;

/** Each kind's search engine listings for the online store's SEO tab (OS-09, ADR-606). */
const SEO_LISTED = /* GraphQL */ `
  id
  title
  handle
  seo {
    title
    description
  }
`;

export const SeoProductsQuery = /* GraphQL */ `
  query SeoProducts($first: Int!) {
    shop {
      url
    }
    listed: products(first: $first) {
      nodes {
        ${SEO_LISTED}
        description
        media {
          alt
          mediaContentType
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

export const SeoCollectionsQuery = /* GraphQL */ `
  query SeoCollections($first: Int!) {
    shop {
      url
    }
    listed: collections(first: $first) {
      nodes {
        ${SEO_LISTED}
        description
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

export const SeoPagesQuery = /* GraphQL */ `
  query SeoPages($first: Int!) {
    shop {
      url
    }
    listed: pages(first: $first) {
      nodes {
        ${SEO_LISTED}
        body
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

export const SeoBlogsQuery = /* GraphQL */ `
  query SeoBlogs($first: Int!) {
    shop {
      url
    }
    listed: blogs(first: $first) {
      nodes {
        ${SEO_LISTED}
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

export const SeoArticlesQuery = /* GraphQL */ `
  query SeoArticles($first: Int!) {
    shop {
      url
    }
    listed: articles(first: $first) {
      nodes {
        ${SEO_LISTED}
        body
        summary
        blog {
          handle
        }
        image {
          alt
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;
