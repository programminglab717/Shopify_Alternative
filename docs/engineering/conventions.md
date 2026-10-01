# Engineering conventions

> The rules the codebase follows, and why. Architecture background is in
> [02 · Tech stack](../architecture/02-tech-stack.md) and
> [03 · Multi-tenancy & data](../architecture/03-multi-tenancy-and-data.md).

## Repository layout

| Path | Contents |
|---|---|
| `apps/core` | The modular monolith: Admin GraphQL API (`src/main.ts`), worker (`src/worker.ts`), seed |
| `apps/storefront` | The storefront renderer (spike 1): Liquid, its limits, a benchmark and a dev server; it reads themes with `@hatti/themes` |
| `themes/*` | Themes, as merchants would publish them: `hatti-base`, the reference theme |
| `packages/platform/*` | Shared infrastructure: `ids`, `money`, `pk`, `config`, `logger`, `telemetry`, `crypto`, `ratelimit`, `db`, `events`, `api`, `csv`, `documents`, `storefront-data`, `storefront-api`, `themes` |
| `packages/modules/*` | One package per bounded context. So far: `catalog`, `identity`, `inventory`, `orders`, `customers`, `online-store`, `checkout` |
| `packages/ui/*` | Design system. So far: `tokens` |
| `db/migrations` | Forward-only SQL migrations, applied in order |
| `docs` | Research, product, design, architecture and engineering documents |

## Packages and boundaries

* Everything is **ESM TypeScript** (`"type": "module"`, `NodeNext`). Relative imports end in
  `.js`.
* Packages are used **only through their entry points** (`package.json` `exports`). ESLint rejects
  deep imports such as `@hatti/db/src/…`.
* A module exposes **only `@hatti/<module>/public`**; `src/internal` is private. Other modules use
  its public facade and events, never its tables.
  * When a module must check another's data inside its own transaction, the owner offers a
    facade method that takes the caller's `tx`, such as `VariantService.productIdsOf(tx, …)`.
  * A module may add fields to GraphQL types another module exports: the catalog exports
    `Product` and `ProductVariant`, and inventory adds their stock fields; customers export
    `Customer`, and orders add a customer's orders and what they add up to.
  * The one foreign key across modules is `inventory.items → catalog.variants`: stock belongs to
    its variant and is deleted with it.
  * A module can offer an extension point that others register with at start-up, as the
    customers module's `SegmentFieldRegistry` takes the orders module's segment fields, and its
    `CustomerDataRegistry` the orders module's part in merges and erasure. The owner of the
    facts keeps its SQL; the extension point needs no dependency on it.
  * A transaction that locks rows of several modules takes them in one order: **an order, then
    stock levels, then a customer's number, then the order counter**. Placing an order commits
    its stock before it finds or creates its customer, so two orders from a new number cannot
    each wait for the other. Merging and erasing customers lock the customers first, then their
    orders and numbers; order transactions never lock a customer row, so a merge or erasure
    waits for orders in progress rather than deadlocking with them.
* `packages/platform/*` never imports from modules.
* Dependency versions live in the **pnpm catalog** (`pnpm-workspace.yaml`), and packages refer to
  them as `catalog:`. pnpm refuses releases younger than a day (`minimumReleaseAge`) and runs no
  dependency install scripts.
* NestJS and GraphQL are **peer dependencies** of library packages, so the app and its modules
  share one copy. Two copies of `@nestjs/graphql` would split its type registry.

## Tenancy

A leak between shops is the worst bug this platform can have, so isolation has three layers.

1. **The shop comes only from authentication.** An app token is bound to one shop. A staff
   request names its shop in `x-hatti-shop-id`, and authentication accepts it only if the user has
   an active role there. Resolvers take `@CurrentTenant()`; no GraphQL argument ever carries a
   shop ID.
2. **Queries filter by shop explicitly**, as in `where shop_id = tenant.shopId`.
3. **Postgres row-level security** enforces it anyway. Request code runs in
   `db.tenant(shopId, tx => …)`, which sets `app.shop_id` for that transaction only. The login
   `hatti_app` has no `BYPASSRLS`. Without a shop set, queries see no rows.

When you add a table:

* Add a `shop_id uuid NOT NULL` column and a primary key that starts with it:
  `PRIMARY KEY (shop_id, id)`. Every index starts with `shop_id` too.
* Call `SELECT platform.enable_tenant_isolation('<schema>.<table>')` in the migration. It enables
  and forces RLS, adds the tenant and system policies, and grants access.
* Reference other tenant tables with composite foreign keys `(shop_id, x_id)`, so a row can never
  point into another shop.
* Add a **cross-tenant test**: using shop B's token on shop A's IDs must give not-found. See
  `apps/core/src/api/api.e2e.test.ts`.

The `hatti_system` login sees every shop. Only cell-wide jobs get it, such as the outbox relay;
request-serving processes never do.

### Queries under row-level security

Spike 5 measured these rules ([results](./spikes/05-rls-and-pooling.md)).

* **Filter by shop explicitly as well.** Postgres then reduces the policy to one check per query,
  a `One-Time Filter` in the plan, so row-level security costs next to nothing.
* **Only leakproof operators can use an index under row-level security.** Postgres applies the
  policy first. It lets a condition run before the policy, or inside an index scan, only if the
  operator cannot leak data through errors. Equality and ranges on uuid, text, numbers and
  timestamps are leakproof.
* **These are not leakproof:** `LIKE` and `ILIKE`, regular expressions, array and jsonb
  containment (`@>`, `&&`), and full-text search (`@@`). Postgres checks them row by row after
  the policy, even when a trigram or GIN index exists. It also cannot use column statistics for
  them, so its row estimates are guesses.
* So text search goes to Typesense (ADR-013). Filterable sets such as tags or collection
  membership are rows with a B-tree index, not arrays with a GIN index.
* Check the plan of any new list or search query with `pnpm bench:db explain` or `EXPLAIN` as
  `hatti_app` inside a tenant transaction. Checking as a superuser skips the policies and shows
  plans production will not get.
* **Raw queries return timestamps as text.** Drizzle turns off the driver's date parsing and
  converts only the columns of typed selects, so a row from `tx.execute(sql…)` holds
  `"2026-09-28 09:42:15.75563+00"`. Convert it with `toDate()` from `@hatti/db`: the GraphQL
  `DateTime` type turns a string like that into `null`. Amounts inside JSON travel as text too.

## Connection pooling

Request-serving processes reach Postgres through **PgBouncer in transaction mode**: each
transaction borrows a server connection and returns it at commit. CI runs every database test
this way (`DATABASE_POOLER_URL`), and `pgbouncer db/pgbouncer/pgbouncer.ini` runs the same set-up
locally on port 6432.

* **No session state.** Nothing may outlive a transaction: no `SET`, no `set_config(…, false)`,
  no `LISTEN`, no session-level advisory locks, no temporary tables and no named prepared
  statements. Use `set_config(…, true)` or `SET LOCAL`, as `db.tenant()` does. A session-level
  setting stays on its server connection, and PgBouncer hands that connection to other callers.
  The benchmark's control experiment shows it exposing one shop's rows to other requests.
* **No connection parameters.** PgBouncer refuses connections that send session settings, such
  as `statement_timeout`, when they connect. Timeouts come from two places instead:
  * each login's defaults (`LOGIN_DEFAULTS`: 15 s per statement, 30 s idle in a transaction),
    which `pnpm db:setup` sets locally and infrastructure code sets elsewhere;
  * each tenant transaction's limits (`transactionLimits` on the `Database`), set in the same
    statement as the shop. The Admin API allows 5 s.
* **Direct connections, only for:**
  * migrations and `db:setup`, which take session-level advisory locks;
  * the relay's `LISTEN` (`DATABASE_LISTEN_URL`). At start-up the relay checks that notifications
    arrive. If they don't, it logs a warning and polls.
  * operator tools.

## IDs

* Primary keys are **UUIDv7**, generated in the application with `newId()` from `@hatti/ids`.
  They sort by time, which keeps B-tree inserts cheap. IDs that order a list, such as ledger
  entries in stock history, must come from `newId()`: it counts up within a millisecond, while
  `platform.uuidv7()` in SQL is random within one.
* APIs expose **public IDs**: a type prefix plus Crockford base32, e.g. `prod_01m3ja7a10…`. Add
  new kinds to `ID_PREFIXES`. Decode input with `tryFromPublicId(id, 'product')`, which also
  rejects an ID of the wrong kind.

## Money

* Amounts are **`bigint` minor units** (paisa) plus a currency. Never use floats.
* Use `@hatti/money` for arithmetic, percentages (basis points, half-even rounding), splitting
  (largest remainder, so parts always add up) and parsing (`fromMajor('2,499.50', 'PKR')`).
* Display prices with `formatMoney()`, which groups digits the South Asian way:
  `Rs 1,25,000`.

## Pakistan-specific data

Use `@hatti/pk` instead of ad-hoc regular expressions:

| Need | Function |
|---|---|
| Mobile numbers, in any format and with Urdu digits | `parsePkMobile()`. Store the `e164` form |
| CNIC and NTN | `normalizeCnic()`, `normalizeNtn()` |
| Bank accounts | `normalizePkIban()` (mod-97 checked), `formatIban()` |
| City input | `findCity()`, `searchCities()`: aliases such as Pindi, Lyallpur, RYK, and Urdu names |
| Search and matching | `searchKey()`: unifies Arabic and Urdu letters, strips diacritics, folds Roman Urdu (qameez = kameez = kamiz) |

In services, check input with `InputChecker` from `@hatti/api`: `mobile()` for mobile numbers
(returns E.164), `email()` and `tags()`, so that every module gives the same messages.

## Migrations

* Plain SQL in `db/migrations/NNNN_description.sql`, applied in order. Each file runs in one
  transaction.
* **Forward-only and immutable.** The migrator stores a checksum and refuses to run if an applied
  file changed. To fix something, add a new migration.
* Drizzle table definitions in modules mirror the SQL for typed queries. Each module has a test
  that selects every column, so drift fails CI.
* Migrations must work for a non-superuser owner, as on managed Postgres. Grant to the group
  roles `hatti_app_role` and `hatti_system_role`, never to login users.

## Domain events

* Record events with `appendEvent(tx, shopId, …)` **inside the transaction that makes the
  change**. They are published only if it commits (transactional outbox). `appendEvents` records
  many in one statement, e.g. one per stock level a count changed.
* Name them `<aggregate>.<past-tense verb>`, e.g. `product.created`. Keep payloads thin: IDs,
  changed field names and versions, not whole documents.
* Delivery is **at least once and not strictly ordered**. Handlers must be idempotent: deduplicate
  on the event `id`, and compare versions where order matters.
* The relay isolates bad events. If the queue rejects one event while others get through, that
  event is retried and, after 10 attempts, **parked**: it stays unpublished with its `last_error`.
  To retry it, set its `attempts` back to 0. An outage of the queue itself never uses up attempts;
  the relay just backs off.

## GraphQL Admin API

* Versioned by date in the path: `/admin/api/2026-10/graphql`. The schema is committed as
  `apps/core/schema.graphql`, and a test fails on any unreviewed change.
* Two kinds of caller. **Apps** send `x-hatti-access-token: hat_…` (43 random characters; only
  the SHA-256 is stored). **Staff** send `Authorization: Bearer hsa_…` from
  [sign-in](#staff-sign-in) plus `x-hatti-shop-id: shop_…`; their role's preset decides the
  scopes.
* Declare scopes with `@RequireScopes('read_products')`. The guard runs on every resolver,
  field resolvers included, so resolvers require authentication by default, and a field such as
  a variant's stock can need more than its parent. `write_x` implies `read_x`. The scopes are
  `products`, `inventory`, `locations`, `orders`, `customers` and `segments`, each `read_` or
  `write_`.
* **Input problems are data, not errors.** Mutations return `userErrors { field code message }`
  with stable codes: `BLANK`, `TOO_LONG`, `TOO_MANY`, `TOO_FEW`, `INVALID`, `TAKEN`, `IN_USE`,
  `NOT_FOUND`, `STALE` (the data changed since the client read it) and `OUT_OF_STOCK`.
  * Services check input with `InputChecker` and return `MutationResult` (both in `@hatti/api`).
  * A problem found only after the transaction has written something is thrown as
    `UserErrorsRollback`; `rollbackResult` turns it back into user errors once the transaction
    has rolled back.
* **Mutations that must not run twice need an `Idempotency-Key` header**
  ([ADR-030](../architecture/13-decision-log.md#adr-030--idempotency-keys-are-kept-in-postgres-per-caller-for-a-day)):
  placing, shipping and refunding orders, and adjusting stock quantities. Mark such a resolver
  with `@RequireIdempotencyKey()`. Any mutation may send a key. The first answer to a key is kept
  for 24 hours, per shop and caller; a retry with the same key and request gets it back, marked
  `Idempotent-Replayed: true`, and does nothing more. Without a key, or with a malformed one,
  such a mutation gets `IDEMPOTENCY_KEY_REQUIRED` or `IDEMPOTENCY_KEY_INVALID` (400); the same
  key with a different request gets `IDEMPOTENCY_KEY_REUSED` (422), and a retry while the first
  request runs `IDEMPOTENCY_KEY_IN_USE` (409). Queries ignore the header.
* **Fields resolved for each item of a list batch their reads.** They ask the request's loaders
  (`@Loaders()`), which gather the keys a page asks for and fetch them with one query. A page of
  50 products reads all its variants' stock with one query.
* GraphQL errors carry `extensions.code`: `UNAUTHENTICATED` (HTTP 401: refresh or sign in),
  `SHOP_REQUIRED` (400), `NO_SHOP_ACCESS` and `MFA_REQUIRED` (403), `ACCESS_DENIED`,
  `BAD_USER_INPUT` (malformed IDs, cursors or page sizes), `BAD_REQUEST` (a request the server
  cannot read, such as a body that is not JSON, with the 4xx status Fastify gave it), and
  `INTERNAL_SERVER_ERROR`. In production, internal errors show only a request id; the details go
  to the logs. Only internal errors are logged as errors.
* Lists are Relay-style connections: `first` (1–250, default 50), `after`, and
  `pageInfo { hasNextPage endCursor }`. Cursors are opaque.
* Money fields return `{ amount, currencyCode, formatted }`. Money inputs are decimal strings in
  the shop currency, e.g. `"2,499.50"`.
* **An API enum has a value for everything its column can hold.** A stored value the enum lacks
  fails every query that reads it, and a non-null field takes its list down with it. Name a
  value reserved for what is not built rather than leave it out; the orders module's
  `enums.test.ts` checks its enums against the schema's value lists, and a module whose enums
  read stored values checks its own the same way.

## Catalog

The catalog follows Shopify's model, so merchants and importers find what they expect.

* **Options and variants.** A product has up to three options (Size, Colour, Fabric), each with
  ordered values, and at most 250 variants.
  * Each variant is one combination of values. A constraint in Postgres keeps combinations unique,
    and a product without options has exactly one variant, "Default Title".
  * A variant's title is its values joined with " / ", kept up to date when options are renamed,
    moved or removed.
  * Bulk mutations handle variants in one statement, so two variants can swap values.
* **Every change to a product's options, variants or media** bumps its `version` (caches are keyed
  by it). It records `product.updated`, with what changed, e.g. `changed: ["variants"]`.
* **Reads are one statement.** A product loads with its options, variants and media as JSON from
  one query, whatever the page size, because every round trip costs time through the pooler
  (spike 5). Amounts travel as text inside the JSON: JSON numbers lose precision above 2^53.
* **Smart collections** compile their rules to SQL. Membership is brought up to date in the same
  transaction as the change that affects it, whether a product edit, a variant price or new rules.
  So manual and smart collections read the same way, and never lag.
* **Media** records an image's source URL until the media worker, not built yet, fetches and
  resizes it. Only https sources are accepted.

## Inventory

Stock follows Shopify's model too. How changes are written is decided in
[ADR-022](../architecture/13-decision-log.md#adr-022--stock-changes-lock-levels-in-one-order-check-then-write).

* **Quantities.** Each variant has an inventory item, with a level at each location that holds it:
  `on_hand`, `committed` (placed orders not yet fulfilled), `reserved` (checkouts in progress) and
  `safety_stock` (kept back). `available = on_hand − committed − reserved − safety_stock`, a
  generated column. What sells online is what is available at active locations that fulfil
  online orders.
* **Tracking starts with the first stock.** A variant whose stock was never recorded has no item
  row: it is not tracked, and always sells. Setting or adjusting its stock creates the item,
  tracked, and records `inventory_item.updated`. `inventoryPolicy: CONTINUE` keeps selling at
  zero, and available goes negative.
* **Merchants and apps** set quantities after a stock count (`inventorySetQuantities`) or adjust
  them (`inventoryAdjustQuantities`), with a reason from a fixed list such as `received` or
  `damaged`.
  * A set can carry a `compareQuantity`; if the level changed since it was read, it fails with
    `STALE`.
  * All changes in a request apply, or none. Removing more than is on hand is refused.
* **Checkouts and orders** use `StockService` inside their own transaction: `reserve`,
  `releaseReservation`, `commit` (from a reservation, or not), `releaseCommitment` and
  `fulfill`. Reserving and committing return shortages rather than oversell.
* **One write path.** Every change locks the levels it touches in (variant, location) order,
  checks the whole change against the locked quantities, then writes. One statement updates the
  levels and records the adjustment and a movement per quantity changed; then
  `inventory_level.updated` is recorded for each level.
* **The ledger is append-only.** Request code can add to `inventory.adjustments` (why, what caused
  it, who) and `inventory.movements` (each quantity's change and its value after), never change
  or delete them. `InventoryItem.changes` reads it newest first.
* **Locations.**
  * A shop's first location, added or created as "Main location" when first needed, is primary.
    The primary cannot be deactivated or deleted.
  * Deactivating needs an empty location, and waits for any sale in progress there. Only a
    location that never held stock can be deleted.
  * Addresses are Pakistani: the province by code, name or alias ("KPK"), known cities spelled the
    standard way ("lhr" is Lahore), five-digit postcodes, and mobile numbers stored in E.164.

## Orders

* **Four statuses, one stage.** An order has a `status` (open, closed, cancelled), a
  `confirmationStatus` for cash on delivery, a `financialStatus` and a `fulfillmentStatus`, as in
  [03 · Data](../architecture/03-multi-tenancy-and-data.md#61-order-status-model). Its `stage`
  is the one state merchants see (needs confirmation, to pack, to book, in transit, …). It is
  derived from the statuses by `stageOf()`, stored, and recomputed by every change, so the order
  list filters and counts by it with an index.
* **An order exists only if its stock does.** Placing an order commits its stock at its location
  through `StockService`, in the same transaction; short stock is an `OUT_OF_STOCK` user error
  and nothing is written. Cancelling releases the stock.
* **Numbers** run from #1001 per shop, without gaps. An order takes its number last in its
  transaction, from a counter row, so the row stays locked only briefly and a failed order gives
  its number back.
* **Lines are snapshots.** A line keeps the product and variant titles, SKU and price it was sold
  at, and has no foreign key to the catalog. The shipping address is a snapshot too; edits
  replace the whole address, and only until something ships.
* **Every change** locks the order row, bumps its `version`, adds a line to its timeline
  (`orders.order_events`, append-only) and records an `order.*` event with the stage and version.
* **Addresses** are Pakistani, as for locations. The customer's mobile number is required, since
  couriers and confirmation use it; most staff roles see it masked (see "Who sees customers'
  numbers" below).
* **Search** takes an order number (`1001` or `#1001`), a mobile number in any format, a
  parcel's tracking number, or words of the customer's name, city or email.
* **Parcels** (`orders.fulfillments`) ship items of a confirmed or prepaid order; cash-on-delivery
  orders are never shipped unconfirmed. Shipping takes the items out of stock through
  `StockService.fulfill`. A parcel is `in_transit`, then `delivered`, or `returning` when refused
  or undeliverable (return to origin), then `returned` once checked back in. Checking in says how
  many of each line go back on the shelf (`StockService.restock`); the rest are written off.
* **The stage follows the parcels.** `updateOrder()` recomputes the fulfillment status and stage
  from them on every change. An order closes when it is delivered and paid (`completed`) or every
  parcel came back (`returned`); a cash-on-delivery order that came back unpaid is `voided`.
  Closed orders take no more payments or parcels.
* **Packing is a step, not a gate.** A confirmed or paid order waits in `to_pack`;
  `markPacked` stamps `packedAt` and moves it to `to_book`, ready for a courier, and
  `markUnpacked` takes a mistake back. Shipping does not need it: an order ships from either
  stage, and once something has shipped it can be neither packed nor unpacked. A packed order
  that is cancelled keeps its `packedAt`, as history.
* **Bulk actions** (`orderBulkConfirm`, `orderBulkCancel`, `orderBulkMarkPacked`,
  `orderBulkAddTags`, `orderBulkRemoveTags`) take up to 250 IDs and change each order in its own
  transaction, exactly as the single action does, with its own timeline entry and event: one that
  fails leaves the others done. The payload lists the orders changed and a user error per order
  that failed, with the field `["ids", index]`. An ID given twice counts once; a malformed one
  fails the whole request, as it does elsewhere. Tags are matched ignoring case, and an order
  that has them already is left as it is, with no new version.
* **Refunds record money staff sent back**
  ([ADR-029](../architecture/13-decision-log.md#adr-029--refunds-record-money-staff-sent-back-only-owners-and-managers-make-them)):
  `orderRefund` takes an amount, a method (bank transfer, mobile wallet, cash or other) and an
  optional reference and note. An order keeps `amountPaid`, what was received, which refunds
  never lower, and `amountRefunded`, which never exceeds it; its financial status becomes
  `refunded` or `partially_refunded`. Refunds move no stock and no stage: a completed order stays
  completed, and closed and cancelled orders take refunds too. What customers have spent counts
  refunds out. Only owners and managers refund, besides apps; other staff roles get
  `ACCESS_DENIED`.
* **Exports** (`ordersExport`) give up to 10,000 orders as CSV, oldest first, with the list's
  filters (`query`, `stage`, `riskLevel`, and `placedFrom` and `placedBefore`, which the list
  takes too): a row per order, or a row per line item. The file is UTF-8 with a byte-order mark,
  for Excel; amounts are in major units and times in the shop time zone. Numbers are masked as
  the caller sees them, every row has a watermark naming who exported it and when, and each
  export goes into the audit log. Staff need to be an owner, a manager or an accountant; a
  marketer's export would need an approval flow that is not built yet.
* **No order collects more cash on delivery than the law allows**
  ([ADR-058](../architecture/13-decision-log.md#adr-058--no-order-collects-more-cash-on-delivery-than-the-law-allows-whoever-places-it-the-rest-is-paid-in-advance-or-the-order-is-not-placed)):
  `codLimitError` checks the cash at the door, the total less any advance, against
  `COD_CASH_LIMIT` for orders in rupees, in `placeIn` and when a draft is saved, and answers
  `COD_LIMIT` on `advancePaid` with the advance that would do. A new way of placing orders goes
  through `placeIn`, which checks it; the limit changes only with the law.
* **An order its customer placed keeps what they agreed to**
  ([ADR-057](../architecture/13-decision-log.md#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)):
  `OrderToPlace.agreement` gives the versions of the shop's policies they agreed to, and their
  address and browser, which `placeIn` keeps only if the address is one, and the browser's name
  without control characters, cut to 512 characters. Orders staff and apps place have none. The
  address and browser are shown only to those who see numbers whole, and erasure clears them;
  the versions stay. A new way for customers to place orders, such as a draft's link, passes
  what its page linked.
* **The admin's home is the core's** (`home`, ANL-01): `HomeResolver` asks each module for what
  waits on the shop in its part. The orders module's part is `OrderService.home`, one aggregate
  over the stage index: how many orders, and what they come to, at each stage that waits on
  staff, and the cash on delivery still to come, `total - amount_paid` on parcels on their way
  and on delivered orders. The tallies are worked out when asked, as the stage counts are, and
  stored nowhere. The home needs `read_orders`, which every staff role has; another module's
  figure, such as low stock, joins `Home` in the core as a tally of its own.

## Draft orders

* **Drafts are orders taken in a chat before they are placed**
  ([ADR-031](../architecture/13-decision-log.md#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link)),
  numbered #D1 onwards per shop, apart from orders. Each line keeps the price agreed: the price
  given, or the variant's price when the line was added. Drafts hold no stock.
* **The address can come later.** A draft has the customer's number and address both or
  neither, and needs them to be placed, but not to be sent: the link's page asks the customer
  for both. Drafts name no customer: the order a draft becomes finds or creates one, as any order
  does.
* **`draftOrderUpdate` changes only the fields given.** `lineItems` replaces the lines, priced
  again; null clears the address, email, amounts, location, note or tags, and leaves the source
  and payment method as they are. A completed draft does not change; its order does.
* **A draft is placed through `OrderService.placeIn`**, the code `orderCreate` runs, at the
  draft's prices and with its source (`WHATSAPP`, `INSTAGRAM`, `FACEBOOK`, `MANUAL` or `API`).
  Stock is checked then. An order that cannot be placed leaves the draft open, with user errors
  pointing at the draft's own fields (`["lineItems", "0", "quantity"]`). Completing a completed
  draft changes nothing.
* **A link lets the customer confirm a cash-on-delivery draft themselves.**
  `draftOrderLinkCreate` returns the link's URL once, and a WhatsApp link carrying it: to the
  customer's number for callers who see numbers whole, and to a chat of the sender's choosing
  for the rest. A new link replaces the old one, and a draft that becomes prepaid loses its link.
  When the customer confirms, the system places the order, confirmed unless it is held for
  review.
* **On a draft's link, the customer adds or corrects the address**
  ([ADR-034](../architecture/13-decision-log.md#adr-034--customers-add-a-drafts-address-and-their-number-while-it-has-none-through-its-link)),
  on the order links' form (`?address`), which also asks for their number while the draft has
  none; once it has one, it is shown masked and is the shop's to change. `draft_order.updated`
  then says `byCustomer`. Once the draft is an order, the same link corrects the order's address
  until it is packed, through `changeAddressLocked`, as an order's link does.

## Order links

* **An open order can get a link for its customer**
  ([ADR-032](../architecture/13-decision-log.md#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order)):
  `orderLinkCreate` returns its URL once, with a WhatsApp link carrying it, as for drafts. A new
  link replaces the old one; making one goes on the order's timeline; erasing the customer's
  details takes the link.
* **An order's link lasts until 30 days after the order ends**
  ([ADR-038](../architecture/13-decision-log.md#adr-038--an-orders-link-lasts-until-30-days-after-the-order-ends)),
  unless it was made to expire after some hours. `orderLinkExpiry` works out when it stops,
  from the order; check it, not `link_expires_at`, which is null for a link that lasts.
* **While a cash-on-delivery order waits for its customer** (`awaitsCustomer`: open, pending or
  no response, nothing shipped), its page offers to confirm or cancel it. Cancelling asks first
  (`?cancel`). The customer's cancellation gives the reason `customer`, records the
  confirmation as `rejected` and releases the stock. Both run the order service's
  `confirmLocked` and `cancelLocked`, the code behind `orderConfirm` and `orderCancel`, with the
  system as the actor.
* **After that, the page follows the order** through its stage, with the courier and tracking
  number while it travels. Staff decide what happens to an order that no longer waits for its
  customer: a customer who tries to cancel one is told to ask the shop.
* **Until the order is packed, the customer can correct its address**
  ([ADR-033](../architecture/13-decision-log.md#adr-033--customers-correct-an-orders-address-through-its-link-until-it-is-packed-the-number-stays-the-shops)),
  on a page of its own (`?address`; `addressChangeable` says whether it still can). Everything
  but the number: the page never shows that whole, and a new number is for staff. Saving runs
  `checkAddress` and `updateLocked`, the code behind `orderUpdate`, so the order is scored again
  and may be held for review, and a confirmed order stays confirmed. It then redirects to
  `?saved`, which says so.

## Public pages

* **Pages for customers, such as drafts' and orders' links, are served beside the Admin API, not
  in it**, at paths such as `/d/<secret>` and `/o/<secret>` under the configured `PUBLIC_URL`. They have no session: a
  secret in the path is the only credential. Make secrets with `secretToken` from
  `@hatti/crypto` (16 bytes, 128 bits, for links), keep only their `sha256`, and find their shop
  through a `SECURITY DEFINER` function, since row-level security shows nothing until the shop is
  known.
* **Build them with `renderPage` from `@hatti/documents`** and `html```, as documents are: one
  column for phones, English then Urdu, and numbers, amounts and dates inside Urdu sentences
  wrapped in `ltr()`, or the text around them reorders their parts. Send the content security
  policy that `renderPage` returns, which allows its own styles by hash, and never add scripts or
  `style` attributes.
* **Send them never cached, indexed or framed, and without a referrer:** `Cache-Control:
  no-store`, `X-Robots-Tag: noindex`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`,
  since the address holds the secret and the fonts come from Google.
* **Only a POST changes anything**, and it carries what it asks for in a hidden field
  (`action`) and a digest of what the page showed (`shown`, from `shownDigest`: the items, the
  amounts and the address, with the number masked, so the digest gives nothing more away). Link
  previews and scanners that fetch the page then change nothing, and a change the customer could
  see since the page was shown is shown again rather than acted on; notes and tags do not count.
  A POST that succeeds redirects to the page with `303`, so reloading does not post again. A
  question before an action that cannot be undone, such as cancelling, is a GET page of its own,
  and so is a form, such as a new address.
* **Forms say what is wrong under each field, in both languages**, and keep what the customer
  typed; the page is sent with `422`. Mark fields with `aria-invalid` and `aria-describedby`,
  required ones with `aria-required` rather than `required`, so the browser's own message, in
  its own language, never comes first. Give boxes `autocomplete` names (`shipping
  address-line1`) and `dir="auto"`, since people type addresses in Urdu too.
* **Show the customer what they need and no more:** their number masked, the address to check,
  and nothing of the order once the link has expired.

## Storefront themes

* **Themes are Shopify's shape**
  ([ADR-035](../architecture/13-decision-log.md#adr-035--the-storefront-renders-liquid-with-limits-of-its-own-fetching-lists-a-chunk-at-a-time)):
  `layout/`, JSON `templates/`, `sections/` with a `{% schema %}`, section groups
  (`sections/header-group.json`), `snippets/`, `config/` and `locales/`. The renderer supports
  Shopify's common tags, filters and objects, and Hatti's own: `money_pk`, `whatsapp_url`,
  `direction` and `cod`. Add a Shopify one as a tag or filter in `apps/storefront/src/liquid.ts`
  when a theme needs it.
* **Output is not escaped for a theme**: print shops' and shoppers' text with `| escape`, the
  page's title too. Theme strings (`t`) escape themselves as Shopify's do: a string is text unless
  its key ends in `_html`, and the values that fill it are escaped either way. `whatsapp_url`
  reads its message back as text, so a theme string can be a WhatsApp message.
* **Templates see plain objects**, made from read models in `objects.ts`, and LiquidJS runs with
  `ownPropertyOnly`. Use a drop only for lookups by name or lists fetched on first touch, and keep
  its state in private (`#`) fields: templates can reach a drop's methods.
* **Never fetch per item.** A list fetches its products a chunk at a time, when a template first
  touches one; a new kind of list does the same. Ask for what a page will certainly need before
  rendering it.
* **`{% paginate %}` pages any list whose owner says how long it is and can fetch a window of
  it**: `collection.products` with `products_count`, `search.results` with `results_count`, each
  answering `PAGINATE`. Its links keep the page's query, but for `page`, so a search's pages
  keep `q`; build them with `URLSearchParams`, never by joining strings.
* **Every render has limits** (`limits.ts`): nodes, time, output, memory and snippet depth. A
  section over one is left out and reported through `onError`. Test a new limit with a template
  that goes over it. A render that waits for others, as the layout waits for sections, waits
  through `WorkLimiter.waitFor`, so that the wait is not counted against its time.
* **The cart page alone shows the shopper's cart** (`PageRequest.cart`), and sections rendered
  for scripts, which are sent `private, no-store`. Every other page is the same for everyone, so
  that the edge can cache it: the header's count comes from the `cart_count` cookie, through the
  header's script, and the drawer comes empty until its script asks for its section. Put nothing
  of a shopper's on other pages.
* **Sections render for scripts as Shopify's section rendering API has them**: `?section_id=`
  (HTML) and `?sections=` (JSON, up to five) on a page, and `sections` on the Ajax cart's
  answers, rendered as part of `sections_url` or the page that asked. A section's styles are not
  sent with it: styles a section shares with others go in `assets/base.css`, as the cart's lines
  do, which the cart page and the drawer both show through the `cart-item` and `cart-totals`
  snippets.
* **`routes` follow the page's language**: `/ur/cart` on Urdu pages. Link with `routes.*`;
  `{% form 'product' %}` and `{% form 'cart' %}` post to them.
* **Pages stream** (`PageRenderer.stream`): the head goes before the sections finish, so what it
  holds must be known before they render, as sections' styles are, from the page's plan. Once
  the page is under way its status cannot change: decide it, as a 404, before streaming.
* **Themes style with logical properties** (`margin-inline-start`, not `margin-left`), so Urdu
  pages mirror by themselves, and put `dir="auto"` on elements holding merchants' text, which may
  be English on an Urdu page. Images go through `image_url` and `image_tag`, which give them
  their size and a `srcset`.

## Storefront documents

* **The storefront reads only documents in Valkey** (`@hatti/storefront-data`), never the
  database
  ([ADR-036](../architecture/13-decision-log.md#adr-036--one-publisher-per-shop-rebuilds-storefront-documents-from-the-database-its-writes-fenced-by-its-lock)).
  The core's worker writes them: `StorefrontPublisher` in `apps/core/src/storefront` handles
  catalog and stock events.
* **A document holds only what a theme may show**: no costs, barcodes or stock counts. Prices are
  in paisa; descriptions are plain text made safe by `textToHtml`.
* **An event marks items stale; it never carries the document.** To make an event rebuild
  something, map it in `itemsFor` and test the rule beside the others. A new kind of document
  needs an item, a step in the publisher's build, and a priority before whatever lists it.
* **Write through the `ShopWriter` a drain hands you**, never with a plain `SET`: its scripts
  check the shop's lock, keep handles right, and write each call atomically.
* **One round trip per document or list**, as `RedisStore` reads them; tests count round trips.
  Tests use a `StorefrontKeys` prefix of their own and clear it after.
* **Raise `DOCUMENTS_VERSION` when documents gain or change a field.** The publisher publishes a
  shop whose documents are older whole on its next event; until then the storefront reads the
  older shape, so a new field needs a default there (a shop's document without `theme` shows the
  platform theme). A document kept under a new key is not there at all until then: before
  launch, publish every shop again (`publishAll`); after it, a key move needs a sweep that does.
* **Build documents the same way each time**, keys in the same order: the publisher purges the
  edge's pages only for documents whose JSON differs from what was stored
  ([ADR-047](../architecture/13-decision-log.md#adr-047--the-edge-keeps-storefront-pages-by-the-handles-they-name-before-they-stream-and-forgets-those-whose-documents-change)).
  A document others show part of, as a collection's pages show products' cards, is purged with
  them: `#products` purges the collections that hold a product.
* **Pages are kept at the edge unless their handler says otherwise** (`sendPage`): five minutes,
  tagged with the shop and the handles the page names (`PageStream.named`). A handler whose
  answer holds anything of a shopper's sets `private, no-store` first, as the cart's does;
  refusals and errors set `no-store`. An answer that sets a cookie is never kept, whatever its
  handler set: an `onSend` hook makes it `private, no-store` and drops its tags. A new setting
  type that names a document by its handle joins `NAMING` in `render.ts`, so its pages are tagged
  with it.
* **A storefront finds its shop by the request's host**, `{handle}.{platform domain}`, in the
  `ShopDirectory` the publisher keeps for open shops
  ([ADR-037](../architecture/13-decision-log.md#adr-037--every-shop-has-a-handle-naming-its-storefront-on-the-platforms-domain-storefronts-find-shops-through-a-directory-in-valkey)),
  or as a domain of the shop's own, in the directory's domains ([ADR-048](../architecture/13-decision-log.md#adr-048--a-shops-own-domains-are-the-online-stores-one-shops-each-served-once-dns-points-them-at-the-platform-the-primary-one-where-pages-send-shoppers)). A shop's
  handle comes from the control plane (the seed stands in for it) and request code never changes
  it; the Admin API's `StorefrontSite` turns it, or the shop's primary domain, into the
  storefront's address.
* **Search engines and link previews get absolute addresses at the shop's own** ([ADR-051](../architecture/13-decision-log.md#adr-051--search-engines-and-link-previews-are-told-each-pages-address-at-the-shops-own-in-each-language-and-find-pages-through-sitemaps-of-the-storefronts-documents)):
  `shop.url` is the shop's primary domain or handle's subdomain with the platform's scheme and
  port (`RendererOptions.platformUrl`), and `canonical_url` a page's path there in its language.
  A theme's link-preview tags and anything else read off the page use them, never the host asked
  for. `json` and `structured_data` output is safe inside `<script>`: use them, not `| escape`, for
  JSON in a page (`scriptJson` in code).
* **Sitemaps and robots.txt come from the documents** (`sitemap.ts`), through
  `StoreData.handles`: a new kind of document the storefront shows joins `SITEMAP_KINDS`, and a new
  route that crawlers should skip joins `robotsTxt`. A shop's own rules
  ([ADR-055](../architecture/13-decision-log.md#adr-055--a-shop-adds-rules-to-its-robotstxt-as-lines-crawlers-read-checked-when-saved-never-liquid))
  are checked by `robotsRules` in the online store and served as they were kept: a directive the
  storefront should take from shops joins both.
* **A shop closed behind its password answers only on its open routes**
  ([ADR-054](../architecture/13-decision-log.md#adr-054--a-shops-storefront-can-be-closed-behind-a-password-which-the-storefront-checks-against-a-verifier-in-the-shops-document)):
  a `preHandler` hook sends shoppers without the pass to `/password` and tells scripts 401, before
  any handler runs, and `onSend` makes every answer of a closed shop `private, no-store` and
  `noindex`. A new route that shows the shop's pages or data needs nothing more; one every
  visitor needs, as theme assets do, joins `OPEN_ROUTES`. `shopFor` and `lockOf` are worked out
  once a request, and the stores fetch the shop's document once, so the gate costs no round trip.
* **Pages go on to the shop's primary domain, or where its redirects point; nothing else
  does.** `sendPage` sends a page asked for at another of the shop's addresses on with a 301
  (given the request as `asked`), from its handle's subdomain or another of its domains, before
  it renders. A cart change, a script's request, a checkout or a preview answers where it is
  asked: a shopper's cart lives on the host it began on.
* **A redirect is followed only where the page would be 404** ([ADR-052](../architecture/13-decision-log.md#adr-052--a-shops-url-redirects-are-the-online-stores-and-the-storefront-follows-one-only-where-it-has-no-page)):
  `sendPage` looks the path up (`StoreData.redirect`) once the renderer's `prepare` says nothing
  is there, never before, so a redirect costs nothing on pages that exist and never hides one.
  `redirectedTo` keeps the shopper's language and query. A 404 page and a redirect carry the
  path's tag (`pathTag`), which the publisher purges when a redirect from the path changes.
* **The storefront renders policies itself, not the theme**
  ([ADR-056](../architecture/13-decision-log.md#adr-056--a-shops-policies-are-kept-as-shopify-keeps-them-shown-in-shopifys-markup-and-drafted-from-what-the-shop-has-set-never-saved-by-themselves)):
  `/policies/{handle}` gives the layout `policyMarkup`, Shopify's `.shopify-policy__container`, as
  a template's sections would be, and `shop.policies` lists those the shop's document names. Their
  bodies are kept apart (`StoreData.policy`) and fetched for their own pages alone; the publisher
  writes them whole and purges the shop's pages when one differs.

## Online store themes, menus, pages, preferences, domains, redirects and policies

* **A shop's domains are one shop's each across the platform** ([ADR-048](../architecture/13-decision-log.md#adr-048--a-shops-own-domains-are-the-online-stores-one-shops-each-served-once-dns-points-them-at-the-platform-the-primary-one-where-pages-send-shoppers)): the unique
  index on `online_store.domains (host)` sees every shop's rows, so `domainCreate` answers
  `TAKEN` whichever shop has it. Keep hosts as `hostOf` gives them: lowercase, `xn--` for
  internationalised names, without a scheme, port or final dot.
* **DNS is asked through `DnsLookup`**, outside the database transaction, which the host
  application provides and tests replace (`TestDns`). A domain is verified by a CNAME naming the
  DNS target, or by addresses all among the target's, and only a verified domain is primary.
* **A redirect's path is kept as the storefront looks it up** ([ADR-052](../architecture/13-decision-log.md#adr-052--a-shops-url-redirects-are-the-online-stores-and-the-storefront-follows-one-only-where-it-has-no-page)):
  `redirectPath` in the online store and `redirectKey` in `@hatti/storefront-data` give the same
  form, decoded, lowercase, without repeated or trailing slashes; change them together, with
  their tests. The online store also drops the query and `/ur`, and takes whole addresses. What
  Postgres or a header would refuse, control characters and halves of characters, is refused as
  typed. Redirects use the navigation scopes, as Shopify's do.
* **The publisher writes a shop's redirects whole but sends only what differs**
  (`ShopWriter.putRedirects`), from `shopRedirectsOf(tx, …)`, and purges the tags of the paths
  whose redirects changed, or the shop's past `REDIRECT_PURGE_LIMIT`.
* **A change of handle takes `redirectNewHandle`**, as Shopify's does
  ([ADR-053](../architecture/13-decision-log.md#adr-053--a-handle-change-asks-for-its-redirect-as-shopifys-redirectnewhandle-does-and-the-redirect-leads-to-where-the-page-is-now)):
  a resource the storefront shows at `/{kind}/{handle}` that gains a handle names the old one in
  its update event (`previousHandle`, with `redirectNewHandle` when asked), and the redirect is
  written through `redirectMoved(tx, …)`: in the change's transaction inside the online store, by
  the worker's `HandleRedirects` for the catalog. A handler like it reads where the resource is
  now rather than trusting the event, since events can be handled late and out of order.

* **A shop's theme is a platform theme with the shop's own JSON files over it**
  ([ADR-039](../architecture/13-decision-log.md#adr-039--a-shops-theme-is-a-platform-theme-with-the-shops-own-json-files-over-it)):
  templates, section groups and `config/settings_data.json`, which `isThemeFilename` names.
  Nothing a shop saves is Liquid, an asset or a translation.
* **A file is checked twice when it is saved.** `checkThemeFile` checks its shape; then Theme
  Check (`checkShopFile`, in `@hatti/themes`) reads it over the platform theme as the storefront
  would: the sections, blocks and settings it names, blocks' limits and settings' types. Each
  problem is a user error on the file's `body`, its message starting with the file's name.
* **How the storefront reads a theme lives in `@hatti/themes`**, which the core's Theme Check
  shares: loading a theme, laying a shop's files over the platform theme, and settings' types.
  A new rule there needs a Theme Check test, so the core refuses what the storefront would leave
  out. The renderer keeps Liquid and its limits.
* **Every change to a theme raises its version** and records `theme.updated`, with the files
  that changed and the theme's role; publishing records `theme.published`. The main theme is
  made on first use (`ensureMainTheme`), as a shop's first location is.
* Read models get the main theme and its files through `ThemeService.mainOf(tx, …)`.
* **The storefront shows the main theme from a document of its own**, which the publisher's
  `shop` item writes before the shop's document, which names its version. Theme events that
  change what shows, `theme.updated` for the main theme and `theme.published`, mark `shop` stale.
* **Shops' settings reach templates only as their schema's types** (`resolveSettings`): colours,
  numbers within their range, true or false, a select's options, links that are paths or web,
  mail or phone addresses, and images at such addresses. Anything else gives way to the
  setting's default, and settings the schema does not have are dropped. Print text settings with
  `| escape`; a section that prints a `richtext` or `html` setting as it is needs a sanitiser
  first. Section and block IDs are letters, digits, `_` and `-`, in the core and the storefront.
* **The storefront lays each version over the platform theme once** (`overlayTheme`), and
  `ShopThemes` keeps it per shop and version, up to 64 MB of shops' files, letting the least
  recently used go first. A file it cannot use is left out, the platform theme's shows instead,
  and `onThemeFileRejected` hears why; the shop's other files still apply. A theme document of
  another version than the shop's names is shown, but not kept.
* **A theme is previewed through a link the core seals** ([ADR-049](../architecture/13-decision-log.md#adr-049--a-theme-is-previewed-through-a-link-the-core-seals-which-storefronts-keep-in-a-cookie-and-render-from-the-cores-files-never-kept)):
  `ThemePreviewService` seals the theme's ID and when the link ends with the secret box, bound
  to the shop (`theme-preview:{shop}`), and opens it again when a storefront hands it back;
  nothing is stored. Previews read the theme's files as saved, through `ThemeService.themeOf`,
  not the published documents, so the editor sees what it just saved.
* **The storefront keeps a preview in the `hatti_preview` cookie** and asks the core for it on
  each request (`previewFor`): the theme it shows is `Found.preview`, which `themeFor` gives every
  render, pages, sections and suggestions alike. A previewed answer is `private, no-store` and
  `noindex` (`previewed`), carries no cache tags and is not sent on to the primary domain. A core
  that cannot be reached leaves the page in the main theme; it never fails the page.
* **A preview the theme editor frames is in design mode** ([ADR-050](../architecture/13-decision-log.md#adr-050--the-theme-editor-talks-to-its-preview-through-postmessage-a-framed-preview-is-in-design-mode-and-renders-sections-with-the-editors-unsaved-files)):
  `Found.editor`, from `Sec-Fetch-Dest: iframe` and `editorOrigins`, gives the render
  `PageRequest.editor`. The renderer then marks each section's wrapper with
  `data-hatti-editor-section` (its ID, type, and the file and key its settings are under) and
  gives blocks' `shopify_attributes` as `data-hatti-editor-block`; elsewhere they are empty, as
  on Shopify. A new section in a theme puts `{{ block.shopify_attributes }}` on each block's
  outermost element, wrapping a block of several elements in one.
* **The editor's protocol lives in `editor.ts`**: the script a design-mode page carries, the
  messages it and the editor send each other, and the events themes hear. A change to a message
  is a change to the protocol the editor relies on: keep old messages working. The script hears
  only the configured origins, and `POST /editor/sections` renders unsaved files only for it: a
  preview, the `x-hatti-editor` header, and no cross-site request.
* **Theme scripts let go of what they hold outside their section** when it is disconnected, since
  the editor renders sections again: listeners on `document` or `window` take an
  `AbortController`'s signal, aborted in `disconnectedCallback`, as Hatti Base's cart drawer does.
* **A menu is saved whole**, as Shopify's `menuUpdate` does: its items are one JSON tree, three
  levels deep
  ([ADR-040](../architecture/13-decision-log.md#adr-040--a-shops-menus-are-kept-whole-linking-to-collections-and-products-by-id)).
  Links to collections and products keep their IDs and take their handles when read; read models
  get them through `MenuService.menusOf(tx, …)`, with `shown` false for what the storefront cannot
  show. The main and footer menus are made on first use, from what the storefront showed; until
  then `menusOf` makes them as it reads.
* **A new kind of link** (blogs, search) needs its page on the storefront first, then its type in
  `menu-items.ts` and the address `MenuService` gives it, as pages have.
* **A page's body is HTML cleaned when it is saved** (`cleanPageBody`, in `page-body.ts`,
  [ADR-045](../architecture/13-decision-log.md#adr-045--a-shops-pages-keep-html-cleaned-of-anything-that-runs-when-saved-the-storefront-shows-it-as-it-is)), and nothing else ever cleans it: the publisher writes it as kept, and themes print
  `page.content` as it is. What may stay (tags, attributes, schemes, styles) is a security
  decision: widening it needs a test of what it lets through and what it still takes out, in
  `page-body.test.ts`. Handles are made as the catalog makes them (`toHandle`), and a page is
  shown while `published_at` is set.
* **Read models get pages through `PageService.pagesOf(tx, …)`**; menus read the handles and
  whether pages are published themselves, without their bodies. A page's `page.updated` names
  the fields that changed, and the publisher rebuilds the menus only when its handle or whether
  it shows did.
* **A storefront's password is kept sealed and verified, never in the clear**
  ([ADR-054](../architecture/13-decision-log.md#adr-054--a-shops-storefront-can-be-closed-behind-a-password-which-the-storefront-checks-against-a-verifier-in-the-shops-document)):
  `PreferencesService` seals it with the secret box (bound to `storefront-password:{shop}`), so
  staff can see it again, and keeps a scrypt verifier (`passwordVerifier` in `@hatti/crypto`) for
  the storefront; read models get only the verifier, through `shopPreferencesOf(tx, …)`. The
  same password saved again keeps its verifier, and the passes shoppers hold.
* **What a shop sets for its storefront as a whole is a preference** (`PreferencesService`,
  [ADR-041](../architecture/13-decision-log.md#adr-041--what-a-shop-sets-for-its-storefront-as-a-whole-is-the-online-stores-starting-with-its-whatsapp-number)), such as its WhatsApp number, kept in E.164. A new one is a column
  of `online_store.preferences`, a field of its input and of the shop's document if the storefront
  shows it; it records `online_store_preferences.updated`, naming what changed.
* **A shop's policies are kept as Shopify keeps them**
  ([ADR-056](../architecture/13-decision-log.md#adr-056--a-shops-policies-are-kept-as-shopify-keeps-them-shown-in-shopifys-markup-and-drafted-from-what-the-shop-has-set-never-saved-by-themselves)):
  one of each of `POLICY_TYPES`, their bodies cleaned by `cleanPageBody` as pages' are, and one
  given a blank body taken away (`PolicyService.update`). Their titles and handles are in
  `policy-types.ts` and, for the storefront, in its `policies.ts`, in English and Urdu: a new type
  joins both, and `ShopPolicyType`, whose values are Shopify's. They use the legal policies scopes,
  as Shopify's do.
* **Every body a policy is saved with is a version, kept as it was**
  ([ADR-057](../architecture/13-decision-log.md#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)):
  `PolicyService.update` writes one for each change, and the policy names its current one.
  Request code can neither change nor delete versions; orders name them, and
  `PolicyService.versions` reads them back for the Admin API.
* **Drafts are written, never saved** (`policyDraft`, in `policy-drafts.ts`): from `PolicyFacts`,
  which the core gathers from what the shop has set, in English and Urdu, what the shop typed
  escaped and, in Urdu, numbers and addresses kept left to right (`<span dir="ltr">`). A draft's
  promises become the shop's when it saves one: keep them to Pakistan's usual cash-on-delivery
  terms, and a new fact to something the shop has set.

## Carts

* **A cart keeps variants, quantities and what the shopper typed; never prices or titles**
  ([ADR-042](../architecture/13-decision-log.md#adr-042--carts-are-kept-by-the-core-and-priced-whenever-they-are-read-storefronts-change-them-with-a-key-of-their-own)).
  `CartService` reads them in its transaction whenever a cart is read or changed, through the
  catalog's `VariantService.snapshotsOf` and inventory's `InventoryService.sellableOf`. Checkout
  prices again; nothing may trust a price a cart once showed.
* **Carts behave as Shopify's do**, so themes' cart code works unchanged: the rules are in
  `applyAction` (`cart-lines.ts`), each with a test in `cart-lines.test.ts`. A change is refused
  whole, and only for what it adds: a line whose stock ran out can always go down.
* **The routes under `/storefront/` are for storefronts only.** `storefrontApiAuthentication`
  checks the platform's storefront key before any of them runs, and they trust the shop the
  storefront names. What the two say is in `@hatti/storefront-api`: change a shape there, and
  both sides with it.
* **Refusals are codes with their facts** (`MAX_QUANTITY` with the most that can be bought), not
  sentences: the storefront words them in the shopper's language. `INVALID` is for requests the
  storefront should not have made.
* **A cart's secret is a credential**, as a link's is: the core keeps its SHA-256 and never logs
  it. A secret naming no cart is never taken up; the next change makes a new cart.
* **The storefront turns Shopify's cart forms and Ajax calls into the core's actions**
  (`apps/storefront/src/cart.ts`): parameters as Rails reads them (`items[][id]`, `updates[]`,
  `properties[Name]`), and refusals worded from the theme's `cart.errors.*` strings, in English
  when a theme has none. A script (`.js`, `Accept: application/json` or `X-Requested-With`) gets
  Shopify's JSON; a form goes back to the cart page.
* **What delivery costs is `deliveryCharge(settings, city, subtotal)`** (`delivery.ts`,
  [ADR-043](../architecture/13-decision-log.md#adr-043--a-shop-charges-for-delivery-once-for-everywhere-by-zones-of-cities-and-not-at-all-from-a-subtotal)): checkout adds it, and themes see the
  same settings as Hatti's `delivery` (`charge`, `free_above`, `zones`), so pages can say what an
  order will cost. Zones name cities as `@hatti/pk` spells them, each in one zone.
* **The cart's secret is an `HttpOnly` cookie**; its count, which scripts may read, is another.
  Changes from other sites are refused (`Sec-Fetch-Site: cross-site`), and an address may make
  120 a minute.

## Checkout

* **Checkout places orders through the orders module** (`OrderService.placeIn`, in checkout's
  transaction), never writing orders' tables itself
  ([ADR-044](../architecture/13-decision-log.md#adr-044--checkout-is-one-page-the-core-renders-and-storefronts-serve-on-the-shops-address-placing-a-cash-on-delivery-order-as-the-page-showed-it)). What
  orders check (the address, stock, the blocklist, the risk score) holds for checkout's orders as
  for any. A new way to pay is a `paymentMethod` of orders first.
* **The order is what the page showed.** Its form carries `shownOf(cart, delivery)`, a digest of
  the lines with their prices, the note and the delivery charges; `place` works it out again
  under the checkout's and the cart's locks and places nothing when it differs. Whatever else
  comes to change what an order costs, such as a discount or the COD fee, goes into the digest.
* **Nothing the shopper types is kept until the order has it**: a checkout's row holds its
  secret's digest, its cart and its order. A post that places nothing shows the page again from
  the post itself, saying why: 409 when the cart or charges changed or something sold out, 422
  for the shopper's details.
* **The page is the core's; the address is the shop's.** `checkoutPage(view)` renders it with
  `@hatti/documents`, in both languages and without scripts. `CheckoutController` serves it at
  `/checkouts/{secret}`, and `StorefrontCheckoutController` gives it to storefronts as JSON with
  the headers to send it with, for their own shop's checkouts. The storefront sends it as it
  comes, adding only the count cookie once the order is placed.
* **A post that places the order answers 303 to the page**, by a relative address that works on
  the core's and the shop's alike, so reloading it posts nothing.
* **The cart form's `checkout` button saves the cart's changes first**, then starts a checkout;
  `/checkout` starts one for the cart as it is. Either goes back to the cart when it has nothing
  to order.
* **Lines' properties go in the order's note** (`orderNoteOf`) until orders keep them; those
  whose names start with `_` are for apps, and left out, as on Shopify.
* **The page links the shop's policies at its foot**, as Shopify's checkout does
  ([ADR-056](../architecture/13-decision-log.md#adr-056--a-shops-policies-are-kept-as-shopify-keeps-them-shown-in-shopifys-markup-and-drafted-from-what-the-shop-has-set-never-saved-by-themselves)):
  `CheckoutShop.policies`, from the online store's `shopPolicyVersionsOf(tx, …)`, which reads
  their kinds and current versions without their bodies. The links open in a new tab: the page
  has no scripts to show a policy over the form, and a shopper who left it could come back to an
  empty form.
* **A cart over the cash-on-delivery limit cannot be checked out**
  ([ADR-058](../architecture/13-decision-log.md#adr-058--no-order-collects-more-cash-on-delivery-than-the-law-allows-whoever-places-it-the-rest-is-paid-in-advance-or-the-order-is-not-placed)):
  the page says so, without its form, when the items alone come to more, and a post that
  `placeIn` refuses with `COD_LIMIT` shows it too (`cod_limit`).
* **Placing the order agrees to what the page linked**
  ([ADR-057](../architecture/13-decision-log.md#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)):
  the page says so above its button, `shownOf` covers the versions it linked, and `place` gives
  the orders module the versions, with where the shopper placed it from (`CheckoutClient`). The
  core's own page takes the request's address and `User-Agent`; storefronts pass their shopper's
  on in `x-hatti-client-ip` and `x-hatti-client-user-agent`, which only the storefront key can
  send.

## Search

* **Storefronts search through the core**, at `/storefront/shops/{shop}/search`, which finds
  products with the catalog's `ProductService.searchIdsOf`, as the admin's search does
  ([ADR-046](../architecture/13-decision-log.md#adr-046--storefront-search-asks-the-core-which-finds-products-in-postgres-as-the-admins-search-does-until-typesense)).
  A search matches `search_text`, folded by `searchKey` from `@hatti/pk`: fold what is typed the
  same way, and never match the fields as they were written. When Typesense comes, it answers the
  same request.
* **The core gives IDs, best first; the storefront reads the products** from their documents,
  only the page it shows (`searchObject`), as it reads a collection's. The core's answer is
  `no-store`: what a search found is for the page that shows it, not to keep.
* **A search reads a bounded amount**: 200 characters, 10 words and 250 products
  (`SEARCH_TERMS_MAX`, `SEARCH_WORDS`, `SEARCH_RESULTS`). Each word is a `LIKE` over all of a
  shop's active products, so raise a bound only with a measurement. An address may search 240
  times a minute (`SEARCHES`), suggestions included: many shoppers share a mobile network's
  address.
* **Suggestions are Shopify's predictive search** (`suggest.ts`): `/search/suggest.json`, and
  `/search/suggest?section_id=` for a theme's section with `predictive_search`, reading
  `resources[type]`, `resources[limit]` and `resources[options][unavailable_products]` as
  Shopify does. The last word is taken as cut short (`prefix: 'last'`, and `prefixKey` from
  `@hatti/pk`), as it is for Shopify's `options[prefix]=last` on the search page, which Hatti
  Base's forms send. Products that cannot be bought go last unless asked otherwise, so the
  storefront asks the core for twice as many as it shows.
* **A section renders alone** through `PageRenderer.sections`, as Shopify's section rendering API
  renders it: by its ID on the page, or a section file of the theme's by name. Its styles are not
  sent with it, so they must be on the page already: the header carries predictive search's.
* **A search the core cannot answer says so with a 503**, as the cart does: as text, or as
  Shopify's JSON error to scripts. The storefront's other pages do not need the core.

## Printable documents

* **Documents are HTML pages to print**
  ([ADR-028](../architecture/13-decision-log.md#adr-028--printable-documents-are-html-pages-with-print-styles-pdfs-will-render-the-same-pages)).
  `@hatti/documents` renders the page for a paper (`a4`, `thermal_4x6` or `thermal_80mm`) and a
  language; modules write what goes on each sheet. `orderDocument` returns packing slips or
  invoices for up to 250 orders, one to a sheet, in the order asked for.
* **Build markup only with `html```.** It escapes every value that is not markup already, so
  never build markup by joining strings. Text people typed goes through `text()`, which isolates
  its direction; numbers, amounts and codes go through `ltr()`, so that they read left to right
  in an Urdu document.
* **Wording comes in English and Urdu** (`Words`), and `say()` gives it in the document's
  language: English, Urdu (right to left) or both, English first. Keep the Urdu short and plain,
  as a shopkeeper would say it.
* **Use the page's classes** (`header`, `columns`, `box`, `banner`, `lines`, `totals`, `num`,
  `stack` and a few more) rather than inline styles: on thermal paper they fold into one column.
* **A document shows what its caller may see:** customers' numbers are masked for staff who see
  them masked, as in the API.
* **Packing slips** list what is left to ship, or all of it once everything has shipped, and the
  cash to collect. They carry a warning across the top when the order is cancelled, not
  confirmed yet, or shipped already. **Invoices** show prices, the discount, delivery charges,
  what was paid and the balance due. They are not tax invoices yet (TAX-04, TAX-05).

## Customers

* **A customer is whoever a mobile number belongs to**, one per number (E.164) per shop
  ([ADR-011](../architecture/13-decision-log.md#adr-011--phone-first-shopper-identity)). A customer needs only a number; name and email
  are optional.
* **A customer can have other numbers** besides their main one, such as a second SIM, up to 10
  (`otherPhones`); `customers.customer_phones` holds every number, so each belongs to one
  customer ([ADR-026](../architecture/13-decision-log.md#adr-026--a-customer-can-have-several-numbers-modules-with-customer-data-join-merges-and-erasure)).
  Orders, searches and the blocklist's `customer` find a customer by any of them; `blocked`
  counts any of them. Marketing consent is for the main number only. A new main number drops the
  old one unless `otherPhones` lists it. Imports match main numbers only, and exports leave other
  numbers out.
* **Orders find or create their customer** by number, in the transaction that places them, after
  the stock (see the lock order above). A new number becomes a customer with the order's name
  and email; an existing customer's profile is left as it is, since only staff and apps edit
  profiles. An order whose number changes becomes the order of that number's customer; a customer
  whose number changes keeps their orders, each with the number it was placed with.
* **What a customer's orders add up to is worked out when asked for**, not stored
  ([ADR-023](../architecture/13-decision-log.md#adr-023--customer-order-stats-are-worked-out-from-orders-when-read)).
  The orders module adds the fields to `Customer` and batches them per page of customers:
  * `numberOfOrders` counts every order, cancelled ones included;
  * `amountSpent` is what they paid on orders that were not cancelled;
  * `deliveryHistory` counts orders by how they ended up (delivered, returned, cancelled, in
    progress), for the Confirmation Desk. A refused parcel counts as returned from when it
    starts coming back;
  * `addresses` are the different addresses their orders went to, most recently used first.
* **The blocklist** holds mobile numbers, not customers, so a number can be blocked before it
  ever orders. Each has a reason (`fake_orders`, `refused_deliveries`, `abuse`, `fraud`, `other`)
  and a note. An order placed from a blocked number, or whose number changes to one, waits for
  review: its confirmation status is `needs_review`, and the timeline says why, as the system.
  `orderConfirm` lets it go ahead. Blocking a number does not hold orders already placed, and
  unblocking it does not release held ones.
* **Merging** (`customerMerge(customerId, duplicateId)`) makes a duplicate's numbers, orders,
  tags, note and consent history the customer's, and deletes the duplicate. The customer's own
  name and email win; the duplicate's fill gaps, an email with its consent. The customer is a
  customer since whichever came first. It is a `customer.merged` event naming the duplicate.
* **Erasure** (`customerErase(id)`), at the customer's request, is refused (`IN_USE`) while any
  of their orders is open. Otherwise it deletes their profile, numbers and consent history; their
  orders keep items, amounts, statuses, dates, city and province, lose the name, number, email,
  street and note, get `customerErasedAt` and an `erased` timeline entry, and can no longer take
  an email or address. Their draft orders are deleted: those that became their orders, and open
  ones with one of their numbers or their email. It is a `customer.erased` event, and cannot be
  undone. Their next order starts a new customer. Blocklist entries stay: they are the shop's
  record of a number.
* **Timeline messages never hold contact details** (numbers, emails, streets), so erasure leaves
  them as they are. What staff write in notes is theirs to keep clean.
* **Modules with customer data** register a `CustomerDataHandler` at start-up: what stops an
  erasure, how to move data on a merge (run before and after the numbers move, so it must be
  safe to repeat), and how to erase it. Erasing gets the customer's numbers and email too, for
  records that name no customer, such as draft orders.
* **The consent ledger** changes only through `customers.move_consent_history` and
  `customers.erase_consent_history`, which merges and erasures call; both act only in the
  caller's shop.
* **Scopes:** `read_customers` and `write_customers`, which merging and erasure need too. An
  order's `customer` needs `read_customers`; a customer's orders and stats need `read_orders`.
* **Search** takes a mobile number in any format, four or more of its digits (found anywhere in
  the number), or words of the name or email.

## Who sees customers' numbers

* **Owners, managers and apps see numbers whole; every other staff role sees them masked**,
  "0300 ••••567", wherever they appear: orders and their addresses, customers and their other
  numbers, the blocklist and consent history
  ([ADR-027](../architecture/13-decision-log.md#adr-027--customers-numbers-are-masked-by-role-and-reveals-go-to-an-append-only-audit-log)).
  `ROLE_PHONE_ACCESS` in `@hatti/api` says who; `shownPhone(tenant, e164)` masks.
* **Only the GraphQL mappers mask.** Services, events and CSV exports (owners and managers only)
  work with whole numbers; a mapper that shows a number takes the caller's tenant.
* **Confirmation agents reveal** a number with `orderPhoneReveal(id)` or
  `customerPhoneReveal(id)`. Roles that only see numbers masked (packers, marketers,
  accountants) get `ACCESS_DENIED`. Every reveal is an audit entry.
* **Staff who see numbers masked search by whole numbers only**, for customers and the
  blocklist: matching four digits anywhere would let them rebuild a number digit by digit. An
  agent can still find the customer or order of someone who calls.

## Audit log

* **`platform.audit_log`** records what a shop may need to account for later: who did it (app
  or staff member, and the role then), what (`customer.phone_revealed`, `order.phone_revealed`,
  `customers.exported`, `customer.merged`, `customer.erased`, `order_risk_settings.updated`,
  `order.refunded`, `orders.exported`), to which customer, order or shop, and details as the API
  has them (public IDs, amounts in major units). Never contact details.
* **`recordAudit(tx, shopId, entry)`** (`@hatti/events`) writes in the caller's transaction, so
  an entry stands only if what it describes does. Request code cannot change or delete entries.
* **`auditLog(first, after, subjectId, action)`** reads them, newest first, with
  `read_settings`: owners and managers.

## COD risk

* **Cash-on-delivery orders are scored** for how likely they are to come back unpaid (COD-06),
  when they are placed and when their address changes, and the score is kept on the order
  ([ADR-025](../architecture/13-decision-log.md#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)).
  Prepaid orders are not scored. `Order.risk` has a score from 0 to 1, a level (`LOW` under 0.3,
  `MEDIUM` under 0.6, `HIGH`) and the reasons, strongest first. `orders(riskLevel:)` filters by
  level.
* **The rules** (`risk.ts`) add points out of 100, and the score stays between 0 and 100:

  | Rule | Points |
  |---|---|
  | Refused a delivery from this shop; two or more | 35; 50 |
  | Another unshipped order from the number in the last 6 hours | 25 |
  | High value: the shop's amount or more (Rs 15,000 by default) | 20 |
  | 10 or more items | 15 |
  | No house or street number in the first address line | 15 |
  | First order from the number | 10 |
  | Cancelled two or more orders | 10 |
  | A first address line under 10 characters | 10 |
  | A city couriers don't know by that spelling | 10 |
  | Took delivery of two or more orders, and refused none | −20 |

  The history is the customer's other orders, from the same query as their stats.
* **Fairness:** no rule looks at which city an order is for, only whether couriers will recognise
  its spelling; no address rule alone reaches medium; merchants see every reason.
* **Holds:** an order at or above the shop's threshold (0.6 by default) waits for review like a
  blocked number's order: `needs_review`, with its score and what raised it on the timeline, as
  the system. An address change holds an order only if the change is what makes it risky, so
  staff who reviewed a risky order can still correct its address. `orderConfirm` lets a held
  order go ahead.
* **The policy:** `orderRiskSettings` and `orderRiskSettingsUpdate` read and set the threshold
  (0.01 to 1 in hundredths, or null to hold none) and the high-value amount. A change applies to
  orders placed or re-addressed afterwards, and is an `order_risk_settings.updated` event naming
  who made it.
* **Scopes:** `read_settings` and `write_settings`, for shop settings and policies; owners and
  managers have them. The order's `risk` needs only `read_orders`.
* **Events:** `order.created` carries the order's `riskLevel`.

## Segments

* **A segment is a name and a query**, and its members are whoever matches the query when asked
  ([ADR-024](../architecture/13-decision-log.md#adr-024--segments-are-queries-evaluated-on-demand-over-fields-modules-contribute)).
  Nothing stores membership.
* **The language** (`segment-query.ts`) is conditions joined with `AND`, `OR`, `NOT` and
  parentheses; `AND` binds tighter than `OR`, and keywords ignore case. Each field's type decides
  what it takes:
  * numbers and amounts: `=`, `!=`, `>`, `>=`, `<`, `<=`, `BETWEEN x AND y`; amounts are in the
    shop's currency, quoted if they have commas (`'2,500'`);
  * dates: the same, with days (`2026-09-01`) or days, weeks, months or years ago (`-30d`, `-2w`,
    `-3m`, `-1y`, `today`, `yesterday`), counted in Pakistan time;
  * text: `=`, `!=`, `IN (…)`, `NOT IN (…)`, ignoring case. A field can normalise values, so
    `city = lhr` means Lahore and `province = KPK` means Khyber Pakhtunkhwa;
  * lists: `CONTAINS` and `NOT CONTAINS`; true or false: `=` and `!=`.
* **Customers without a value fail the condition**, and `NOT` turns that around: `NOT
  last_order_date >= -30d` includes people who never ordered.
* **Errors say what and where:** `Unknown field "orders". Did you mean number_of_orders? (at
  character 1)`. Saving a segment reports them as `INVALID` user errors on `query`; a preview
  reports them as a `BAD_USER_INPUT` error.
* **Fields come from a registry.** The customers module has `customer_tags`,
  `customer_added_date` and `blocked`. The orders module registers `number_of_orders`,
  `amount_spent`, `first_order_date`, `last_order_date`, `delivered_orders`, `returned_orders`,
  `cancelled_orders`, `city` and `province`, from the same query as a customer's stats. Query
  values are always parameters; field SQL comes only from registered fields.
* **Limits:** 5,000 characters, 50 conditions, parentheses 10 deep, 100 values in a list.
* **Scopes:** `read_segments` and `write_segments`. Members and counts also need
  `read_customers`. Owners, managers and marketers build segments; marketers cannot change
  customers.

## Marketing consent

* **Per channel:** WhatsApp, SMS and email each have a state: `not_subscribed` (never asked),
  `subscribed` or `unsubscribed`. Transactional messages (confirmation, tracking) need none;
  marketing needs `subscribed` on its channel.
* **Every change goes into the consent ledger** (`customers.consent_events`, append-only): the
  state, what the customer agreed to (`wording`, required to subscribe), where (`source`:
  `manual`, `api`, `import`, `checkout`, `reply`, or `contact_changed`), when they said so
  (`collectedAt`, which may be before it was recorded), the number or address it was for, and
  who recorded it. The customer row keeps the current state and its time, for segments and
  lists. Asking for the state a channel already has records nothing.
* **Consent belongs to a contact.** A new number resets WhatsApp and SMS to `not_subscribed`; a
  new or removed email resets email. Each reset is a ledger entry with the source
  `contact_changed`. Email consent needs an email address.
* **Segments** filter by `whatsapp_subscription_status`, `sms_subscription_status` and
  `email_subscription_status`.
* **Scopes:** reading consent needs `read_customers`; changing it, `write_customers`. Each change
  is a `customer.marketing_consent_updated` event.

## Import and export

* **CSV through `@hatti/csv`:** `parseCsv` reads RFC 4180 files (quotes, line breaks in cells,
  CRLF, LF or CR, a byte-order mark); `toCsv` writes CRLF with a byte-order mark, so Excel shows
  Urdu, and puts an apostrophe before text that a spreadsheet would run as a formula (`=`, `+`,
  `-`, `@`).
* **Customer imports** (`customersImport`) take Hatti's own export, Shopify's customer export or
  a spreadsheet with a Phone column (Mobile, or Shopify's Default Address Phone, also work);
  headings are matched ignoring case, spaces and underscores. Rows that fail are reported by row
  number and column, and the rest go in, in one transaction. Customers already here are left as
  they are unless the import overwrites them. `dryRun` counts what would happen. Consent columns
  take yes, no, subscribed and unsubscribed; consent goes into the ledger with the source `import`.
* **Product imports** (`productsImport`) take Shopify's product export
  ([ADR-059](../architecture/13-decision-log.md#adr-059--a-shopify-product-export-is-imported-product-by-product-as-productcreate-makes-them-keeping-their-handles-the-core-sets-the-stock)):
  `readShopifyProducts` in the catalog groups its rows by handle and reads them as Shopify writes
  them; `ProductImportService` makes each product through `ProductService.create`, checked first
  with `checkCreate`, which a dry run stops at, then adds its images through `MediaService`. A
  field error is said at the row and column it came from (`located`). The stock Shopify tracked
  comes back as `ImportedStock` for the core to set through inventory, which the catalog cannot
  reach. A new Shopify column the import should read joins `COLUMNS`, with a test from a real
  export.
* **Redirect imports** (`urlRedirectsImport`) take Shopify's redirects export, Redirect from and
  Redirect to, each row checked as `urlRedirectCreate` checks one
  ([ADR-052](../architecture/13-decision-log.md#adr-052--a-shops-url-redirects-are-the-online-stores-and-the-storefront-follows-one-only-where-it-has-no-page)), in one
  transaction, 500 rows an insert, with one `url_redirects.imported` event, on which the
  publisher writes the shop's redirects again. Paths the shop has are skipped, and rows past the
  shop's 20,000 are said. `urlRedirectsExport` writes the same columns, which either import takes
  back.
* **Customer exports** (`customersExport`) cover everyone, a saved segment or a segment query, and
  include every labelled segment field, such as orders and amount spent. They need
  `write_customers` (owners and managers), carry a watermark on every row (who exported it and
  when), and are recorded as `customer_export.created` events.
* **Limits:** 1.5 million characters per import; 5,000 rows for customers' and products', and
  20,000 for redirects'; 10,000 customers per export.

## Staff sign-in

Staff identity is its own module (`@hatti/identity`); why it is built in-house is in
[ADR-020](../architecture/13-decision-log.md#adr-020--staff-identity-built-in-house-on-audited-primitives).

| Endpoint | Purpose |
|---|---|
| `POST /auth/sign-up` | Create an account; returns tokens |
| `POST /auth/sign-in` | Email and password. Returns tokens, or `mfa_required` with a `challengeToken` |
| `POST /auth/sign-in/verify` | The second step: an authenticator code or a recovery code |
| `POST /auth/refresh` | Swap a refresh token for new tokens |
| `POST /auth/sign-out` | End the current session |
| `GET /auth/me` | The user, the session and the shops they can open |
| `GET /auth/sessions`, `DELETE /auth/sessions/:id` | Signed-in devices; sign one out remotely |
| `POST /auth/two-step/totp/setup`, `…/confirm` | Turn on an authenticator app; returns 10 recovery codes once |

Rules the module enforces:

* **Passwords** are hashed with argon2id (19 MiB, 2 passes), must have at least 10 characters,
  must not contain the email's name, and are checked against Pwned Passwords by k-anonymity. That
  check fails open, so an outage never blocks sign-ups.
* **Tokens** are random, prefixed (`hsa_` access, `hsr_` refresh, `hmc_` sign-in challenge) and
  stored only as SHA-256 digests. Access tokens last 15 minutes. Refresh tokens rotate on every use;
  presenting a used one ends the whole session, except within 10 seconds (a client race). Sessions
  end after 30 days, or 7 days unused.
* **Two-step verification:** each TOTP code works once; authenticator secrets are encrypted with
  `SecretBox` (AES-256-GCM, keys in `ENCRYPTION_KEYS`) and bound to their user. Replacing an
  authenticator needs a session that passed the current one. **Owners, managers and accountants**
  cannot use a shop until their session has passed a second factor (`MFA_REQUIRED`).
* **Abuse limits** (Redis): sign-in by email (10 per 15 minutes) and by IP (100), sign-up by IP (10
  per hour), second-factor attempts by user (10), plus 5 attempts per challenge. Limits fail open
  if Redis is down.
* Wrong email and wrong password get the same answer after the same work, so responses do not
  reveal who has an account.
* **Database logins:** identity tables are reachable only by `hatti_identity`. Request-serving code
  resolves staff tokens through `identity.resolve_staff_access()`, a `SECURITY DEFINER` function
  that returns the role, and never sees password hashes.

## Configuration, logging and privacy

* Every process validates its environment at startup with `@hatti/config` (zod) and exits with a
  list of problems. Error messages never echo the values, which may be secrets.
* Log with `@hatti/logger` (JSON). **Log IDs, not personal data.** Phone numbers, email, CNIC,
  addresses, tokens and passwords are redacted automatically, but only as a backstop.
* Requests carry an `x-request-id`, accepted from the caller or generated. It appears in every
  log line for that request and in the response.

## Observability

Telemetry is OpenTelemetry, as planned in
[10 · Infrastructure](../architecture/10-infrastructure-and-devops.md#5-observability-stack). It is
off unless `OTEL_EXPORTER_OTLP_ENDPOINT` names a collector; the standard `OTEL_*` variables
configure the rest.

* **Start-up:** processes run with `node --import ./dist/instrumentation.js`, so instrumentation is
  in place before the libraries it patches load. On shutdown the last spans and metrics are
  flushed.
* **Automatic spans:** HTTP, the Fastify request and handler, GraphQL (parse, validate, resolvers),
  Postgres, Redis and outgoing `fetch`. Health probes are not traced.
* **Our spans:** `tenant transaction` (with `hatti.shop_id`), `outbox publish` (linked to the
  requests that recorded its events) and `process <event type>` in the worker. The outbox stores
  each event's W3C `traceparent`, so handling an event **continues the trace of the request that
  caused it**: API → Postgres → outbox → queue → worker.
* **Every request span** carries `hatti.shop_id` and `hatti.actor` (`app` or `staff`). Log lines
  written inside a trace carry `trace_id` and `span_id`, so Grafana can jump between logs and
  traces.
* **Metrics:** RED metrics from the HTTP instrumentation (`http.server.request.duration`), pool
  metrics from Postgres (`db.client.*`), and ours:

  | Metric | What to watch |
  |---|---|
  | `hatti.outbox.lag` (s) | Age of the oldest unpublished event; the relay is stuck or slow when it grows |
  | `hatti.outbox.parked` | Events set aside after repeated failures; anything above 0 needs a person |
  | `hatti.outbox.events.published`, `…rejected`, `hatti.outbox.relay.outages` | Relay throughput and failures |
  | `hatti.events.handle.duration` (ms) | Handler time by event type and outcome |
  | `hatti.auth.sign_ins` | Sign-in attempts by step and outcome; a jump in `invalid_credentials` or `rate_limited` means credential stuffing |

Rules:

* **No personal data in telemetry.** SQL is recorded without parameter values, Redis commands
  without keys or arguments, GraphQL without variable values. Attributes hold IDs, never names,
  phones, emails or addresses.
* **Shop IDs go on spans, not metrics.** A metric attribute per shop would create one time series
  per shop; keep metric attributes to small, fixed sets such as event types and outcomes.
* Name tracers and meters after the package, e.g. `hatti.catalog`. Create meters and instruments
  when a class is constructed, not at module load, so they bind to the running SDK.
* Sampling (keep all errors and slow traces) is the collector's job, not the application's.

## Testing

* **Vitest**, with real Postgres and Redis. Each test file creates and drops its own database with
  `createTestDatabase()` from `@hatti/db/testing`.
* With `DATABASE_POOLER_URL` set, as in CI, the database's app, system and identity URLs go
  through PgBouncer in transaction mode. Fixtures (`adminUrl`) and `listenUrl` stay direct. Code
  that only works on a direct connection fails there.
* Test behaviour through public interfaces: the service for module logic, and HTTP (`app.inject`)
  for the API.
* A concurrency guarantee gets a concurrency test: run the competing calls at once against the
  real database, as `packages/modules/inventory/src/internal/stock.test.ts` does for overselling,
  deadlocks and a deactivation racing a sale.
* NestJS needs decorator metadata. Builds get it from `tsc` (`tsconfig.nest.json`); tests get it
  from Vite's transformer. `packages/platform/api` has a test that fails if it goes missing.
* In packages that use GraphQL, `vitest.config.ts` pins `graphql` to its CommonJS build, which is
  the one NestJS and Mercurius load. Two copies of graphql cannot share a schema.

## Style

* Prettier (single quotes, trailing commas, width 100) and ESLint. `any` is an error, and so is
  `console` outside CLI scripts.
* Comments say **why**, not what.
* Prefer plain functions and small classes. Use NestJS for HTTP, GraphQL and dependency injection
  in the app, not as a reason to wrap everything in providers.
