# Getting started

> Set up the monorepo, run the Admin API and the worker, and run the tests.

## Prerequisites

* **Node.js 22.12 or later** (24 recommended; see `.nvmrc`) and **pnpm 10** (`corepack enable`).
* **Docker**, for Postgres and Valkey. Your own Postgres 16+ and Redis/Valkey 7+ also work.
* **Python 3**, only for the feature catalog script.

## First run

```sh
pnpm install
docker compose up -d   # Postgres 17 on :5432, Valkey 8 on :6379
cp .env.example .env
pnpm db:setup          # creates the hatti database and its logins, applies migrations
pnpm seed              # demo shop: products, stock, orders, draft orders, customers, segments, its storefront, an owner and an app token (printed once)
pnpm dev:api           # http://localhost:4000, GraphiQL at /graphiql
pnpm dev:worker        # outbox relay, event consumers that keep storefronts up to date, and sweeps (in a second terminal)
```

`pnpm dev:api` and `pnpm dev:worker` build what they need first (Turborepo caches unchanged
packages), then start the process. Stop with Ctrl+C; both shut down gracefully.

## Try the API

Use the token that `pnpm seed` printed:

```sh
curl -s http://localhost:4000/admin/api/2026-10/graphql \
  -H 'content-type: application/json' \
  -H 'x-hatti-access-token: hat_…' \
  -d '{"query":"{ shop { name } products(first: 5, query: \"kamiz\") { nodes { title } } }"}'
```

`kamiz` finds "Shalwar Qameez": search folds Roman Urdu spellings (see
[conventions](./conventions.md#pakistan-specific-data)). In GraphiQL, set the
`x-hatti-access-token` header, then try:

```graphql
mutation {
  productCreate(
    input: { title: "Chunri Dupatta", status: ACTIVE, variants: [{ price: "1,450" }] }
  ) {
    product { id handle priceRange { minVariantPrice { formatted } } }
    userErrors { field code message }
  }
}
```

The worker logs a `product.created` event a few milliseconds later.

Placing, shipping and refunding orders and adjusting stock also need an `Idempotency-Key` header:
a new value, such as a UUID, for each thing you mean to do, sent again unchanged when you retry,
so a retry after a timeout never does it twice. With curl, add
`-H "Idempotency-Key: $(uuidgen)"`; in GraphiQL, add it to the headers before those mutations.

Options make variants: this creates six, one for each size and colour, then lists the seeded smart
collections with their products.

```graphql
mutation {
  productCreate(
    input: {
      title: "Lawn Kurta"
      options: [{ name: "Size", values: ["S", "M", "L"] }, { name: "Colour", values: ["Maroon", "Teal"] }]
    }
  ) {
    product { id variants { id title } }
    userErrors { field code message }
  }
}

{
  collections(first: 5) {
    nodes { title productsCount ruleSet { rules { column relation condition } } products(first: 5) { nodes { title } } }
  }
}
```

Then set prices with `productVariantsBulkUpdate`, add images with `productCreateMedia`, and group
products with `collectionCreate`.

The seed stocks a Lahore warehouse and a Karachi store, which sells only over the counter, so
its stock does not count online. See what can be sold, and where the stock is:

```graphql
{
  locations(first: 5) { nodes { id name isPrimary fulfillsOnlineOrders address { formatted } } }
  products(first: 5) {
    nodes {
      title totalInventory
      variants {
        title inventoryQuantity availableForSale
        inventoryItem { id tracked inventoryLevels { location { name } available onHand committed } }
      }
    }
  }
}
```

A delivery arrives: add it, with the IDs from that query. Stock counts use
`inventorySetQuantities` instead, and every change shows in `inventoryItem(id) { changes }`.

```graphql
mutation {
  inventoryAdjustQuantities(
    input: {
      name: "available"
      reason: "received"
      referenceDocumentUri: "https://suppliers.example.com/grn/1042"
      changes: [{ inventoryItemId: "invi_…", locationId: "loc_…", delta: 12 }]
    }
  ) {
    inventoryAdjustmentGroup { changes { name delta quantityAfterChange location { name } } }
    userErrors { field code message }
  }
}
```

The seed also places twelve orders at every stage, from waiting for the customer to confirm, or
for a bank transfer, to delivered and paid, and one refused at the door and checked back in. Take an order from a
WhatsApp chat, with the variant IDs from the queries above. Its stock is committed at once;
cash-on-delivery orders wait for confirmation.

```graphql
mutation {
  orderCreate(
    input: {
      lineItems: [{ variantId: "var_…", quantity: 1 }]
      shippingAddress: {
        name: "Ayesha Khan"
        phone: "0300 1234567"
        address1: "House 12, Street 4, Block 5, Gulshan-e-Iqbal"
        address2: "Near Nipa Chowrangi"
        city: "Karachi"
      }
      shippingPrice: "250"
    }
  ) {
    order { id name stage totalPrice { formatted } codAmount { formatted } }
    userErrors { field code message }
  }
}

{
  orderStageCounts { stage count }
  orders(first: 10, query: "0300 1234567") {
    nodes { name stage shippingAddress { formatted } events(first: 5) { nodes { message } } }
  }
}
```

Then `orderConfirm` once the customer confirms, `orderCancel` (which releases the stock),
`orderUpdate` for a new address, and `orderMarkAsPaid` when the cash arrives. A confirmed order
waits under `TO_PACK`; `orderMarkPacked` moves it to `TO_BOOK`, ready for a courier.

Booking it needs a courier account. PostEx's takes the API token its merchant portal gives;
locally, the test courier takes any key and books nothing:

```graphql
mutation {
  courierAccountConnect(
    input: { courier: "test", credentials: [{ key: "key", value: "local-0001" }] }
  ) {
    courierAccount { id name credentialsHint isDefault }
    userErrors { field code message }
  }
}
```

Then `ordersBook(ids: ["ord_…"])` books orders with the shop's default account, each on its own,
and says why it refused any. Within half a minute the worker books each with the courier and
ships it with the courier's tracking number (`HT…` from the test courier); `courierBookings`
shows how each went. The worker opens accounts' credentials with `ENCRYPTION_KEYS`, as
`.env.example` sets it.

Once booked, `courierLabels(ids: ["bkg_…"])` gives the labels as an HTML page to print, 4×6 inch
by default or `paper: A4` for four to a sheet, and `courierLoadSheet` the default account's
sheet of parcels waiting for pickup:

```graphql
query {
  courierLabels(ids: ["bkg_…"], paper: A4) { title fileName html }
}
```

Money given back is recorded with `orderRefund`, once it has been sent: up to what was paid, by
bank transfer, mobile wallet, cash or another way. Owners and managers can refund; other staff
cannot. The seed's completed order from Peshawar has its delivery charge refunded. What was paid
online goes back through the gateway that took it, by `method: ONLINE` without a reference:
locally the test gateway gives any part back at once, and `paymentSessions` shows each payment's
refunds; Safepay gives a payment back whole.

```graphql
mutation {
  orderRefund(
    id: "ord_…"
    input: { amount: "300", method: MOBILE_WALLET, reference: "JC-7781204", note: "Late" }
  ) {
    refund { id amount { formatted } }
    order { financialStatus amountPaid { formatted } amountRefunded { formatted } }
    userErrors { field code message }
  }
}
```

A morning's orders are handled in bulk: confirm, cancel, pack, tag or untag up to 250 at once.
Each order changes on its own, so one that can't (here, a cancelled one) is a user error pointing
at its place in `ids`, and the rest go ahead:

```graphql
mutation {
  orderBulkConfirm(ids: ["ord_…", "ord_…", "ord_…"]) {
    orders { name stage }
    userErrors { field code message }
  }
  orderBulkAddTags(ids: ["ord_…", "ord_…"], tags: ["eid-sale"]) {
    orders { name tags }
    userErrors { field code message }
  }
}
```

Print packing slips or invoices for up to 250 orders. `orderDocument` returns one HTML page with
each order on a sheet of its own, for A4, 4×6 inch thermal labels (`THERMAL_4X6`) or an 80 mm
roll (`THERMAL_80MM`), in English and Urdu unless you ask for `ENGLISH` or `URDU`. Save it and
open it in a browser to print, for example with `jq`:

```bash
curl -s http://localhost:4000/admin/api/2026-10/graphql \
  -H 'content-type: application/json' -H 'x-hatti-access-token: hat_…' \
  -d '{"query":"{ orderDocument(ids: [\"ord_…\"], kind: PACKING_SLIP) { html } }"}' \
  | jq -r .data.orderDocument.html > packing-slips.html
```

Export orders for a spreadsheet with `ordersExport`: a row per order, or per line item with
`layout: LINE_ITEMS`, filtered as the order list is, such as by the dates they were placed:

```bash
curl -s http://localhost:4000/admin/api/2026-10/graphql \
  -H 'content-type: application/json' -H 'x-hatti-access-token: hat_…' \
  -d '{"query":"mutation { ordersExport(placedFrom: \"2026-09-01T00:00:00+05:00\") { csv rowCount } }"}' \
  | jq -r .data.ordersExport.csv > orders.csv
```

Take an order from a chat as a draft: its items at the prices agreed, and the address once the
customer sends it (`draftOrderUpdate`). Then either place it yourself with `draftOrderComplete`,
or send the customer a link where they see the order and confirm it, which places it, already
confirmed. The link can go before the address: its page asks the customer for their address and
number, and lets them correct the address later:

```graphql
mutation {
  draftOrderCreate(
    input: {
      source: WHATSAPP
      lineItems: [{ variantId: "var_…", quantity: 1, price: "3,200" }]
      shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567", address1: "House 12", city: "khi" }
      shippingPrice: "250"
    }
  ) {
    draftOrder { id name totalPrice { formatted } }
    userErrors { field code message }
  }
}

mutation {
  draftOrderLinkCreate(id: "dft_…") {
    url whatsappUrl draftOrder { linkExpiresAt }
    userErrors { field code message }
  }
}
```

An order placed another way gets a link too. While a cash-on-delivery order waits for its
customer, the page lets them confirm it or cancel it; after that it shows where the order is,
with the courier's tracking number once it ships. Until the order is packed, the customer can
correct its address there too (all of it but the number):

```graphql
mutation {
  orderLinkCreate(id: "ord_…") {
    url whatsappUrl order { linkExpiresAt }
    userErrors { field code message }
  }
}
```

The seed prints three links waiting for their customers: a draft's to confirm, a draft's without
an address, and an order's. Open them in a browser as the customer would. Links point at `PUBLIC_URL`, which is
`http://localhost:4000` unless you set it; to open one on a phone, set it to your computer's
address on the network, such as `http://192.168.1.20:4000`, before seeding.

Ship a confirmed order: everything left to ship goes in one parcel unless you list lines. Then
follow the parcel with `fulfillmentMarkDelivered`, or `fulfillmentMarkReturning` when the customer
refuses it, and `fulfillmentReceiveReturn` when it is back, saying what goes back on the shelf.

```graphql
mutation {
  orderFulfill(id: "ord_…", input: { trackingInfo: { company: "TCS", number: "779012345678" } }) {
    fulfillment { id status }
    order { stage fulfillmentStatus lineItems { fulfilledQuantity } }
    userErrors { field code message }
  }
}
```

Every order belongs to the customer with its mobile number, created by their first order. A
customer's profile shows their orders, what they paid and how their deliveries went, which is
what to check before calling about a cash-on-delivery order:

```graphql
{
  customers(first: 10, query: "0300 1234567") {
    nodes {
      displayName phone numberOfOrders amountSpent { formatted }
      deliveryHistory { delivered returned cancelled inProgress }
      addresses { formatted }
      orders(first: 5) { nodes { name stage } }
      blocklistEntry { reason note }
    }
  }
}
```

Block a number that places fake orders or refuses parcels. Its new orders wait under the
`NEEDS_REVIEW` stage, with the reason on their timeline, until `orderConfirm` lets one go ahead.
The seed blocks two numbers, and one of them has an order waiting.

```graphql
mutation {
  blocklistAdd(
    input: { phone: "0311 2223344", reason: REFUSED_DELIVERIES, note: "Refused two parcels" }
  ) {
    blocklistEntry { id phone reason customer { displayName } }
    userErrors { field code message }
  }
}
```

`blocklistRemove(phone:)` takes a number off, and `customerCreate` and `customerUpdate` manage
profiles.

Cash-on-delivery orders are scored for how likely they are to come back unpaid, with the reasons.
Orders at the shop's threshold or above wait for review too. The seed's last order is one: a large
order from the customer who refused a parcel, to a vaguer address.

```graphql
{
  orders(first: 5, riskLevel: HIGH) {
    nodes { name stage risk { score level reasons { message weight } } }
  }
  orderRiskSettings { holdAt highValue { formatted } }
}

mutation {
  orderRiskSettingsUpdate(input: { holdAt: 0.5, highValue: "20,000" }) {
    riskSettings { holdAt highValue { formatted } }
    userErrors { field code message }
  }
}
```

The policy needs `read_settings` or `write_settings`, which owners and managers have, and so does
the seed's app token.

A customer can have more than one number. The seed's last order came from a customer's second
SIM, and was merged into her profile, so searching by either number finds her. Merge two
customers, or erase one at their request once their orders are closed or cancelled:

```graphql
mutation {
  customerMerge(customerId: "cus_…", duplicateId: "cus_…") {
    customer { displayName phone otherPhones numberOfOrders }
    userErrors { field code message }
  }
}

mutation {
  customerErase(id: "cus_…") {
    erasedCustomerId
    userErrors { field code message }
  }
}
```

An erased customer's orders keep their items, amounts and city, with `customerErasedAt` set and
no name, number, email or street.

Staff other than owners and managers see customers' numbers masked, "0300 ••••567". A
confirmation agent reveals one before calling, and owners and managers see who did in the shop's
audit log, with exports, merges and erasures:

```graphql
mutation {
  orderPhoneReveal(id: "ord_…") { phone userErrors { field code message } }
}

{
  auditLog(first: 10) {
    nodes { action subjectId actor { kind id role } details occurredAt }
  }
}
```

Record what a customer agreed to, per channel. Every change goes into their consent history, with
the wording and where they said so:

```graphql
mutation {
  customerMarketingConsentUpdate(
    id: "cus_…"
    marketingConsent: [
      { channel: WHATSAPP, marketingState: SUBSCRIBED, wording: "Send me offers on WhatsApp" }
      { channel: SMS, marketingState: UNSUBSCRIBED }
    ]
  ) {
    customer {
      whatsappMarketingConsent { marketingState consentUpdatedAt }
      consentHistory(first: 5) { nodes { channel marketingState source wording collectedAt } }
    }
    userErrors { field code message }
  }
}
```

Bring customers in from Shopify's customer export, or any spreadsheet with a Phone column, and
take them out again as CSV:

```graphql
mutation ($csv: String!) {
  customersImport(csv: $csv, dryRun: true) {
    created skipped rowErrorCount
    rowErrors { row column message }
    userErrors { field code message }
  }
}

mutation {
  customersExport(query: "whatsapp_subscription_status = subscribed") {
    csv rowCount userErrors { field code message }
  }
}
```

Segments filter customers by what they ordered and who they are. Try a query first, then save it;
the seed saves four. `segmentFilters` lists the fields.

```graphql
{
  segmentPreview(query: "number_of_orders >= 1 AND returned_orders = 0 AND city IN (khi, lhr)") {
    memberCount
    members { displayName phone }
  }
}

mutation {
  segmentCreate(name: "Win back", query: "number_of_orders >= 2 AND last_order_date < -60d") {
    segment { id memberCount members(first: 10) { nodes { displayName } } }
    userErrors { field code message }
  }
}
```

Files go straight to storage, as Shopify's staged uploads do: ask where to put one, put its
bytes there, then make it a file. Locally, the API keeps files in `apps/core/.storage` and serves
them at `http://localhost:4000/storage`; in production they are R2's.

```graphql
mutation {
  stagedUploadsCreate(input: [{ filename: "lawn.png", mimeType: "image/png", fileSize: "20480" }]) {
    stagedTargets { url parameters { name value } resourceUrl }
    userErrors { field code message }
  }
}
```

```sh
curl -X PUT -H 'content-type: image/png' --data-binary @lawn.png "<the target's url>"
```

```graphql
mutation {
  fileCreate(files: [{ originalSource: "<the target's resourceUrl>", alt: "Lawn suits" }]) {
    files { id filename fileSize url }
    userErrors { field code message }
  }
}
```

The `fileSize` is the file's in bytes (`wc -c < lawn.png`): the URL takes those bytes of that type
and no others, for an hour. A file's `url` shows it for an hour too; ask `files` for a new one.

An image among them can be the shop's logo, which its checkout's page then shows in place of its
name; `shop { brand { logo { url } } }` shows it, and `logo: null` takes it away:

```graphql
mutation {
  shopBrandUpdate(input: { logo: "<the file's id>" }) {
    brand { logo { id filename } }
    userErrors { field code message }
  }
}
```

The full schema is in [`apps/core/schema.graphql`](../../apps/core/schema.graphql).

## Sign in as the shop owner

The seed also prints an owner account with two-step verification switched on. Owners must use it
(see [conventions](./conventions.md#staff-sign-in)).

```sh
# 1. Email and password give a challenge token
curl -s localhost:4000/auth/sign-in -H 'content-type: application/json' \
  -d '{"email":"owner-…@demo.hatti.test","password":"…"}'

# 2. A code from your authenticator app, or from `pnpm totp <2-step key>`
curl -s localhost:4000/auth/sign-in/verify -H 'content-type: application/json' \
  -d '{"challengeToken":"hmc_…","code":"123456"}'

# 3. The access token and the shop id call the Admin API
curl -s localhost:4000/admin/api/2026-10/graphql -H 'content-type: application/json' \
  -H 'authorization: Bearer hsa_…' -H 'x-hatti-shop-id: shop_…' \
  -d '{"query":"{ shop { name } }"}'
```

Access tokens last 15 minutes; `POST /auth/refresh` with `{"refreshToken":"hsr_…"}` gives new
ones.

What the shop pays Hatti is its owner's to choose (ADR-154). The seed's shop is on Pro for a
month, with Rs 1,000 of credit for its messages (ADR-155); a shop of your own starts on Free,
which has room for its owner alone and one location, with no credit, so its customers' messages
wait in the worker until it has some.
`billingPlans` lists the plans; `billingPlanChange` with `{ plan: GROWTH, interval: MONTHLY }`
gives an invoice, and `billingInvoicePay` its `checkoutUrl`: locally the test gateway takes
nothing, and opening the address in a browser comes straight back to the invoice's page on the
API, paid, the shop on Growth for a month (`billingSubscription`). Credit for its messages is
bought the same way: `billingCreditsBuy` with `{ amount: "1000" }`, then `billingInvoicePay`;
`billingWallet` says what it holds, `billingWalletEntries` what each message took, and
`billingMessagePrices` what each costs.

A shop of your own, as a merchant opens one (ADR-145): sign up, then open it with the access
token. Its storefront answers at `http://<handle>.localhost:4100` once the worker has published
it; using its Admin API as its owner takes two-step verification first, as above.

```sh
curl -s localhost:4000/auth/sign-up -H 'content-type: application/json' \
  -d '{"email":"sana@example.pk","password":"a long passphrase","name":"Sana"}'
curl -s localhost:4000/auth/shops -H 'content-type: application/json' \
  -H 'authorization: Bearer hsa_…' -d '{"name":"Sana Lawn"}'
```

## See traces and metrics

```sh
docker compose --profile observability up -d   # Grafana with Tempo, Prometheus, Loki
```

Uncomment `OTEL_EXPORTER_OTLP_ENDPOINT` in `.env`, restart `pnpm dev:api` and `pnpm dev:worker`, and
make a few requests. In Grafana (http://localhost:3000, admin / admin), open **Explore → Tempo** to
see a `productCreate` request run from the API through Postgres, then the `process
product.created` span in the worker, all in one trace. The metrics are listed in the
[conventions](./conventions.md#observability).

## Run through PgBouncer, as in production

Production reaches Postgres through PgBouncer in transaction mode, and CI runs every database
test that way. To do the same locally, install PgBouncer (`apt install pgbouncer` or
`brew install pgbouncer`; 1.21 or later, which carries prepared statements; tested with 1.22). If
the package started its own service on port 6432, stop it. Then start ours from the repository
root, and restart it whenever its configuration changes:

```sh
pgbouncer db/pgbouncer/pgbouncer.ini      # port 6432, in front of Postgres on 5432
DATABASE_POOLER_URL=postgres://127.0.0.1:6432 pnpm test
```

To run the API and worker through it, use port 6432 in `DATABASE_URL`, `DATABASE_SYSTEM_URL` and
`DATABASE_IDENTITY_URL`. Then set `DATABASE_LISTEN_URL` to the direct system URL on 5432, because
the relay's `LISTEN` needs a direct connection. The rules for code are in
[conventions](./conventions.md#connection-pooling).

## Benchmark the database

`pnpm bench:db` measures row-level security and PgBouncer on the products listing (spike 5,
[results](./spikes/05-rls-and-pooling.md)), times orders, customers and carts, and checks the
statements the application prepares. It needs `pgbench`, which comes with the Postgres client
tools, and PgBouncer for the pooled runs.

```sh
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres
export BENCH_POOLER_URL=postgres://127.0.0.1:6432
pnpm bench:db seed      # database hatti_bench: 1,000 shops, 460k products, 720k orders (two minutes)
pnpm bench:db explain   # query plans with and without row-level security (a minute)
pnpm bench:db prepared  # prepared statements' generic plans against every shop size (a minute)
pnpm bench:db all       # plans, pgbench, the application code, leak checks (about 20 minutes)
```

`BENCH_SCALE=smoke` loads a tiny dataset and runs for seconds, to check the tool itself.

## Look at a storefront

The storefront serves shops in Hatti Base, the reference theme, each at its handle's subdomain.
At `localhost` itself it serves spike 1's sample shop of 201 products from memory
([results](./spikes/01-liquid-rendering.md)), with no database needed:

```sh
pnpm dev:storefront     # http://localhost:4100/, and /ur/ for Urdu
pnpm bench:storefront   # render times, round trips, throughput and limits (a minute)
```

`pnpm seed` publishes its shop's storefront to Valkey and prints its address, such as
`http://hatti-demo-bazaar-3f9a.localhost:4100/`. Browsers and curl send `*.localhost` to your
machine, so nothing needs setting up. Its collections and products are its own, and so are its
main menu, home page, announcement, WhatsApp number, delivery charges and pages (About us,
Delivery, Returns and exchanges, Contact us, which its footer links to): the seed saves the
menus, the number, the charges and the pages through the modules' services, and the rest in the
shop's theme, over Hatti Base's. With `pnpm dev:worker` running, a change to the shop's catalog,
stock, menus, pages or theme through the API (`menuUpdate`, `pageUpdate` or `themeFilesUpsert`,
say) shows on its storefront a fraction of a second later.

With `pnpm dev:api` running too, the seeded shop takes carts and orders: add a product from its
page, and the cart, which the API keeps, opens in a drawer over it, as `/cart` shows it too. Its
**Check out** button opens the checkout on the shop's address (`/checkouts/…`), where a name, a mobile number such as
`0300 1234567` and an address in a city such as "lhr" place a cash-on-delivery order: it shows
in the Admin API's `orders`, waiting to be confirmed, and the cart is empty again. The seed gives
the shop a bank account too, so the page offers bank transfer: chosen, the thank-you page shows
the account, with its Raast ID beside the IBAN, the amount and the order's number to give as the
reference, and the order waits
under `AWAITING_PAYMENT` until `orderMarkAsPaid`. Its page (`orderLinkCreate` makes a link to it)
takes the receipt of the transfer meanwhile, a photo, a screenshot or a PDF, which the order then
shows as its `transferReceipts`, each with a URL that opens it for an hour; locally the API keeps
them in `apps/core/.storage`. The `home` counts such orders as `transfersToCheck`, and
`orders(stage: AWAITING_PAYMENT, hasTransferReceipt: true)` lists them. A cash-on-delivery
order can ask for an advance the same way (`orderCreate` with `advanceDue: "500"`): it waits under
`AWAITING_PAYMENT` too, its link says what to transfer ahead and what to pay at the door, and
`orderCreateManualPayment` records the advance once it is in. A draft asks for one with
`draftOrderCreate`'s `advanceDue`: its link says so, and once confirmed takes the receipt.
Such an order's page offers to take what it waits for online too, once the shop connects a
payment gateway account. Locally the test gateway takes any secret and nothing from anyone: its
"page" sends the customer straight back as if they had paid, so **Pay online** on the order's
page comes back thanking them, and the order moves to `TO_PACK`, paid:

```graphql
mutation {
  paymentGatewayAccountConnect(
    input: { gateway: "test", credentials: [{ key: "secret", value: "local-0001" }] }
  ) {
    paymentGatewayAccount { id gatewayName environment webhookUrl }
    userErrors { field code message }
  }
}
```

A shop's own Safepay account takes its API key, secret key and webhook secret from Safepay's
dashboard, with `environment: SANDBOX` to try it with Safepay's test cards, which pay nothing on
the order; add the account's `webhookUrl` in Safepay's dashboard so that payments are recorded
even when customers do not come back. `paymentSessions(orderId: "ord_…")` shows each payment an
order's customer started, and how it went. Staff connect accounts having signed in within 15
minutes; apps with `write_settings` may at any time. With an account connected, the checkout
offers **Pay online, by card or wallet** too: chosen, the order is placed under
`AWAITING_PAYMENT`, its `paymentMethod` `ONLINE`, and the thank-you page's **Pay online** goes to
the gateway. The test gateway sends the shopper straight back to the checkout's address on the
API (`http://localhost:4000/checkouts/…/paid`), whose page thanks them, and the order moves to
`TO_PACK`, paid.
Checkout asks for one by the shop's
rules once `cashOnDeliverySettingsUpdate` names one, such as `advance: { deliveryCharge: true }`
or `advance: { amount: "500", above: "5,000" }`: the page says it beside cash on delivery, and
the thank-you page where to transfer it. The seed takes 5%, up to Rs 500, off orders
paid by transfer, which the page says beside the option and the order keeps as its
`transferDiscount`. `bankTransferSettings` shows the account and the discount, and
`bankTransferSettingsUpdate` changes them or turns transfers off. Under the checkout's button,
the seed's trust badges say cash on delivery, a 7-day exchange, original products and help on
WhatsApp; `checkoutTrustBadgesUpdate` chooses others. Open the storefront through a tagged
link, its address with `?utm_source=instagram&utm_campaign=eid` after it, before checking out,
and the order remembers it: the order's `customerJourneySummary` gives that visit, where it came
from and its UTM parameters, as the browser's `hatti_visits` cookie kept them. Its header's
**Search** finds the shop's products through the API too, however their names are spelt:
`/search?q=kameez` finds the Shalwar Qameez, and `/search?q=khusa` the Multani Khussa. Typing in
the header's search box suggests them as you go: "kame" is enough for the qameez. The
storefront reaches the API at `CORE_API_URL` (`http://localhost:4000` unless set), with
`STOREFRONT_SERVICE_KEY` from `.env`.

To see a theme before publishing it, ask the API for its `previewUrl`, say after
`themeCreate(name: "Winter look", copyFrom: …)` and a `themeFilesUpsert` to the copy: opened in
a browser, every page of the shop shows that theme as saved, with a bar at the foot that names
it and ends the preview, for 14 days or until it is ended. The API and the storefront need the
same `STOREFRONT_SERVICE_KEY`, as for carts.

The theme editor's side of it can be tried before the editor exists: with
`STOREFRONT_EDITOR_ORIGINS=http://editor.localhost:5173` in the storefront's environment, a page
at that origin that frames the `previewUrl` gets it in design mode, and talks to it with the
messages `apps/storefront/src/editor.ts` lists: `{ type: 'hatti:hello' }` after each load, then
`hatti:select`, `hatti:deselect` and `hatti:render` with the files it has not saved. Browsers tell
the storefront a page is framed only over HTTPS and on `localhost`, so use `*.localhost` hosts
for both.

A domain of the shop's own can be tried with `localtest.me`, whose names public DNS resolves to
`127.0.0.1`. Start the API with `STOREFRONT_DNS_TARGET=localtest.me`, so that a name DNS resolves
where `localtest.me` does counts as pointed at the platform, and the worker beside it. Then,
with the seed's token, `domainCreate(domain: { host: "bazaar.localtest.me" })` connects it,
`domainVerify` checks it and `domainUpdate` with `isPrimary: true` makes it primary: the
storefront answers at `http://bazaar.localtest.me:4100/`, the shop's subdomain sends its pages
there, and `shop { url }` names it. `domainDelete` lets it go.

What search engines read is there too: `/robots.txt`, `/sitemap.xml` and the sitemaps it
names, and each page's canonical address and link-preview tags in its head. Rules of the shop's
own go in with `onlineStorePreferencesUpdate(input: { robotsTxtRules: "Disallow: /collections/sale" })`.
So is the catalog feed Google Merchant Center and Meta's catalogs fetch, an item for each variant,
at `/feeds/products.xml`; `shop { productFeedUrl }` gives its address.

Orders going to Meta's conversions API (ADR-143): with the seed's token,
`metaConversionsUpdate(input: { pixelId: "1234567890", accessToken: "…", testEventCode: "TEST12345" })`
connects a dataset. With a real dataset and token from Events Manager, the events show in its Test
events tab. Without one, start the worker with `META_GRAPH_URL` pointing at any local server that
answers `{"events_received": 1}`. Place an order through the storefront's checkout, confirm and
deliver it, and `conversionEvents { nodes { moment status eventName error } }` says how sending each
moment went. Once the worker has published the shop again, its storefront's pages carry the pixel
in `<script data-hatti-pixel>`: Meta Pixel Helper, or requests to `facebook.com/tr` in the
browser's network panel, show `PageView`, `ViewContent` on a product's page, and `AddToCart` as a
product is added. An order placed after that keeps the pixel's `_fbp` and
`_fbc` cookies, which its events send as `fbp` and `fbc` (ADR-144).

Messages to customers about their orders (ADR-146): with the worker running and no WhatsApp number
or SMS gateway set up, each message goes to the worker's log as `not sent: …`, with its words. Place
a cash-on-delivery order through the storefront's checkout: a moment later the log says what
WhatsApp would have sent, the question asking the customer to confirm it, with the order's link
after it (ADR-147). Opening the link confirms it as the customer would, and the log then says it
is confirmed; `messages { nodes { kind channel status recipient } }`, with the seed's token, lists
both as sent. On WhatsApp itself the question has Confirm, Cancel and Change address buttons,
which the webhook hears. Ship it with a tracking number (`orderFulfill`, or `fulfillmentTrackingInfoUpdate` on a
parcel shipped without one) and the customer hears it is on its way; deliver it
(`fulfillmentMarkDelivered`) and they hear it arrived. `messagingSettingsUpdate(input: { routing: ECONOMY, language: UR })` sends those updates
by SMS, in Urdu. To send for real, set `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN` (a
test number from Meta's app dashboard answers on WhatsApp) and `SMS_GATEWAY_URL` and
`SMS_GATEWAY_KEY` for the worker, and give Meta's webhook `{PUBLIC_URL}/webhooks/whatsapp` with
`WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` set on the API; replying "band karo" from the
phone then stops the shop's messages to it.

Codes at checkout (ADR-148): with the seed's token,
`cashOnDeliverySettingsUpdate(input: { verifyFromScore: 0 })` makes checkout ask a code of every
order paid on delivery. Place one through the storefront: the page asks for the code, which the
worker's log shows as it would have gone on WhatsApp. Typing it places the order, whose timeline
says its number was proved; "Send the code by SMS instead" sends another.

A storefront closed behind a password, as a shop is while it gets ready to open: with the seed's
token, `onlineStorePreferencesUpdate(input: { passwordEnabled: true, password: "chand-raat",
passwordMessage: "Opening on Chand Raat" })`, and with the worker running, every page sends
shoppers to `/password` until they give it. `passwordEnabled: false` opens it again.

A redirect from an old address, as a shop moving from Shopify brings: with the seed's token,
`urlRedirectCreate(urlRedirect: { path: "/products/old-lawn", target: "/collections/all" })`,
and with the worker running, `/products/old-lawn` and `/ur/products/old-lawn` answer 301 to the
collection in their language, keeping any query. `urlRedirects` lists them, and
`urlRedirectDelete` lets the path answer 404 again. A shop's Shopify redirects come in one file:
`urlRedirectsImport(csv: "Redirect from,Redirect to\n/products/old-lawn,/collections/all")`,
with `dryRun: true` to check it first, and `urlRedirectsExport { csv }` gives them back. A product renamed with
`productUpdate(input: { id: …, handle: "lawn-2026", redirectNewHandle: true })` sends its old
address to the new one the same way, a moment later, once the worker has written the redirect.

A shop's policies, drafted from what it has set: with the seed's token,
`shopPolicyDraft(type: SHIPPING_POLICY, locale: "ur") { title body }` gives a draft in Urdu, or in
English without `locale`, from the shop's name, WhatsApp number and delivery charges, and saves
nothing. `shopPolicyUpdate(shopPolicy: { type: SHIPPING_POLICY, body: "<p>…</p>" })` keeps one,
and with the worker running the storefront shows it at `/policies/shipping-policy` and
`/ur/policies/shipping-policy`, and Hatti Base's footer links it. A blank body takes it away.

Checkout then links the shop's policies, and says above its button that placing the order agrees
to them. An order placed there keeps what its shopper agreed to, which
`orders(first: 1) { nodes { agreement { agreedAt ip userAgent policies { title body } } } }`
shows with the seed's token: the policies as they were then, whatever they say now.

A shop moving from Shopify brings its catalog in one file: with the seed's token,
`productsImport(csv: "…", dryRun: true) { created variants images skipped rowErrors { row column
message } }` checks Shopify's product export (Products, Export, CSV) and counts what it would
make; without `dryRun` it makes the products, keeping their handles, with their images and the
stock Shopify tracked at the primary location. Products whose handles the shop has are skipped.
The way back is the same file: `{ productsExport(query: "status:active") { csv productCount
rowCount } }` gives the shop's products as Shopify's product CSV, with each tracked variant's
stock, as much as one import takes. Edit it in a spreadsheet and `productsImport(csv: "…",
overwrite: true)` updates the products from it, their variants matched by option values and
their stock left as it is.
Stock has a file of its own, Shopify's inventory CSV: `{ inventoryExport { csv rowCount } }`
gives a row for each tracked variant at each location, with what is on hand now. Fill in On hand
(new) where a count found something else, and `inventoryImport(csv: "…", dryRun: true) { counted
unchanged rowErrors { row column message } }` checks it; without `dryRun` it sets those counts,
and refuses a row whose stock sold since the file was exported.

Edit the theme in `themes/hatti-base` and restart the server to see it. Images under `/images/`
are placeholders drawn to size. `STOREFRONT_URL` (`http://localhost:4100` unless set) is where
storefronts answer, for the seed, the API and the server; `STOREFRONT_PORT` changes the port the
server listens on.

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm check` | Format check, lint, typecheck and tests: what CI runs, apart from the seed step |
| `pnpm build` | Builds every package (cached by Turborepo) |
| `pnpm test` | All tests. Database and queue tests need the URLs below |
| `pnpm --filter @hatti/catalog test` | One package's tests |
| `pnpm db:migrate` | Applies new migrations |
| `pnpm format` | Formats with Prettier |
| `UPDATE_SCHEMA=1 pnpm --filter @hatti/core test` | Accepts GraphQL schema changes into `schema.graphql` |
| `pnpm features:summary` | Refreshes the feature catalog summary table |
| `pnpm totp <key>` | Prints the current authenticator code for a 2-step key |
| `pnpm bench:db <command>` | Database benchmark: see [above](#benchmark-the-database) |

## Tests and databases

Tests use real Postgres and Redis, never mocks. They read `DATABASE_ADMIN_URL` and `REDIS_URL`
from the environment. They do not read `.env`, because Turborepo passes only declared variables.

```sh
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres
export REDIS_URL=redis://localhost:6379
pnpm test
```

* Each test file creates its own database (`hatti_test_<random>`), migrates it and drops it
  afterwards, so test files run in parallel.
* Without the URLs, those tests are **skipped** locally. In CI (when `CI` is set) a missing URL
  **fails** the run, so a misconfigured pipeline can never pass by skipping.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `password authentication failed for user "hatti_app"` | Run `pnpm db:setup` again. It resets the login passwords to the ones in `.env` |
| Port 5432 or 6379 is already in use | Stop the local service, or change the port in `docker-compose.yml` and the URLs in `.env` |
| `Migration 0001_foundation changed after it was applied` | Applied migrations are immutable. Add a new migration. Locally you can also `dropdb hatti` and run `pnpm db:setup` |
| `DATABASE_ADMIN_URL must be set in CI` on your machine | Unset `CI` |
| `INVALID_CODE` just after seeding | Each code works once and the seed used the current one. Wait for the next code (up to 30 seconds) |
| The storefront says your cart cannot be reached | Start `pnpm dev:api`. If your `.env` predates carts, copy `STOREFRONT_SERVICE_KEY` from `.env.example` and restart both |
| `Invalid configuration: DATABASE_IDENTITY_URL` or `ENCRYPTION_KEYS` | Your `.env` predates staff sign-in. Copy the new lines from `.env.example` and run `pnpm db:setup` |
| `Cannot use GraphQLEnumType … from another module or realm` in a new package's tests | Copy the `graphql` alias from `apps/core/vitest.config.ts` (see [conventions](./conventions.md#testing)) |
| `unsupported startup parameter: …` from PgBouncer | Something sends a session setting when connecting. Set it on the login or per transaction instead (see [conventions](./conventions.md#connection-pooling)) |
| Worker warns that no notifications arrive on the outbox LISTEN connection | `DATABASE_SYSTEM_URL` goes through PgBouncer. Set `DATABASE_LISTEN_URL` to a direct connection |
| `prepared statement "hatti_…" already exists` or `does not exist` through PgBouncer | It runs without `max_prepared_statements`, which hot queries need (see [conventions](./conventions.md#connection-pooling)). Restart it from `db/pgbouncer/pgbouncer.ini` |
