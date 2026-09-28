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
pnpm seed              # demo shop: products, stock, orders, customers, segments, an owner and an app token (printed once)
pnpm dev:api           # http://localhost:4000, GraphiQL at /graphiql
pnpm dev:worker        # outbox relay and event consumers (in a second terminal)
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

The seed also places eleven orders at every stage, from waiting for the customer to confirm to
delivered and paid, and one refused at the door and checked back in. Take an order from a
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
`orderUpdate` for a new address, and `orderMarkAsPaid` when the cash arrives.

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
`brew install pgbouncer`; tested with 1.22). If the package started its own service on port 6432,
stop it. Then start ours from the repository root:

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
[results](./spikes/05-rls-and-pooling.md)). It needs `pgbench`, which comes with the Postgres
client tools, and PgBouncer for the pooled runs.

```sh
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres
export BENCH_POOLER_URL=postgres://127.0.0.1:6432
pnpm bench:db seed      # database hatti_bench: 1,000 shops, about 460k products, in under a minute
pnpm bench:db explain   # query plans with and without row-level security (a minute)
pnpm bench:db all       # plans, pgbench, the application code, leak checks (about 15 minutes)
```

`BENCH_SCALE=smoke` loads a tiny dataset and runs for seconds, to check the tool itself.

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
| `Invalid configuration: DATABASE_IDENTITY_URL` or `ENCRYPTION_KEYS` | Your `.env` predates staff sign-in. Copy the new lines from `.env.example` and run `pnpm db:setup` |
| `Cannot use GraphQLEnumType … from another module or realm` in a new package's tests | Copy the `graphql` alias from `apps/core/vitest.config.ts` (see [conventions](./conventions.md#testing)) |
| `unsupported startup parameter: …` from PgBouncer | Something sends a session setting when connecting. Set it on the login or per transaction instead (see [conventions](./conventions.md#connection-pooling)) |
| Worker warns that no notifications arrive on the outbox LISTEN connection | `DATABASE_SYSTEM_URL` goes through PgBouncer. Set `DATABASE_LISTEN_URL` to a direct connection |
