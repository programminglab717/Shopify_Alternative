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
      selectedOptions {
        name
        value
      }
      inventoryQuantity
      inventoryItem {
        id
        tracked
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

/** A courier account's load sheet: its parcels waiting for the rider, a page to print. */
export const CourierLoadSheetQuery = /* GraphQL */ `
  query CourierLoadSheet($accountId: ID, $language: DocumentLanguage!) {
    courierLoadSheet(accountId: $accountId, language: $language) {
      title
      html
    }
  }
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
  }
  ${GATEWAY_ACCOUNT}
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

/** The courier lost a parcel on its way back: its items are written off. */
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
