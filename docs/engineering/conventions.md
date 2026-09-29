# Engineering conventions

> The rules the codebase follows, and why. Architecture background is in
> [02 · Tech stack](../architecture/02-tech-stack.md) and
> [03 · Multi-tenancy & data](../architecture/03-multi-tenancy-and-data.md).

## Repository layout

| Path | Contents |
|---|---|
| `apps/core` | The modular monolith: Admin GraphQL API (`src/main.ts`), worker (`src/worker.ts`), seed |
| `packages/platform/*` | Shared infrastructure: `ids`, `money`, `pk`, `config`, `logger`, `telemetry`, `crypto`, `ratelimit`, `db`, `events`, `api`, `csv` |
| `packages/modules/*` | One package per bounded context. So far: `catalog`, `identity`, `inventory`, `orders`, `customers` |
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
* **Fields resolved for each item of a list batch their reads.** They ask the request's loaders
  (`@Loaders()`), which gather the keys a page asks for and fetch them with one query. A page of
  50 products reads all its variants' stock with one query.
* GraphQL errors carry `extensions.code`: `UNAUTHENTICATED` (HTTP 401: refresh or sign in),
  `SHOP_REQUIRED` (400), `NO_SHOP_ACCESS` and `MFA_REQUIRED` (403), `ACCESS_DENIED`,
  `BAD_USER_INPUT` (malformed IDs, cursors or page sizes), and `INTERNAL_SERVER_ERROR`. In
  production, internal errors show only a request id; the details go to the logs.
* Lists are Relay-style connections: `first` (1–250, default 50), `after`, and
  `pageInfo { hasNextPage endCursor }`. Cursors are opaque.
* Money fields return `{ amount, currencyCode, formatted }`. Money inputs are decimal strings in
  the shop currency, e.g. `"2,499.50"`.

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
  an email or address. It is a `customer.erased` event, and cannot be undone. Their next order
  starts a new customer. Blocklist entries stay: they are the shop's record of a number.
* **Timeline messages never hold contact details** (numbers, emails, streets), so erasure leaves
  them as they are. What staff write in notes is theirs to keep clean.
* **Modules with customer data** register a `CustomerDataHandler` at start-up: what stops an
  erasure, how to move data on a merge (run before and after the numbers move, so it must be
  safe to repeat), and how to erase it.
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
  `customers.exported`, `customer.merged`, `customer.erased`, `order_risk_settings.updated`), to
  which customer, order or shop, and details. Never contact details.
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
* **Customer exports** (`customersExport`) cover everyone, a saved segment or a segment query, and
  include every labelled segment field, such as orders and amount spent. They need
  `write_customers` (owners and managers), carry a watermark on every row (who exported it and
  when), and are recorded as `customer_export.created` events.
* **Limits:** 5,000 rows and 1.5 million characters per import; 10,000 customers per export.

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
