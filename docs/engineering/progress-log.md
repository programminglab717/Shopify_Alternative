# Engineering progress log

> Newest first. Every change that lands on the branch gets an entry, and so does the work in
> progress. The current state of each roadmap deliverable is on
> [Phase 0 status](./phase-0-status.md); this log records how it got there and what was learned.

## In progress

**Merging and erasure:** merging two customers who are the same person, and erasing a customer's
personal data on request while keeping the order records the law needs. Then numbers masked from
confirmation agents and marketers, with a logged reveal.

## 2026-09-28

### COD risk rules

* **Cash-on-delivery orders are scored (COD-06, MVP)** for how likely they are to come back
  unpaid, from transparent rules: the customer's refusals, cancellations and deliveries in this
  shop, another unshipped order from the number in the last 6 hours, the order's value and size,
  and whether the address has a house number, is long enough and names a city couriers know.
  Prepaid orders are not scored.
* **`Order.risk`:** a score from 0 to 1, a level (`LOW`, `MEDIUM`, `HIGH`) and the reasons,
  strongest first, such as "Refused 2 deliveries from this shop". `orders(riskLevel:)` filters
  by level, and `order.created` events carry it.
* **Holds:** orders at the shop's threshold or above (0.6 by default) wait for review
  (`NEEDS_REVIEW`), with the score and what raised it on the timeline. An address change scores
  the order again, and holds it only if the change is what makes it risky, so staff who reviewed
  a risky order can still correct it.
* **The policy:** `orderRiskSettings` and `orderRiskSettingsUpdate` set the threshold (or none)
  and what counts as high value (Rs 15,000 by default). New `read_settings` and
  `write_settings` scopes, for owners and managers; each change is an
  `order_risk_settings.updated` event naming who made it.
* **Fairness:** no rule looks at which city an order is for; no address rule alone reaches the
  medium level; merchants see every reason.
* **The score is a snapshot** taken when the order is placed or re-addressed, kept with its
  reasons ([ADR-025](../architecture/13-decision-log.md#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)).
* **Changed:** a refused parcel now counts as returned in a customer's delivery history and the
  `returned_orders` segment field from when it starts coming back, not only once it is checked
  in. Return to origin takes days, and a customer can order again meanwhile.
* **Migration `0012`**; the seed adds a large order from the customer who refused a parcel, to a
  vaguer address, which waits for review at risk 0.70.
* 482 tests, directly and through PgBouncer.

### 8b08f21 · Customer import and export

* **`customersImport` (CUS-07)** takes CSV: Hatti's own export, Shopify's customer export, or a
  spreadsheet with a Phone column.
  * Headings are matched ignoring case, spaces and underscores. Shopify's First and Last Name,
    Default Address Phone and Accepts Email/SMS Marketing columns work.
  * Rows that fail are reported by row and column, such as a US number, a bad email, the same
    number twice or email consent without an address; the rest go in, in one transaction.
  * Customers already here are left as they are unless the import overwrites them. `dryRun`
    counts what would happen.
  * Consent columns go into the consent ledger with the source `import`.
* **`customersExport`** gives everyone, a saved segment or a segment query as CSV, with consent
  and every labelled segment field: orders, amount spent, first and last order, delivered,
  returned and cancelled orders, city and province.
  * For owners and managers only (`write_customers`), as the role design asks.
  * Every row carries a watermark: who exported it and when.
  * Each export is recorded as a `customer_export.created` event. What Hatti exports, Hatti
    imports.
* **`@hatti/csv`**, a new platform package: RFC 4180 reading and writing, a byte-order mark so
  Excel shows Urdu, and cells a spreadsheet would run as formulas made safe.
* **Limits:** 5,000 rows per import, 10,000 customers per export.
* **Found on the way:** four `\uFEFF` escapes had become invisible characters in source files;
  they are escapes again.
* 467 tests, directly and through PgBouncer.

### 70d07dd · Marketing consent

* **Consent per channel (CUS-04):** WhatsApp, SMS and email are each `not_subscribed`,
  `subscribed` or `unsubscribed`, on the customer as `whatsappMarketingConsent`,
  `smsMarketingConsent` and `emailMarketingConsent`, with when the customer said so.
* **`customerMarketingConsentUpdate`** records changes for several channels at once, and
  `customerCreate` takes consent too. Subscribing needs the wording the customer agreed to. A
  change can say where it came from (staff, an app, an import, checkout or a reply) and when, if
  earlier.
* **The consent ledger** (`Customer.consentHistory`) keeps every change: state, wording, source,
  when, the number or address it was for, and who recorded it. It is append-only: request code
  can add to it, not change or delete it.
* **Consent belongs to a contact:** a new number resets WhatsApp and SMS consent, and a new or
  removed email resets email consent, each as a ledger entry.
* **Segments** filter by `whatsapp_subscription_status`, `sms_subscription_status` and
  `email_subscription_status`, as broadcasts will need.
* **Events:** `customer.marketing_consent_updated`, one per channel changed.
* **Migration `0011`**; the seed records consent for three customers and saves a "WhatsApp
  subscribers" segment.
* 452 tests, directly and through PgBouncer.

### 7698b9f · Segments

[ADR-024](../architecture/13-decision-log.md#adr-024--segments-are-queries-evaluated-on-demand-over-fields-modules-contribute)

* **Segments (CUS-03):** saved customer filters, like "bought 2+ times, in Lahore, no order in 60
  days". `segmentCreate`, `segmentUpdate`, `segmentDelete`, `segment` and `segments`, with each
  segment's `memberCount` and `members`, found when asked for. `segmentPreview` tries a query
  before it is saved, and `segmentFilters` lists the fields.
* **A query language close to Shopify's:** `number_of_orders >= 2 AND city IN (Lahore,
  Islamabad) AND last_order_date < -60d`.
  * `AND`, `OR`, `NOT` and parentheses; comparisons, `BETWEEN`, `IN` and `CONTAINS`.
  * Dates as days or days, weeks, months or years ago, counted in Pakistan time.
  * Amounts in the shop's currency, and cities and provinces written any common way (`lhr`,
    `KPK`).
  * Mistakes say what and where: `Unknown field "orders". Did you mean number_of_orders? (at
    character 1)`.
  * It compiles to one SQL statement; every value is a parameter.
* **Fields modules contribute:** customers have tags, when they were added, and whether they are
  blocked. The orders module registers orders, amount spent, first and last order, delivered,
  returned and cancelled orders, city and province, from the same query as a customer's stats.
  Consent and behaviour fields will register the same way.
* **Scopes:** `read_segments` and `write_segments`; members also need `read_customers`. Marketers
  build segments without being able to change customers.
* **Events:** `segment.created`, `segment.updated` and `segment.deleted`.
* **Migration `0010`** adds segments. The seed saves four.
* **Fixed on the way:** segments were labelled CUS-02 in the status page; the feature catalog
  calls them CUS-03 (CUS-02 is customer accounts with OTP login).
* 446 tests, directly and through PgBouncer.

### efdba8e · Customers and the blocklist

[ADR-023](../architecture/13-decision-log.md#adr-023--customer-order-stats-are-worked-out-from-orders-when-read)

* **Customers, phone first (CUS-01).** A customer is whoever a mobile number belongs to, one per
  number per shop (ADR-011).
  * Orders find or create their customer in the transaction that places them. A new number
    becomes a customer with the order's name and email; a known one keeps its profile.
  * An order whose number is corrected moves to that number's customer. Two orders placed at the
    same moment by a new number get one customer.
* **What a customer's orders add up to**, on `Customer`: `numberOfOrders`, `amountSpent`,
  `deliveryHistory` (delivered, returned, cancelled, in progress), `lastOrderAt`, `orders` and
  `addresses`. The orders module adds these fields and works them out from the orders when they
  are asked for, one query per page of customers, so there is no second copy to drift (ADR-023).
  `Order.customer` goes the other way.
* **`customerCreate`**, **`customerUpdate`**, `customer` and `customers`. Search takes a number in
  any format, its last four or more digits, or words of the name or email.
* **The merchant's blocklist (COD-07):**
  * `blocklistAdd` blocks a number with a reason (fake orders, refused deliveries, abuse, fraud,
    other) and a note; blocking it again replaces them. Also `blocklistRemove` and `blocklist`.
  * A number can be blocked before it is ever a customer.
  * Orders from a blocked number, or whose number changes to one, wait for review at the
    `NEEDS_REVIEW` stage, with the reason on their timeline. `orderConfirm` lets one go ahead.
* **Scopes:** `read_customers` and `write_customers`. Owners and managers edit customers and the
  blocklist, confirmation agents and marketers view them, and packers and accountants see
  neither. An order's customer needs `read_customers`; a customer's orders need `read_orders`.
* **Shared input checks:** `InputChecker` in `@hatti/api` now checks tags, email addresses and
  Pakistani mobile numbers, replacing copies in the catalog and orders modules.
* **`OrderAddress` is now `MailingAddress`**, as in Shopify, since customers have addresses too.
* **Events:** `customer.created` (from an order, or added by staff or an app), `customer.updated`,
  and `blocklist_entry.created`, `.updated` and `.deleted`. `order.created` carries the customer.
* **Migrations `0008` and `0009`** create the `customers` schema and give every order its
  customer, including orders placed before customers existed.
* **Seed:** blocks two numbers, has one customer order twice, and places an order from a blocked
  number, which waits for review.
* 426 tests, directly and through PgBouncer.

### 1a41535 · Parcels: shipping, delivery and return to origin

* **`orderFulfill`** ships items of a confirmed or prepaid order in one parcel: everything left to
  ship, or the lines listed. It takes them out of stock, and records a courier and tracking
  number. Cash-on-delivery orders are never shipped unconfirmed, and nothing ships twice.
* **`fulfillmentMarkDelivered`**, **`fulfillmentMarkReturning`** for a parcel refused or
  undeliverable, and **`fulfillmentReceiveReturn`** for checking it back in. Checking in says how
  many of each line go back on the shelf; the rest are written off as damaged. Also
  **`fulfillmentTrackingInfoUpdate`**.
* **Stages follow the parcels:** partly shipped, in transit, returning, delivered, returned and
  completed. An order closes once it is delivered and paid, or every parcel came back. A
  cash-on-delivery order that came back unpaid is voided.
* **`StockService.restock`** puts returned items back on hand, recorded in the ledger as a
  restock, with the order as its reference.
* **Search** finds an order by a parcel's tracking number.
* **Events:** `fulfillment.created` and `fulfillment.updated`, with the order's stage and version.
* **Migration `0007`** adds the parcels. The seed's orders now cover every stage: in transit,
  delivered and paid, and refused and checked back in.
* 398 tests, directly and through PgBouncer.

### 88521ad · Orders: placing, confirming, cancelling and paying

* **`orderCreate`**, for orders staff take from chats and orders apps send:
  * lines priced from the catalog, or at a price agreed in chat;
  * shipping charge, discount, and cash on delivery (with an optional advance) or prepaid;
  * a Pakistani address: the city spelled the standard way, the province from the city, and a
    mobile number the courier can call.
  Its stock is committed at its location in the same transaction, so an order exists only if
  its stock does. Short stock is an `OUT_OF_STOCK` user error, and nothing is written.
* **Order numbers** from #1001 per shop, without gaps: an order takes its number last in its
  transaction. A test places 8 orders for 5 units at once and gets #1001 to #1005.
* **`orderConfirm`**, **`orderCancel`** (which releases the stock, with a reason and a note),
  **`orderUpdate`** (address, email, note, tags) and **`orderMarkAsPaid`**.
* **Four statuses and one stage**, the state merchants see, stored so that `orders(stage:)` and
  `orderStageCounts` are index lookups.
* **Search** by order number, by mobile number in any format, or by words of the name, city or
  email.
* **A timeline** per order (`Order.events`), in words for staff; request code can only add to it.
* **Events:** `order.created`, `order.updated`, `order.confirmed`, `order.cancelled` and
  `order.paid`, each with the stage and version.
* **Packers** see customers' mobile numbers only partly, as the role design asks.
* **Scopes:** `read_orders` and `write_orders`. Confirmation agents and packers can work on
  orders; marketers and accountants view them.
* **Found on the way:** raw queries return timestamps as text, because Drizzle turns off the
  driver's date parsing, and the GraphQL `DateTime` type turns such text into `null`. So asking
  for a product's `createdAt`, or the time of a stock change, failed. Timestamps are now converted
  with `toDate()` from `@hatti/db`, and the API tests ask for them.
* **Migration `0006`** creates the `orders` schema. The seed places four orders, at different
  stages.
* 389 tests, directly and through PgBouncer.

### 07e2ea0 · Inventory: locations, stock levels and the stock ledger

[ADR-022](../architecture/13-decision-log.md#adr-022--stock-changes-lock-levels-in-one-order-check-then-write)

* **Locations:** `locationAdd`, `locationEdit`, `locationDeactivate`, `locationActivate`,
  `locationDelete`, `location` and `locations`.
  * The first location is primary. A shop gets one, "Main location", the first time it needs one.
  * Addresses are Pakistani: the province by code, name or alias, known cities spelled the
    standard way, five-digit postcodes, and mobile numbers stored in E.164.
  * Deactivating needs an empty location, and waits for sales in progress there. Only a location
    that never held stock can be deleted.
* **Stock levels** per variant and location: on hand, committed, reserved and safety stock, and
  available, which is on hand less the other three. What sells online is what is available at
  active locations that fulfil online orders.
* **Stock counts and adjustments:**
  * `inventorySetQuantities`, where a `compareQuantity` makes a count fail as `STALE` if the level
    changed since it was read;
  * `inventoryAdjustQuantities`, with a reason from a fixed list;
  * `inventoryItemUpdate`, for tracking and for selling on at zero.
  Every request applies fully or not at all, and recording stock starts tracking a variant.
* **The ledger:** each change is an adjustment (why, what caused it, who) with a movement per
  quantity it changed. Request code can only add to it. `InventoryItem.changes` pages through it.
* **`StockService`**, for checkout and orders, runs in their transaction: reserve, release,
  commit (also from a reservation), release a commitment, and fulfil. Short stock comes back as
  shortages; nothing is oversold.
* **One write path:** lock the levels in (variant, location) order, check, then write the levels,
  the adjustment and its movements in one statement, and an `inventory_level.updated` per level.
  Tests run 20 buyers against 5 units, orders listing two variants in opposite orders, and a
  deactivation racing a sale.
* **Stock on the catalog's types:**
  * `ProductVariant.inventoryItem`, `inventoryQuantity` and `availableForSale`;
  * `Product.totalInventory` and `tracksInventory`.
  They need `read_inventory`, and load through per-request batch loaders, so a page of products
  reads its stock with one query.
* **Platform:**
  * scopes `read_inventory`, `write_inventory`, `read_locations` and `write_locations`: owners
    and managers edit, other roles view;
  * `InputChecker`, `MutationResult` and `UserErrorsRollback`, shared from `@hatti/api`;
  * `RequestLoaders` for batching, and `appendEvents` for many events in one statement;
  * Postgres error checks in `@hatti/db`;
  * scope guards on field resolvers.
* **Migration `0005`** creates the `inventory` schema. The seed stocks a Lahore warehouse and a
  Karachi store that sells only over the counter.
* **Found on the way:** IDs that order a list must come from the application. `platform.uuidv7()`
  is random within a millisecond, so two ledger entries written in the same millisecond could
  have shown in the wrong order.
* 369 tests, directly and through PgBouncer.

### 34f4c7e · Catalog depth: options, bulk variants, images and collections

* **Options and variants:**
  * products take up to three options, and every combination of their values becomes a variant
    unless variants are listed;
  * `productOptionsCreate`, `productOptionUpdate` (rename, move, add, rename or delete values)
    and `productOptionsDelete`, which refuses to leave two variants the same;
  * variants gain cost (for profit) and weight in grams (for shipping rates).
* **`productVariantsBulkCreate`, `…Update` and `…Delete`:** one statement per batch, so two
  variants can swap values. Values a variant names but its option lacks are added.
* **Images by URL** (`productCreateMedia`, update, delete, reorder), shown per variant if chosen.
  Fetching and resizing them waits for the media worker.
* **Collections:**
  * manual collections, with add, remove and reorder;
  * smart collections, whose rules on title, type, vendor, tag, variant title, price, compare-at
    price, weight or price reduction are kept up to date in the same transaction as every product
    change;
  * seven sort orders, with keyset pages.
* **Also:** `productDelete`, `productByHandle`, `productTags`, `productTypes` and
  `productVendors`.
* **One-statement reads:** each product loads with its options, variants and media in one
  statement, following spike 5.
* **Migration `0004`** adds the tables. It gives products that had several variants a "Title"
  option, as Shopify does, so the new uniqueness rule holds on existing data.
* 325 tests.

### 2834a8c · Spike 5: row-level security and PgBouncer, go

[Results](./spikes/05-rls-and-pooling.md) ·
[ADR-021](../architecture/13-decision-log.md#adr-021--pgbouncer-transaction-pooling-with-no-session-state)

* **Benchmark:** `tools/db-bench` (`pnpm bench:db`) loads 1,000 shops, with 460k products and 820k
  variants, in 22 seconds. It measures the products listing with pgbench and with the
  application's own code, directly and through PgBouncer.
* **Row-level security** keeps every listing plan. Queries also filter by shop explicitly, so
  Postgres reduces the policy to one check per query. It costs about 0.1 ms per transaction,
  mostly in planning.
* **Leakproof operators:** under row-level security, `LIKE`, array and jsonb operators cannot use
  indexes or statistics. A trigram or tag GIN index goes unused, and queries take 2–3 times
  longer. Text search stays with Typesense.
* **PgBouncer:**
  * adds about 0.03 ms per round trip on the same host;
  * served 1,024 clients on 20 server connections, where direct connections failed at 128;
  * showed no shop setting leaking in more than 50,000 interleaved transactions, while a
    deliberate session-level setting was caught.
* **Fixed:**
  * the app could not connect through PgBouncer at all (timeouts sent as startup parameters);
  * the relay's `LISTEN` would have silently gone deaf behind a pooler (now
    `DATABASE_LISTEN_URL`, checked at start-up).
* **Tests:** CI runs every database test through PgBouncer.
* **Timeouts** now come from login defaults and per-transaction limits; the Admin API allows 5 s
  per statement.
* 284 tests.

### a3e23ee · Progress log

This log, backfilled to the first commit, and spike 5 marked as in progress.

## 2026-09-27

### b965280 · Tracing and metrics end to end

* `@hatti/telemetry` starts OpenTelemetry before the app (`node --import`). It is switched off
  unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
* One trace follows a request from the API through GraphQL and Postgres into the outbox, then on
  to the worker that processes the event (migration `0003` stores the trace context with each
  event).
* Spans carry `hatti.shop_id`, and log lines carry `trace_id` and `span_id`.
* Metrics: outbox lag, parked events, published and rejected events, relay outages, event
  handling time and sign-in results, plus the standard HTTP metrics.
* An end-to-end test starts the built API with a stand-in collector and checks what arrives.
* Local Grafana stack: `docker compose --profile observability up -d`.
* 280 tests in total. CI green.

### 069df4d · Staff sign-in with two-step verification and shop roles

* New packages: `@hatti/crypto` (secret encryption with key rotation, TOTP), `@hatti/ratelimit`
  and `@hatti/identity`.
* Migration `0002` adds the identity schema with its own database login.
* Passwords use argon2id and are checked against Have I Been Pwned. Two-step verification uses an
  authenticator app, with recovery codes; a code cannot be used twice.
* Sessions: 15-minute access tokens and rotating refresh tokens with reuse detection. Staff can
  list their devices and sign any of them out.
* Rate limits on sign-in, sign-up and code attempts.
* Six role presets. Owners, managers and accountants must use two-step verification.
* The Admin API accepts staff (a bearer token plus `x-hatti-shop-id`) as well as apps.
* [ADR-020](../architecture/13-decision-log.md#adr-020--staff-identity-built-in-house-on-audited-primitives)
  records why we built this ourselves.

### abdd0a3 · One bad event no longer blocks the outbox relay

A batch the queue rejects is now retried one event at a time. An event that keeps failing while
others get through is parked after 10 attempts, with its last error, for someone to inspect. A
queue outage never counts against an event's attempts.

### 2a0cf4f · CI on every branch

CI runs on pushes to every branch, not only `main`.

### 58c2992 · Phase 0 foundation and the first vertical slice

* **Monorepo:** pnpm workspaces with a version catalog, Turborepo, TypeScript (ESM), ESLint,
  Prettier and GitHub Actions CI against real Postgres and Valkey.
* **Platform packages:** ids, money, Pakistan data (phones, CNIC, IBAN, cities, Urdu and Roman
  Urdu search keys), config, logger, design tokens, db, events and api.
* **Data layer:** migration `0001` creates the database roles, per-shop RLS, the shop directory,
  access tokens, products and variants, and the transactional outbox with its relay.
* **First vertical slice:** an Admin API request creates a product under RLS, and its event
  reaches a worker through the outbox.
* **Docs:** conventions, getting started and Phase 0 status.

### f49e79f · Research, product, design and architecture plan

* Market research, a Shopify benchmark and the local ecosystem.
* Product vision, feature catalog, pricing and roadmap.
* Design principles, the design system, information architecture and key user flows.
* Thirteen architecture documents with a decision log, plus the executive summary.
