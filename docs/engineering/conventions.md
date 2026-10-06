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
| `packages/modules/*` | One package per bounded context. So far: `catalog`, `identity`, `inventory`, `orders`, `customers`, `online-store`, `checkout`, `pricing`, `logistics`, `files`, `tax` |
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
    facade method that takes the caller's `tx`, such as `VariantService.productIdsOf(tx, …)`,
    or the orders module's `receiveCodIn(tx, …)`, through which couriers' statements pay orders.
  * A module may add fields to GraphQL types another module exports: the catalog exports
    `Product` and `ProductVariant`, and inventory adds their stock fields; customers export
    `Customer`, and orders add a customer's orders and what they add up to.
  * The one foreign key across modules is `inventory.items → catalog.variants`: stock belongs to
    its variant and is deleted with it.
  * A module can offer an extension point that others register with at start-up, as the
    customers module's `SegmentFieldRegistry` takes the orders module's segment fields, and its
    `CustomerDataRegistry` the orders module's part in merges, erasure and a customer's own
    export. The owner of the facts keeps its SQL; the extension point needs no dependency on it.
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

The `hatti_system` login sees every shop. Only cell-wide jobs get it, such as the outbox relay
and the worker's sweeps; request-serving processes never do. A sweep uses it only to find the
shops it has work in, then does each shop's work in that shop's own transactions
([ADR-092](../architecture/13-decision-log.md#adr-092--an-order-whose-customer-could-not-be-reached-is-cancelled-as-many-days-after-it-was-placed-as-the-shop-says-by-a-sweep-in-the-worker-shop-by-shop-and-order-by-order)):
`UnreachableOrders` lists the shops that give up on unreachable customers and calls the orders
module's `cancelUnreachable` for each; `UnpaidOrders` lists those that cancel orders never paid
and calls `cancelUnpaid`, which asks the payments module's `paymentsUnderwayIn` which of them have
a payment started online in the last day and leaves those
([ADR-168](../architecture/13-decision-log.md#adr-168--an-order-still-waiting-for-its-payment-by-transfer-online-or-its-advance-as-many-days-after-it-was-placed-as-its-shop-says-is-cancelled-by-a-sweep-in-the-worker-its-stock-let-go-and-its-customer-told-one-with-a-receipt-waiting-to-be-checked-is-left-to-staff-and-one-with-a-payment-started-online-in-the-last-day-waits-for-it));
`ConfirmationReminders` lists those with orders whose customers have not answered three hours on
and calls `remindToConfirm`, which asks only in the shop's calling hours
([ADR-175](../architecture/13-decision-log.md#adr-175--a-cash-on-delivery-order-whose-customer-has-not-answered-three-hours-after-it-was-placed-asks-them-once-more-with-the-same-buttons-and-link-in-the-shops-calling-hours-a-sweep-in-the-worker-finds-them-and-an-order-placed-more-than-three-days-before-is-left-to-the-desk));
`CustomerErasures` lists those with customers' erasures
due and calls the customers module's `eraseDue`
([ADR-110](../architecture/13-decision-log.md#adr-110--a-customers-erasure-can-be-asked-for-ten-days-ahead-and-cancelled-until-then-the-workers-sweep-carries-it-out-as-the-system-naming-who-asked)). Sweeps run under the
worker's `sweeps` role, at once and then every `SWEEP_INTERVAL_MS` after the last ends
(`repeat`), and must be safe to run twice at once: re-check under the row's lock what the sweep
found. One shop's failure is logged, and the sweep goes on to the next.

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
  statements but `executePrepared`'s, which PgBouncer carries (below). Use `set_config(…, true)` or `SET LOCAL`, as `db.tenant()` does. A session-level
  setting stays on its server connection, and PgBouncer hands that connection to other callers.
  The benchmark's control experiment shows it exposing one shop's rows to other requests.
* **No connection parameters.** PgBouncer refuses connections that send session settings, such
  as `statement_timeout`, when they connect. Timeouts come from two places instead:
  * each login's defaults (`LOGIN_DEFAULTS`: 15 s per statement, 30 s idle in a transaction),
    which `pnpm db:setup` sets locally and infrastructure code sets elsewhere;
  * each tenant transaction's limits (`transactionLimits` on the `Database`), set in the same
    statement as the shop. The Admin API allows 5 s.
* **A tenant transaction begins in one round trip**
  ([ADR-107](../architecture/13-decision-log.md#adr-107--a-tenant-transaction-begins-with-its-shop-and-limits-set-in-one-round-trip-begin-and-set_config-sent-as-one-simple-query-the-values-written-in-once-checked)):
  `withTenantTransaction` sends `begin` with the shop's and the limits' `set_config` as one simple
  query (`tenantBegin`), then hands `fn` drizzle's transaction over that connection, so nested
  transactions and `tx.rollback()` work as usual. A simple query takes no parameters, so
  `tenantBegin` writes the values in, having checked them: a UUID and whole milliseconds. Never
  write anything else into SQL that way but a prepared page's size (below); everything else goes
  as a parameter. A connection that fails while a transaction holds it is closed, not returned to
  the pool.
* **Hot queries may run prepared**
  ([ADR-108](../architecture/13-decision-log.md#adr-108--hot-queries-run-as-statements-prepared-by-name-planned-once-per-connection-every-pooler-in-front-of-the-application-sets-max_prepared_statements)):
  `executePrepared(tx, sql)` names a statement after a digest of its text, so each connection
  plans it once; `runPrepared(query)` does the same for a Drizzle query, its rows mapped as
  usual. Use them only for a query whose text takes few shapes and whose generic plan suits every
  shop
  ([ADR-111](../architecture/13-decision-log.md#adr-111--orders-and-carts-are-read-through-prepared-statements-too-each-checked-by-the-benchmark-against-shops-of-every-size-a-prepared-page-writes-its-size-into-its-text)):
  * values go as parameters, a list as one array (`= ANY(${sql.param(ids)}::uuid[])`), never
    `inArray`, which makes a new text for every length;
  * a page's size goes into the text, `literalLimit(first + 1)`, so the generic plan knows how
    many rows it reads; Postgres would otherwise guess a tenth of the shop's and keep planning;
  * `pnpm bench:db prepared` must show the generic plan the same as a small, a medium and a large
    shop's for every statement, before it is prepared and after it changes.

  Prepared so far: products (`loadProducts`), an order and orders by ID, the pages of newest
  orders and of a stage's, risk level's or customer's, an order's timeline
  ([ADR-122](../architecture/13-decision-log.md#adr-122--an-orders-timeline-is-read-through-a-prepared-statement-too-checked-by-the-benchmark-on-orders-with-their-timelines-its-locations-loader-stays-planned-as-customers-statements-do)), a cart by its secret, variants'
  snapshots and stock items. A statement that plans in about 0.1 ms gains nothing measurable
  prepared: customers', locations' and transfer receipts' stay planned. PgBouncer must run with `max_prepared_statements`, as
  `db/pgbouncer/pgbouncer.ini` does; a database test fails without it.
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
  `products`, `inventory`, `locations`, `orders`, `customers`, `segments`, `settings`,
  `themes`, `online_store_navigation`, `online_store_pages`, `content` (blogs and their
  articles), `domains`, `legal_policies`, `discounts`, `files` and `pixels`, each `read_` or
  `write_`, named as Shopify's are.
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
* **Sensitive mutations need staff to have proved who they are in the last 15 minutes**
  ([ADR-103](../architecture/13-decision-log.md#adr-103--sensitive-actions-need-staff-to-have-proved-who-they-are-in-the-last-15-minutes-by-signing-in-or-confirming-with-the-strongest-factor-their-account-has-apps-are-not-asked)):
  letting staff in or out or changing their roles, handing the shop over, changing where
  transfers are paid or connecting and changing a payment gateway account, customers' and orders' exports, a customer's own file, and erasing a customer or asking for it. Mark such a resolver with
  `@RequireRecentAuthentication()`, and say so in its description. Staff signed in or
  re-authenticated longer ago than `REAUTHENTICATION_WINDOW_MS` get `REAUTHENTICATION_REQUIRED`
  (403) for the whole request, before it runs and before its Idempotency-Key is spent; they
  re-authenticate (`POST /auth/reauthenticate`) and send it again, key and all. The guard checks
  it after scopes, as a backstop. Apps are never asked.
* **Fields resolved for each item of a list batch their reads.** They ask the request's loaders
  (`@Loaders()`), which gather the keys a page asks for and fetch them with one query. A page of
  50 products reads all its variants' stock with one query, and their collections with another.
  A field with arguments, such as `collections(first, after)`, names its loader after them, so
  that items asking for the same page share one.
* GraphQL errors carry `extensions.code`: `UNAUTHENTICATED` (HTTP 401: refresh or sign in),
  `SHOP_REQUIRED` (400), `NO_SHOP_ACCESS`, `MFA_REQUIRED` and `REAUTHENTICATION_REQUIRED` (403),
  `ACCESS_DENIED`,
  `BAD_USER_INPUT` (malformed IDs, cursors or page sizes), `BAD_REQUEST` (a request the server
  cannot read, such as a body that is not JSON, with the 4xx status Fastify gave it), and
  `INTERNAL_SERVER_ERROR`. In production, internal errors show only a request id; the details go
  to the logs. Only internal errors are logged as errors.
* Lists are Relay-style connections: `first` (1–250, default 50), `after`, and
  `pageInfo { hasNextPage endCursor }`. Cursors are opaque.
* **A list in time order carries the time in its cursors to the microsecond**, as the parcels'
  lists and the erasures waiting do (`lostParcels`, `returningParcels`, `parcelClaims`,
  `customerErasureRequests`): the text `to_char` writes in SQL (`exactTime` from `@hatti/db`),
  passed back as it is, never a `Date`. A JavaScript date keeps milliseconds, and the page after
  a row would start at its millisecond, just before it, and bring it back. `decodeTimeCursor`
  (`@hatti/api`) refuses a cursor's time that is not to the microsecond, or not a real day, as
  malformed; the ID is the caller's to check. Lists in the order rows were made page by ID alone:
  UUIDv7s sort so.
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
* **Media** come from an https URL or the shop's own staged upload, and are due to the worker,
  which makes each ready or failed
  ([ADR-158](../architecture/13-decision-log.md#adr-158--hatti-keeps-products-images-itself-the-worker-reads-each-from-the-shops-upload-or-fetches-it-from-its-url-never-reaching-a-private-network-checks-it-and-keeps-a-clean-copy-without-its-metadata-at-most-4096-pixels-a-side-the-api-serves-it-at-nine-widths-in-avif-webp-or-its-own-format-each-made-the-first-time-it-is-asked-for-and-kept-and-an-image-goes-from-storage-and-the-edge-with-its-media)).
  Code that fetches what a merchant names goes through `ImageFetcher` (`@hatti/images`), never
  the platform's `fetch`: it refuses private networks and connects only to the addresses it
  checked. An image's storage keys and its path come from the catalog's `images.ts` alone, and the
  API serves nothing else of storage at `/images`. Image work runs in libvips through `sharp`,
  with its limits set before anything is decoded.

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
  `fulfill`. Reserving and committing return shortages rather than oversell. An order whose
  items change commits and releases with `recommit`, which locks every level of both at once
  ([ADR-131](../architecture/13-decision-log.md#adr-131--an-orders-items-change-while-it-waits-to-be-packed-quantities-set-and-variants-added-in-one-edit-the-lines-kept-keeping-their-prices-its-amounts-and-tax-worked-out-again-and-the-difference-collected-at-the-door-its-stock-committed-and-let-go-at-once)): a change that both takes and gives stock is one call, never two.
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
  replace the whole address, and only until something ships. Editing the items keeps the
  snapshots of the lines kept and takes new ones for the variants added.
* **An order's total is subtotal − discount + shipping + codFee**, which `orders_total_check`
  holds: `codFee`, the shop's fee for paying on delivery ([ADR-076](../architecture/13-decision-log.md#adr-076--a-shops-fee-for-cash-on-delivery-is-the-orders-own-amount-apart-from-delivery-in-its-total-and-the-cash-collected-said-beside-the-option-where-the-shopper-chooses)), is the order's own amount,
  only on orders paid on delivery, in the cash collected and counted by the law's cap. Whatever
  shows an order's amounts shows it on a line of its own: invoices, the customer's pages, the
  thank-you page, exports, and sales reports' `additionalFees`, in total sales. A new amount of
  an order joins the total, its check and each of those. A part of an amount is kept beside it,
  as `transferDiscount` is of `discount`
  ([ADR-077](../architecture/13-decision-log.md#adr-077--something-off-for-paying-by-transfer-is-part-of-the-orders-discount-kept-apart-from-the-codes-off-the-items-after-any-code-to-the-rupee-said-where-the-shopper-chooses)):
  what checkout took off for paying by
  transfer, on transfers alone and within the discount, which `orders_transfer_discount_check`
  holds, and `onlineDiscount`, what it took off for paying online, on orders paid online alone,
  which `orders_online_discount_check` holds; those that show the discount show the codes' and each
  on lines of their own.
* **Every change** locks the order row, bumps its `version`, adds a line to its timeline
  (`orders.order_events`, append-only) and records an `order.*` event with the stage and version.
* **Addresses** are Pakistani, as for locations. The customer's mobile number is required, since
  couriers and confirmation use it; most staff roles see it masked (see "Who sees customers'
  numbers" below).
* **An order's address is the house and street (`address1`), the area (`address2`) and a
  landmark of its own (`landmark`)**
  ([ADR-070](../architecture/13-decision-log.md#adr-070--an-address-keeps-its-area-in-its-second-line-and-its-landmark-in-a-field-of-its-own-checkout-and-customers-links-ask-for-each-suggesting-the-areas-of-the-larger-cities)):
  the area is the second line, where apps built for Shopify's addresses read it; the landmark is
  Hatti's, and `formatted`, slips, invoices, exports and customers' pages print it on a line of
  its own, after the area. A new field of an address goes into the erasure that clears it, the
  digest of what a customer's page showed, the logger's redacted keys, and a migration for the
  addresses kept before.
* **The Confirmation Desk** ([ADR-073](../architecture/13-decision-log.md#adr-073--the-confirmation-desk-deals-orders-waiting-for-their-customers-to-agents-one-at-a-time-the-most-urgent-due-first-and-keeps-the-calls-that-did-not-settle-them)):
  `ConfirmationDeskService` deals out the orders at `needs_confirmation`, due from
  `dueAtOf(waits)`: `coalesce(confirmation_due_at, created_at)`, or, where the shop's
  `deskWaitsForReminder` is set ([ADR-203](../architecture/13-decision-log.md#adr-203--a-shops-confirmation-desk-may-wait-for-its-customers-to-answer-on-whatsapp-where-the-shop-asks-an-ordinary-cash-on-delivery-order-is-dealt-for-its-first-call-an-hour-after-its-reminder-to-confirm-or-three-days-after-it-was-placed-when-none-will-go-one-of-high-value-is-dealt-at-once-and-an-order-is-overdue-counting-from-when-it-fell-due)),
  an ordinary pending order paid on delivery from an hour after `confirmation_reminded_at`, or
  three days after it was placed; in one `priorityOf` (high value, due longest, riskier). `next` takes the first no one else holds with `FOR UPDATE OF o SKIP LOCKED`, and
  claims it by writing `claimed_by_kind`, `claimed_by` and `claimed_until` straight to the row:
  a claim is the queue's, not the order's, so it bumps no version and adds no timeline entry or
  event. A recorded call (`orders.confirmation_calls`) goes through `updateOrder`, as any change,
  and clears the claim; its note stays off the timeline and is cleared by erasure.
* **Calling hours and the first-call target** are order settings
  ([ADR-091](../architecture/13-decision-log.md#adr-091--a-shops-confirmation-desk-keeps-calling-hours-outside-which-it-deals-out-no-order-and-after-which-an-unanswered-one-falls-due-an-order-waiting-longer-for-its-first-call-than-the-shops-target-counting-those-hours-is-overdue)):
  minutes after midnight in the shop's time zone, which `calling-hours.ts` turns into each day's
  window as instants (`callingWindowsIn`, by Postgres, from local midnights without a time zone)
  and reasons about in TypeScript: `isCallingTime`, `callingTimeFrom` and
  `callingMinutesBefore`. The desk reads them through `deskPolicyIn`, once a call: `next` deals
  nothing outside them, an unanswered order's retry moves to the next opening, and an order not
  called yet (`confirmation_due_at IS NULL`) due before `overdueBeforeOf` is overdue. Pass
  `at` to try any moment, as the tests do.
* **Agents' performance** (`confirmationAgents`, COD-11,
  [ADR-090](../architecture/13-decision-log.md#adr-090--agents-performance-is-worked-out-when-asked-from-the-calls-the-desk-keeps-and-the-confirmations-and-cancellations-on-orders-timelines-by-who-made-them-with-how-the-orders-each-agent-confirmed-turned-out)):
  `AgentPerformanceService` reads an agent's work from the calls and from the `confirmed` and
  `cancelled` entries of orders' timelines, by their actor: a cancellation counts while the
  order waited to be confirmed, and an order's parcels are COD health's `DELIVERY`. Its
  conditions on the timeline are those of the partial index that finds them by when, so keep
  them so; the work of the shop's customers, through their links (`system`), is no one's. A
  change that confirms or cancels orders with an actor counts as that actor's work.
* **Comments on an order's timeline** (ORD-02,
  [ADR-128](../architecture/13-decision-log.md#adr-128--staff-and-apps-comment-on-an-orders-timeline-each-comment-its-authors-to-change-kept-apart-from-the-events-and-read-among-them-every-entry-saying-who-made-it-and-comments-going-with-the-customers-details-in-an-erasure)):
  `OrderCommentService` keeps them in `orders.order_comments`, apart from `order_events`, which
  stay append-only and free of contact details. `OrderService.timeline` reads both with one
  prepared statement, by ID, a `UNION ALL` whose branches each read their index backwards: keep
  their conditions alike, so Postgres merges them. A comment is its author's (`writtenBy`, kind
  and ID), and its words go into no event, outbox payload or log. Whatever shows the timeline
  shows comments as entries of kind `comment` (`toOrderEvent`, `ocm_…`); who made an entry is
  the core's to say (`OrderEvent.author`, through `StaffService.namesOf`, loaded once a page). A
  new table of what staff write about an order goes into the erasure
  (`ORDER_CUSTOMER_DATA.erase`).
* **Whom an order is given to** (ORD-10,
  [ADR-127](../architecture/13-decision-log.md#adr-127--an-order-is-given-to-one-member-of-staff-at-a-time-to-see-it-through-owners-managers-and-apps-give-it-to-anyone-other-staff-take-one-no-one-has-staff-find-theirs-with-assigneeme-and-those-who-leave-give-their-open-orders-back)):
  the order keeps its assignee's account and since when (`assignee_id` and `assigned_at`, set
  together, as a check holds them), and `OrderService.assign` changes them through `#change`,
  with a timeline entry and `order.updated` (`assignee`). Who works in the shop is the identity
  module's: the core (`order-assignment.resolver.ts`) checks the member against
  `StaffService.staffOf`, says whether the caller may take an order from whoever has it
  (`fromOthers`: owners, managers and apps), and reads names for a page of orders once
  (`identity.staff`). A module that names staff keeps their account's ID and asks who they are
  when it is read, never copying their names but into a timeline's words. Removing a member
  gives their open orders back (`OrderService.release`, after `StaffService.remove`); anything
  else that ends a member's work in the shop does the same.
* **An order's items change while it waits to be packed** (ORD-04,
  [ADR-131](../architecture/13-decision-log.md#adr-131--an-orders-items-change-while-it-waits-to-be-packed-quantities-set-and-variants-added-in-one-edit-the-lines-kept-keeping-their-prices-its-amounts-and-tax-worked-out-again-and-the-difference-collected-at-the-door-its-stock-committed-and-let-go-at-once)):
  `OrderEditService.editLineItems` locks the order, sets its lines' quantities and adds
  variants, then works its amounts out again as `placeIn` does, from the lines' prices: the
  discount, delivery charge, fee and advance stay, the tax is at the shop's rates now (each kept
  line at its variant's tax code now), and `codAmount` moves with the total. The stock follows
  by variant through `StockService.recommit`. The lines are deleted and inserted again, in their
  order and positions from 1, the kept ones with their IDs and `createdAt`: right only while
  nothing has shipped, since `fulfillment_lines` name lines, so a change of lines after that is
  a change of its own (returns and exchanges). A new amount of an order is worked out here too,
  and a new rule for placing orders, such as the COD cap, is checked here as well.
* **An order's delivery charge and discount change** the same way (ORD-04,
  [ADR-134](../architecture/13-decision-log.md#adr-134--an-orders-delivery-charge-and-discount-change-while-it-waits-to-be-packed-as-its-items-do-its-totals-tax-and-cash-at-the-door-following-what-was-taken-off-for-paying-by-transfer-stays-part-of-the-discount-and-the-fee-stays)):
  `OrderEditService.editCharges` rewrites the order with its lines as they are and the new
  amounts, through the same `#prepare` and `#write`, so whatever an edit checks holds here too.
  The fee and advance stay, and the discount never goes below `transfer_discount` and
  `online_discount`. Another
  amount staff may change, such as the fee, is one more field of `Rewrite`, never a write of its
  own.
* **An order split in two** (ORD-04,
  [ADR-135](../architecture/13-decision-log.md#adr-135--items-sent-apart-from-an-order-paid-on-delivery-become-an-order-of-their-own-as-its-cash-is-collected-by-order-at-their-prices-with-their-share-of-the-discount-the-rest-of-the-order-as-it-is-and-its-stock-where-it-was-both-orders-scored-as-the-one-their-customer-placed)):
  `OrderEditService.split` works out both orders with `#prepare` before writing either, then
  inserts the part, a copy of the order's row with its own ID, number, lines and amounts, and no
  link, and writes the order as an edit does. A new column of `orders` that is the order's alone,
  as its link is, is cleared there too. The part's `split_from_id` names the first order, also
  when a part is split again. `assessOrderRisk` takes `splitFromId`, and `customerFactsQuery`'s
  `exceptOrderId` leaves out that order and every part split from it: whatever scores an order,
  now or later, passes the row's `split_from_id`, so that an order and its parts are scored as one
  placement. Counts of a customer's orders count each part.
* **An order merged into another** (ORD-04,
  [ADR-132](../architecture/13-decision-log.md#adr-132--an-order-its-customer-placed-twice-is-merged-into-the-other-while-both-wait-to-be-packed-the-other-takes-its-items-and-discount-and-keeps-its-own-delivery-charge-as-one-parcel-the-order-merged-is-cancelled-as-merged-naming-it-and-counts-for-nothing-in-its-customers-history)):
  `OrderEditService.merge` locks both orders, the lower ID first, works the order merged into
  out again as an edit does (`#prepare`, then `#write`), and cancels the other first in between,
  so that the risk of the order merged into is scored without it. The order merged keeps its
  lines and gets `cancel_reason = 'merged'` and `merged_into_id`, which a check keeps together
  and which only merging sets; its timeline entries, and the other's, are of kind `merged`, so
  agents' performance counts no cancellation. A merged order is one its customer did not place:
  `customerFactsQuery` and COD health leave it out with `merged_into_id IS NULL`, and so does
  any new count of a customer's orders.
* **Search** takes an order number (`1001` or `#1001`), a mobile number in any format, a
  parcel's tracking number, or words of the customer's name, city or email.
* **Parcels** (`orders.fulfillments`) ship items of a confirmed or prepaid order; cash-on-delivery
  orders are never shipped unconfirmed, nor bank-transfer orders unpaid. Shipping takes the items out of stock through
  `StockService.fulfill`. A parcel is `in_transit`, then `delivered`, or `returning` when refused
  or undeliverable (return to origin), then `returned` once checked back in. Checking in says how
  many of each line go back on the shelf (`StockService.restock`); the rest are written off.
* **A parcel the courier lost is `lost`** ([ADR-072](../architecture/13-decision-log.md#adr-072--a-parcel-the-courier-lost-is-written-off-and-an-order-with-nothing-delivered-or-back-ends-at-a-stage-of-its-own-lost-before-reaching-the-customer-it-is-never-their-refusal)),
  from in transit or coming back, with `lostAt`, nothing restocked; it takes no more news but
  turning up, when it is checked back in as any. Whose doing it was is `returningAt`: set, the
  customer refused it first, and it counts as their refusal (the customer facts' `REFUSED`, and
  COD health's `returned`); not set, it never reached them, and counts as lost, the courier's.
  Wherever parcels are counted, `lostAt` keeps a parcel that turned up counted as lost.
* **A claim on a parcel's courier is the parcel's** ([ADR-093](../architecture/13-decision-log.md#adr-093--a-claim-on-the-courier-that-lost-a-parcel-is-the-parcels-followed-until-the-courier-pays-it-or-refuses-it-a-statements-cash-for-a-lost-parcel-pays-its-claim-filed-or-not)):
  the `claim_*` columns of `orders.fulfillments`, `open` to `paid`, `refused` or `withdrawn`,
  changed like any parcel, under its order's lock (`#change`), with a timeline line and the
  parcel's event (`changed: ['claim']`). A lost parcel's worth, its default claim, is
  `parcelWorth`: its items at their unit prices on the order. Statements pay lost parcels'
  claims alone, through `payClaimsIn`, which files one the shop had not; checking a lost parcel
  back in withdraws its claim unless paid. A parcel that came back is claimed for what of it was
  written off, `writtenOffWorth`: its lines' quantities less those restocked, at the same prices
  ([ADR-098](../architecture/13-decision-log.md#adr-098--a-parcel-that-came-back-with-items-written-off-as-damaged-is-claimed-from-its-courier-for-their-worth-as-a-lost-parcel-is-for-its-own-every-claim-is-listed-the-oldest-first-to-follow-up)).
  Only a lost or returned parcel has a claim (`fulfillments_claimed_status_check`), and the
  timeline names what a claim is for with `claimedParcel`. Owners, managers and accountants
  claim (`CLAIMING_ROLES`), and apps with `write_orders`.
* **What a customer sends back of a delivered parcel is a return**, not the parcel
  ([ADR-136](../architecture/13-decision-log.md#adr-136--a-customers-return-of-delivered-items-is-recorded-by-staff-each-item-with-its-reason-and-checked-in-when-it-arrives-each-unit-back-in-stock-where-it-came-back-to-or-written-off-money-given-back-stays-a-refund-and-the-sales-report-counts-what-came-back)):
  `orders.returns`, #1001-R1, and its `return_lines`, each a line's units and why. A return is
  `open`, then `closed` once checked in through `StockService.restock` at its location, each
  line's `restocked_quantity` saying how many went back, or `cancelled`. Units that may come back
  are those of `delivered` parcels less those on returns not cancelled (`returnableUnits`); a
  refused parcel comes back as itself. `ReturnService` locks the order first, as every change to
  an order does, bumps its version and says what happened on its timeline and in `return.*`
  events. Returns move no money, which refunds do, and are no refusal: customer facts and COD
  health count parcels, never returns. The sales report counts both as returns.
* **An exchange is an order of its own, paid by what comes back**
  ([ADR-137]({L})):
  `ReturnService.create` places it with `OrderService.placeIn` in the same transaction, before
  writing the return, with `advance` as much of `paidFor`, the returned units' prices less their
  shares of the discount (allocated as the tax allocates it), as its total takes. The same amount
  leaves the original order as a refund with method `exchange` (`writeRefund`, which
  `orderRefund` shares and never takes `exchange` from), so that what customers spent counts it
  once. Errors about its lines are said at `exchangeLineItems`; nothing is written when any is.
  `returns.exchange_order_id` names it, and a return with one is never cancelled.
  `openReturns` lists the open ones the longest first over `returns_open_idx`, a partial index,
  with exact cursors as the parcel lists have, and `OrderService.home` counts them
  ([ADR-138](../architecture/13-decision-log.md#adr-138--customer-returns-on-their-way-are-listed-the-longest-first-with-their-days-and-items-and-counted-on-the-home-as-parcels-coming-back-are)).
* **Parcels are found by their tracking numbers as couriers and scanners write them**
  ([ADR-071](../architecture/13-decision-log.md#adr-071--a-parcel-coming-back-is-checked-in-by-the-tracking-number-on-its-label-matched-as-couriers-statements-are-those-on-their-way-back-are-listed-the-longest-first)):
  `trackingKey` drops spaces and capitalises, and SQL compares
  `upper(regexp_replace(tracking_number, '\s', '', 'g'))`, the expression the
  `fulfillments_tracking_key_idx` index covers, for couriers' statements, the orders list and
  `receiveReturnByTracking`. A number on more than one parcel still out acts on none: it names
  the orders, to act from one.
* **The stage follows the parcels.** `updateOrder()` recomputes the fulfillment status and stage
  from them on every change. An order closes when it is delivered and paid (`completed`), every
  parcel came back (`returned`), or none was delivered or brought back (`lost`); a
  cash-on-delivery order that ended unpaid without a delivery is `voided`.
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
* **Store credit is a ledger of the customers module** ([ADR-184](../architecture/13-decision-log.md#adr-184--a-shop-owes-its-customers-store-credit-as-shopify-keeps-it-an-account-for-each-customer-and-currency-credited-by-refunds-given-as-store-credit-or-by-hand-and-debited-by-hand-the-credits-that-expire-soonest-spent-first-its-balance-is-what-its-credits-have-left-unexpired-worked-out-when-asked-from-a-ledger-written-holding-the-accounts-lock-and-never-rewritten)):
  `customers.store_credit_accounts`, one for each customer and currency, and
  `store_credit_transactions`: `credit` (with `expires_at` and `remaining`), `debit`,
  `debit_revert` and `expiration`, each with Shopify's `event`. Every change locks the account
  row first and records its expired credits (`expireIn`) before it writes; a debit spends the
  credits that expire soonest first, `NULLS LAST`, and keeps what it took from each in
  `store_credit_allocations`. The balance is `sum(remaining)` of unexpired credits, and
  `balanceAfterTransaction` a running sum over the ledger in `(created_at, id)` order, both
  worked out when read; `created_at` is `clock_timestamp()`, the time the lock was held. The
  app role may update only `remaining`, `account_id` and `expiry_reminded_at`, and delete nothing. Other modules
  credit a customer in their own transaction with `StoreCreditService.creditIn`, as
  `orderRefund(method: STORE_CREDIT)` does, naming the credit first for the refund's reference;
  a failure throws `UserErrorsRollback`, taking the refund back too. Merges move a duplicate's
  ledger (`mergeStoreCreditIn`), erasure waits for a zero balance, and the worker's
  `StoreCreditExpiry` sweep writes expirations. Each credit is an event
  (`store_credit.credited`), and the sweep marks each credit with something left that expires
  within the week once (`remindDue`, `store_credit.expiring`): the worker's `StoreCreditNotices`
  tells the customer of both ([ADR-192](../architecture/13-decision-log.md#adr-192--a-customer-hears-of-store-credit-the-shop-gives-them-with-what-they-have-in-all-and-a-week-before-a-credit-of-theirs-expires-with-when-each-credit-is-an-event-the-workers-sweep-marks-each-credit-it-reminds-of-once-and-both-go-as-their-orders-news-does)),
  reading what is left with `storeCreditNoticeFactsIn` as it queues. The scopes are Shopify's three:
  `read_store_credit_accounts`, `read_store_credit_account_transactions` and
  `write_store_credit_account_transactions`; a refund as store credit needs the last as well.
* **Store credit pays orders as a payment, and a cancellation voids it** ([ADR-185](../architecture/13-decision-log.md#adr-185--staff-pay-an-order-with-its-customers-store-credit-while-it-is-open-and-nothing-of-it-has-shipped-the-credits-that-expire-soonest-first-an-advance-still-owed-is-paid-first-and-the-cash-at-the-door-drops-by-the-rest-cancelled-the-order-gives-the-credit-back-to-the-credits-it-came-from-its-payment-void)):
  `OrderService.payWithStoreCredit` debits the customer in the order's transaction with
  `debitStoreCreditIn` (event `order_payment`, the order named) and adds to `amountPaid`; on
  cash on delivery, what pays past an advance still owed comes off `codAmount`. Only open,
  unfulfilled orders take it. `cancelLocked`, the one way orders are cancelled, finds what
  credit paid the order (`storeCreditPaidIn`) and gives it back with
  `revertOrderStoreCreditIn`: `debit_revert` rows restore each allocation to its credit, and
  credits expired since end again at once. `amountPaid` drops by it, `voided` when nothing
  paid is left, unless refunds took more than the rest, when the timeline asks staff to refund.
* **Checkout spends store credit in the transaction that places the order** ([ADR-186](../architecture/13-decision-log.md#adr-186--a-shopper-pays-at-checkout-with-the-store-credit-their-number-has-once-they-prove-it-with-a-code-the-page-offers-it-once-the-shop-has-given-any-says-so-when-the-number-has-none-and-spends-what-the-credit-covers-of-the-order-as-it-is-placed-in-the-same-transaction)):
  the open view's `storeCredit` says whether the page offers it (`shopGivesStoreCreditIn`, an
  account of any customer), and `storeCreditChoice` draws the box. Ticked (`storeCredit: '1'`),
  `#place` needs the number proved, as the shop's codes do: `numberVerifiedIn`, or `NeedsCode`
  to send one and place nothing. `storeCreditOfPhoneIn` then says what credit the number's
  customer has unexpired, and none is the `no_store_credit` problem, the box unticked. Once
  the order is placed and its code redeemed, `OrderService.payPlacedWithStoreCreditIn` pays it
  as `payWithStoreCreditIn` pays staff's, as the system, so whatever undoes the order undoes
  the debit. The placed view's `storeCredit` is what `storeCreditPaidIn` finds.
* **Each refund keeps its share of the order's sales tax**
  ([ADR-105](../architecture/13-decision-log.md#adr-105--a-refund-keeps-its-share-of-its-orders-sales-tax-the-orders-tax-in-all-it-has-refunded-less-what-the-refunds-before-it-gave-back-the-sales-report-adds-up-the-tax-its-sales-include)):
  `refundTaxOf(order, amount, refundedTax)` gives the order's tax in all it has refunded, this
  refund included, in proportion to its total and rounded half up, less what the refunds before it
  kept, so that refunds of a whole order give back all its tax (`refunds.tax`, migration 0072).
  The API's `Refund.totalTax` gives it, and `Order.currentTotalTax` the order's tax after its
  refunds (`currentTaxOf`).
* **Exports** (`ordersExport`) give up to 10,000 orders as CSV, oldest first, with the list's
  filters (`query`, `stage`, `riskLevel`, and `placedFrom` and `placedBefore`, which the list
  takes too): a row per order, or a row per line item. The file is UTF-8 with a byte-order mark,
  for Excel; amounts are in major units and times in the shop time zone. Numbers are masked as
  the caller sees them, every row has a watermark naming who exported it and when, and each
  export goes into the audit log. Staff need to be an owner, a manager or an accountant; a
  marketer's export would need an approval flow that is not built yet.
* **An export as an Excel workbook** ([ADR-182](../architecture/13-decision-log.md#adr-182--an-order-export-may-be-an-excel-workbook-as-well-as-csv-one-sheet-written-by-a-package-of-hattis-own-its-amounts-and-counts-numbers-and-its-times-dates-as-a-spreadsheet-keeps-them-and-numbers-that-begin-with-0-kept-as-text-given-in-base64-in-the-mutations-answer-as-the-csv-is-given-in-it)):
  `ordersExport(format: XLSX)`; every export's answer gives `file`, its bytes in base64. Its
  columns are `XlsxColumn`s, their `type` saying how `toXlsx` keeps their cells: `amount` for
  money in major units, `number` for counts, `time` for "2026-09-29 01:30" in the shop time zone,
  and text otherwise, which numbers, postcodes and SKUs stay, as they may begin with 0. A new
  column says its type; tests read a workbook back with `xlsxRows` from `@hatti/xlsx/testing`.
* **Scheduled exports** ([ADR-183](../architecture/13-decision-log.md#adr-183--staff-schedule-exports-of-the-shops-orders-every-day-week-or-month-the-worker-emails-each-the-orders-placed-in-the-period-that-ended-as-an-attachment-at-the-hour-they-chose-in-the-shops-time-zone-exported-as-them-asking-identity-as-it-sends-whether-they-still-export-the-shops-orders-and-at-which-proved-email)):
  `orderExportScheduleCreate` keeps a schedule in `orders.export_schedules` for the member of
  staff asking (`user_id`), never for an address: its `frequency` (a day, a week from Monday or a
  month), its `hour` in the shop time zone, and the export's `layout`, `format` and `query`.
  `period_end` is the day after the period it sends next, and `next_run_at` that day at the
  hour. `ExportScheduleService.run` claims a schedule that is due for `leaseMs` by moving its
  `next_run_at`, so that two workers never send a period twice, and `#next` moves both on by a
  period, guarded by `period_end`. Whom it goes to is asked as it sends, of
  `identity.staff_email(user, shop)`, a `SECURITY DEFINER` function that answers only for
  `platform.current_shop_id()`: the orders module reads no account's email otherwise. It gives
  the account's language too, which `scheduledExportEmail` writes in (ADR-194). The export
  runs as a staff `TenantContext` of the member, in their role then, with `scheduleId`, so its
  audit entry is theirs and names the schedule. The worker sends through a
  `ScheduledExportSender` (`exportEmailsOf`): `SesExportEmails` posts a raw MIME message
  (`mimeMessage`, SES's `Content.Raw`), `LogExportEmails` logs it in development, and production
  without SES leaves schedules waiting. `retry` tries again a minute later, doubling to an hour,
  until a day after the period's time; `failed` passes the period over, saying why in
  `last_error`.
* **No order collects more cash on delivery than the law allows**
  ([ADR-058](../architecture/13-decision-log.md#adr-058--no-order-collects-more-cash-on-delivery-than-the-law-allows-whoever-places-it-the-rest-is-paid-in-advance-or-the-order-is-not-placed)):
  `codLimitError` checks the cash at the door, the total less any advance, against
  `COD_CASH_LIMIT` for orders in rupees, in `placeIn` and when a draft is saved, and answers
  `COD_LIMIT` on `advancePaid` with the advance that would do. A new way of placing orders goes
  through `placeIn`, which checks it; the limit changes only with the law.
* **Bank transfer is a payment method of its own**, not `prepaid`
  ([ADR-074](../architecture/13-decision-log.md#adr-074--a-shop-that-gives-its-bank-account-offers-bank-transfer-the-order-waits-for-the-money-at-a-stage-of-its-own-and-keeps-the-account-its-customer-was-told-to-pay-into)):
  `placeIn` places a `bank_transfer` order unpaid, `not_required` to confirm (held for review
  only for a blocked number), unscored, with nothing at the door and no advance
  (`advanceRefusal`), and `bankAccount` the shop's account as it is then
  (`bankTransferSettingsIn`), or null when it has none. `stageOf` puts it at
  `awaiting_payment` while `awaitsTransfer` holds (less than its total received, refunds aside)
  and nothing has shipped; `packingRefusal` and `fulfill` refuse it there, and `markAsPaid`
  moves it on. Pages show the order's `bankAccount`, never the shop's current one, through
  `transferDetails` and `transferWords`, which the checkout's thank-you page and the order's link
  share. A change of the shop's account, or of what paying by transfer takes off, is audited
  with both before and after. The account's `raastId` ([ADR-082](../architecture/13-decision-log.md#adr-082--a-shops-account-takes-its-raast-id-beside-its-iban-kept-with-each-order-as-the-account-is-and-shown-on-its-customers-pages-to-copy-a-raast-qr-waits-for-the-partners)) is part of it: E.164, changed
  and audited as the IBAN is, and read as null from orders placed before it was kept.
* **A cash-on-delivery order's advance is either paid or asked for** ([ADR-083](../architecture/13-decision-log.md#adr-083--a-cash-on-delivery-order-may-ask-for-an-advance-paid-by-transfer-before-it-ships-it-waits-for-it-as-a-transfer-waits-for-its-money-and-staff-record-it-when-it-is-in)): `advancePaid`
  is received already, `advanceDue` is asked for by transfer before it ships, and never both.
  `transferOwed` is what an order waits for by transfer, a bank-transfer order's total or a
  cash-on-delivery order's advance, less what it received; `awaitsTransfer` holds while it is
  more than nothing, and `stageOf` puts such an order at `awaiting_payment`. `codAmount` is what
  the advance, paid or asked for, leaves. Money received by hand goes through `recordPayment`
  (`orderCreateManualPayment`), never by writing `amount_paid`: it records the timeline and
  `order.paid`, and marks the order paid once it makes up the total.
* **A draft asks for an advance as an order does** ([ADR-085](../architecture/13-decision-log.md#adr-085--a-draft-may-ask-for-an-advance-as-an-order-does-once-its-customer-confirms-it-the-drafts-link-shows-where-to-pay-and-takes-the-receipt)):
  its `advanceDue` is checked when the draft is saved as `create` checks an order's, the shop's
  account only when it is set, and `#place` hands it to `placeIn`. A draft's link takes a
  receipt once the draft is an order (`sendReceipt`), locking the draft and then its order, as
  its address changes do, through the same `TransferReceiptService` as an order's link.
* **Checkout's advance is the shop's rule, worked out where it is said** ([ADR-084](../architecture/13-decision-log.md#adr-084--checkout-asks-for-the-advance-the-shops-rules-name-an-amount-a-share-of-the-items-or-the-delivery-charge-on-every-order-or-above-a-total-said-beside-cash-on-delivery)):
  `CodRulesRecord.advance` is an amount, a percentage of the items after any code or the delivery
  charge, with the total above which it applies, and the cities and refusals it asks, if any
  ([ADR-089](../architecture/13-decision-log.md#adr-089--a-shops-advance-may-be-asked-only-to-cities-it-names-and-of-customers-who-refused-parcels-before-checkout-names-every-city-and-says-of-whom-and-placing-applies-them-to-the-city-and-number-typed)).
  `advanceAmountOf` works out what it asks for from the items and the delivery charge, null while
  that isn't known, and is what the page says; `advanceTakes` says whether its cities, refusals
  and new customers take in an order, null while the city or the customer isn't known; and
  `advanceOf` is the two together, which the page calls with the city typed for its summary,
  null while the order's risk decides it. Placing calls `placedAdvanceOf` with the city and the
  refusals and deliveries of the number typed (`OrderService.deliveriesOf`, counted only where
  the shop's rules ask; the page never does): an advance asked whatever the order scores is
  `OrderToPlace.advanceDue`; one asked by risk ([ADR-094](../architecture/13-decision-log.md#adr-094--a-shops-advance-may-be-asked-only-of-customers-new-to-it-and-of-orders-its-risk-rules-score-high-such-an-order-is-asked-it-instead-of-waiting-for-review)) is `riskAdvance`, which
  `placeIn` asks only if the order it scores reaches it, instead of holding it for review, the
  score kept and said on its timeline.
  `CheckoutPayments.advance` is the rule where the shop has a bank account, offering transfers or
  not, and null otherwise. `advanceKeyOf` puts it in the page's digest and tells the service
  whether it changed; setting one checks the account, and nothing else does.
* **An advance's products are settled when the page is built** ([ADR-224](../architecture/13-decision-log.md#adr-224--a-shops-advance-may-be-asked-only-of-orders-holding-a-product-it-tags-checkout-knows-the-carts-products-before-anything-is-typed-names-the-product-beside-cash-on-delivery-and-asks-a-cart-holding-none-for-nothing)):
  `advanceForCart` gives the advance with the first of the cart's products it names, or null
  for a cart holding none, so `CheckoutPayments.advance` is null then and `advanceProduct` is
  the title the page names. `advanceTakes` and placing never look at products. `advanceKeyOf`
  adds the tags only where there are some: keep an advance without them keyed as it was, as
  pages' digests hold it.
* **An order its customer placed keeps what they agreed to**
  ([ADR-057](../architecture/13-decision-log.md#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from),
  [ADR-114](../architecture/13-decision-log.md#adr-114--a-draft-its-customer-confirms-through-its-link-keeps-what-they-agreed-to-as-checkouts-orders-do-the-page-names-the-shops-policies-above-its-button-and-the-order-keeps-their-versions-and-where-it-was-confirmed-from),
  [ADR-115](../architecture/13-decision-log.md#adr-115--an-order-staff-or-an-app-placed-keeps-what-its-customer-agreed-to-in-confirming-it-through-its-link-the-page-names-the-shops-policies-and-the-order-keeps-their-versions-where-it-was-confirmed-from-and-when)):
  `OrderToPlace.agreement` gives the versions of the shop's policies they agreed to, and their
  address and browser, which `placeIn` keeps only if the address is one, and the browser's name
  without control characters, cut to 512 characters, with `agreed_at` as the order is placed.
  Orders staff and apps place have none until their customers confirm them through their links:
  `confirmLocked` takes the `agreement` then, and keeps it, stamped `agreedAt`, only if the order
  has none. The address and browser are shown only to those who see numbers whole, and erasure
  clears them; the versions and when stay. Checkout passes the policies its page linked, and a
  link those its page named above the button (`linkTermsIn`, `ShownOrder.terms`: all but the
  contact information), with the address and browser the core saw (`request.ip`, so
  `TRUST_PROXY` behind a proxy). A page that names policies puts their versions in its digest, so
  one changed while it was open shows it again. A new way for customers to place or confirm
  orders does the same.
* **The admin's home is the core's** (`home`, ANL-01): `HomeResolver` asks each module for what
  waits on the shop in its part. The orders module's part is `OrderService.home`, one aggregate
  over the stage index: how many orders, and what they come to, at each stage that waits on
  staff, and the cash on delivery still to come, `total - amount_paid` on parcels on their way
  and on delivered orders; and, of the orders awaiting payment, those whose customers sent a
  receipt, the transfers to check ([ADR-080](../architecture/13-decision-log.md#adr-080--a-customer-sends-the-receipt-of-their-transfer-through-their-orders-page-in-a-form-the-core-reads-and-keeps-in-storage-by-order-the-shop-sees-it-with-the-order)). The tallies are worked out when asked, as the stage counts are, and
  stored nowhere. The home needs `read_orders`, which every staff role has; another module's
  figure, such as low stock, joins `Home` in the core as a tally of its own.
* **Today on the home** (`home.today`,
  [ADR-121](../architecture/13-decision-log.md#adr-121--the-home-says-how-the-shops-day-has-gone-from-midnight-in-its-time-zone-todays-sales-as-the-sales-report-works-them-out-and-the-parcels-delivered-and-turned-back-today-at-their-worth)) is a field resolved
  apart, so it is worked out only when asked for: `TodayService` takes the shop's midnight and the
  next in its time zone from Postgres (`date_trunc('day', now() AT TIME ZONE …)`), never from the
  API's clock, and reads today's sales through the sales report's own statement
  (`salesPeriodsIn`), so the two never differ; a figure of a day elsewhere does the same. Parcels
  count by `delivered_at` and `returning_at`, each over its index, at `parcelWorth`.
* **Low stock on the home** (`home.lowStock`,
  [ADR-125](../architecture/13-decision-log.md#adr-125--low-stock-is-a-variant-of-an-active-product-with-the-shops-threshold-or-fewer-units-for-sale-online-five-until-it-says-otherwise-worked-out-from-the-levels-when-asked-counted-on-the-home-and-listed-the-fewest-first)) is resolved apart too,
  from the inventory module's `LowStockService.counts`, and needs `read_inventory` on that field
  alone. Low stock is defined once, in `LowStockService`: tracked variants of active products
  with the threshold or fewer units for sale online, as `inventoryQuantity` counts them. The home,
  `inventoryLowStock` and the alerts ([ADR-157](../architecture/13-decision-log.md#adr-157--the-shop-hears-on-whatsapp-when-a-variant-runs-low-on-stock-and-again-when-it-runs-out-at-the-number-it-gives-for-hattis-alerts-once-for-each-spell-of-low-stock-which-inventory-keeps-until-the-variant-is-stocked-above-the-threshold-again-the-worker-hears-each-levels-change-and-queues-the-alert-as-a-message-the-shops-credit-pays-for)) all read it there; the catalog says which products
  are active through `snapshotsOf`, never through its tables. Whether a change of stock alerts the
  shop is `LowStockService.alertIn`'s to say, under the variant's row in
  `inventory.low_stock_spells`: once a spell, and once more when it runs out.
* **The setup checklist is the core's too** (`setupChecklist`, ONB-02,
  [ADR-095](../architecture/13-decision-log.md#adr-095--the-setup-checklist-is-worked-out-when-asked-from-what-each-module-keeps-in-one-transaction-a-step-is-done-while-what-it-asks-for-holds)):
  `SetupChecklistService` reads each step's state in one tenant transaction through the modules'
  reads that take it (`activeProductsIn`, `DeliveryService.settingsOf`, `bankTransferSettingsIn`,
  `shopPoliciesOf`, `shopLogoOf`, `shopPreferencesOf`), and stores nothing: a step is done while
  what it asks for holds. A new step joins `SETUP_STEPS` in the order shops are asked it, and the
  API's `SetupStepKey`, with a read of its module's; the words are the admin app's.
* **What couriers owe** (`codReceivables`, COD-10,
  [ADR-066](../architecture/13-decision-log.md#adr-066--what-couriers-owe-is-worked-out-from-the-orders-when-asked-delivered-cash-on-delivery-orders-not-yet-paid-by-courier-and-by-days-since-delivery)):
  `CodReceivablesService` takes `total - amount_paid` on cash-on-delivery orders at `delivered`,
  by the courier of their last delivered parcel, grouped as COD health groups couriers, and by
  `RECEIVABLE_AGES` of days since that delivery; and the same on orders still on their way. The
  two add up to the home's `cashToCollect`, which a test holds them to: a change to one is a
  change to both.
* **COD health** (`codHealth`, COD-12,
  [ADR-060](../architecture/13-decision-log.md#adr-060--cod-health-follows-a-periods-cash-on-delivery-orders-worked-out-from-them-when-asked-its-rates-of-those-that-turned-out)):
  `CodHealthService` follows the cash-on-delivery orders placed in a period, a year at most,
  through confirmation and their parcels, for the shop and by one of `COD_HEALTH_DIMENSIONS`,
  each a pair of statements in `GROUPINGS`: one over the orders, counted once each with
  `count(DISTINCT o.id)`, and one over their parcels. Confirmed means `confirmed_at` is set,
  whatever came after. Rates are worked out in the API, of those that turned out. Sums over
  parcels, such as `returnCharges`, need each parcel once a row: the product's statement reads
  its parcels through a `DISTINCT` subquery, since one parcel's lines can hold a product twice. A
  new dimension adds its grouping and a title for its rows; one that only parcels have, as
  couriers, has no orders' statement.
* **Profit comes from what lines kept when sold** ([ADR-141](../architecture/13-decision-log.md#adr-141--an-orders-lines-keep-what-their-variants-cost-when-sold-and-the-sales-report-works-out-the-cost-of-goods-gross-profit-and-what-orders-made-less-couriers-charges-and-write-offs-plus-claims)): a line's `unit_cost` is its
  variant's cost when it was placed or added; nothing changes it after, and a merge joins lines
  only of the same price and cost. The sales report's tally counts the cost of goods from the
  units kept, as returns count what came back, and write-offs from what came back and was not
  restocked or was lost; `grossProfit` and `profit` work out the rest. A cost of the shop's that
  the report should take, as payment fees, joins the tally and `profit` together.
* **Reports by where orders came from read the visits orders keep** ([ADR-140](../architecture/13-decision-log.md#adr-140--sales-and-cod-health-are-broken-down-by-where-orders-came-from-the-source-and-the-campaign-of-each-orders-last-visit-from-elsewhere-orders-without-one-together)): COD health's
  `visit_source` and `campaign` and the sales report's `SALES_GROUPS` group by
  `VISIT_SOURCE_SQL` and `VISIT_CAMPAIGN_SQL`, each order's last visit from elsewhere, never by
  taking landing pages apart; campaigns in any letter case are one, named by `mode()` as cities
  are, and a row's title comes from `visitSourceTitle`, `NO_VISIT` or `NO_CAMPAIGN`. Another
  breakdown by visits, as by first visit or medium, reads the same column the same way.
* **Sales analytics** (`salesReport`, ANL-02,
  [ADR-061](../architecture/13-decision-log.md#adr-061--sales-are-reported-in-shopifys-terms-from-the-orders-when-asked-an-order-counts-on-the-day-it-was-placed-cancelled-ones-aside-and-so-do-its-items-that-came-back)):
  `SalesReportService` buckets a period's orders, cancelled ones aside, by `date_trunc` of when
  they were placed in the shop's time zone (`shopProfile(tx).timezone`), with every bucket from
  `generate_series` so that days without orders are there, and groups them for its `rows` by
  channel, visit source or campaign through the same statement (`salesWith`, given the key); returns are the items of parcels
  `returning`, `returned` or `lost`, and those customers sent back on returns not cancelled
  (ADR-136), at the line's unit price, on the order's day: none of them stayed sold. The service keeps
  minor units; `netSales`, `totalSales` and `averageOrderValue` work out the rest, which the
  resolver gives as `Money`. `taxes` is the orders' `total_tax` less that of the items that came
  back, each line's tax shared by its items and rounded line by line
  ([ADR-105](../architecture/13-decision-log.md#adr-105--a-refund-keeps-its-share-of-its-orders-sales-tax-the-orders-tax-in-all-it-has-refunded-less-what-the-refunds-before-it-gave-back-the-sales-report-adds-up-the-tax-its-sales-include)),
  and every other amount leaves the tax out, as Shopify's reports do, worked out from what each
  order keeps of it, never from a rate
  ([ADR-117](../architecture/13-decision-log.md#adr-117--the-sales-report-leaves-out-the-sales-tax-its-amounts-include-as-shopifys-does-worked-out-from-the-tax-each-order-keeps-the-tax-said-apart-and-added-back-in-total-sales)):
  gross sales line by line at each line's rate (`includedTaxIn`, the tax module's rounding),
  discounts as gross sales less the items' total paid less their kept tax, returns less the tax
  that went back with them, and shipping and fees less the charges' tax shared between them in
  proportion. Total sales add `taxes` back, so they stay what the orders were paid less what came
  back.
* **Storefront sessions** (`storefrontSessions`, `storefrontLiveView`, ANL-02, [ADR-180](../architecture/13-decision-log.md#adr-180--the-online-store-counts-its-sessions-as-shopify-does-a-browsers-pages-with-no-half-hour-between-them-a-script-in-each-page-keeps-a-sessions-id-in-a-cookie-of-the-shops-and-tells-the-storefront-of-each-page-which-counts-each-days-sessions-in-the-shops-time-zone-and-those-that-added-to-the-cart-reached-checkout-and-placed-an-order-as-hyperloglogs-in-valkey-with-who-saw-a-page-in-the-last-five-minutes-the-worker-keeps-each-days-counts-in-postgres-every-minute)):
  the storefronts count them in Valkey and the worker keeps them, so the API reads
  `online_store.session_days` through `SessionDaysService.report`, bucketed as the sales report
  buckets orders, by whole days of the shop's time zone, and the live view reads Valkey through
  `StorefrontActivity` (`liveVisitors`, and `counts` for today's day). `conversionRate` is the
  sessions that placed an order over them all, to four places, null without sessions. Both need
  `read_orders`, as the sales report does, and so does `linkPageTaps`
  ([ADR-204](../architecture/13-decision-log.md#adr-204--the-link-pages-links-go-through-the-storefront-which-counts-each-tap-a-day-at-a-time-by-where-the-link-goes-beside-the-sessions-and-sends-the-shopper-on-it-follows-only-the-pages-own-links-and-the-worker-keeps-each-days-taps-in-postgres-for-a-report-of-a-periods-by-link)),
  the online store's own resolver over `LinkTapsService.report`, by whole days too.
* **Where an order came from is kept as checked, and worked out once**
  ([ADR-139](../architecture/13-decision-log.md#adr-139--a-shoppers-browser-keeps-the-visits-that-brought-them-the-first-and-the-last-from-elsewhere-checkout-passes-them-on-and-the-order-keeps-them-as-shopifys-customer-journey)): `orders.attribution` holds its first and last visits as `attributionOf` made them,
  each with its `source` and UTM parameters already worked out, so reports group by them in SQL
  without taking addresses apart. It is read apart from the order, by `attributionsOf` through a
  request's loader for `customerJourneySummary`, never by `loadOrders`, so lists of orders do not
  carry it; a part split from an order copies it with the row. Erasure removes each visit's
  `landingPage` and `referrer` and keeps the rest: a field added to a visit that could name the
  customer goes with them.

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
* **A link lets the customer confirm a draft paid on delivery or by transfer themselves.**
  `draftOrderLinkCreate` returns the link's URL once, and a WhatsApp link carrying it: to the
  customer's number for callers who see numbers whole, and to a chat of the sender's choosing
  for the rest. A new link replaces the old one, and a draft that becomes prepaid loses its link.
  When the customer confirms, the system places the order, confirmed unless it is held for
  review.
* **A transfer's draft link becomes its order's** ([ADR-223](../architecture/13-decision-log.md#adr-223--a-draft-paid-by-transfer-gets-a-link-too-its-customer-confirms-it-as-one-paid-on-delivery-its-order-waits-for-the-money-and-the-link-becomes-the-orders-whose-page-shows-where-to-pay-and-takes-the-payment-online)): confirming copies its digest to
  the order (`linkOrderIn`), lasting as an order's link does, and the draft's view says so
  (`orderLinked`), which the controller answers with a redirect to `../o/<secret>`. Never make
  the order a new link in confirming: the customer has the one they were sent.
* **On a draft's link, the customer adds or corrects the address**
  ([ADR-034](../architecture/13-decision-log.md#adr-034--customers-add-a-drafts-address-and-their-number-while-it-has-none-through-its-link)),
  on the order links' form (`?address`), which also asks for their number while the draft has
  none; once it has one, it is shown masked and is the shop's to change. `draft_order.updated`
  then says `byCustomer`. Once the draft is an order, the same link corrects the order's address
  until it is packed, through `changeAddressLocked`, as an order's link does.
* **A draft says the sales tax its prices include, as its order will keep it**: worked out when
  it is read, not stored (see Sales tax). Its `DraftOrder.record` is there for field resolvers,
  which load what a page of drafts needs together.

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
  number while it travels.
* **Until it is packed, the customer may cancel a confirmed order too**, if the shop's order
  settings allow (`customerCancellation`, `until_packed` by default, else `until_confirmed`;
  [ADR-068](../architecture/13-decision-log.md#adr-068--a-cash-on-delivery-customer-may-cancel-through-the-orders-link-until-it-is-packed-though-they-confirmed-it-unless-the-shop-keeps-that-to-before-confirming)).
  `cancellableByCustomer(order, window)` decides, for the page and for the post: cash on
  delivery, nothing paid or shipped. The order stays confirmed, and the timeline says the
  customer cancelled after confirming it. Past the window, a customer who tries is told to ask
  the shop. Order settings are read in a transaction with `orderSettingsIn(tx, …)`.
* **Until the order is packed, the customer can correct its address**
  ([ADR-033](../architecture/13-decision-log.md#adr-033--customers-correct-an-orders-address-through-its-link-until-it-is-packed-the-number-stays-the-shops)),
  on a page of its own (`?address`; `addressChangeable` says whether it still can). Everything
  but the number: the page never shows that whole, and a new number is for staff. Saving runs
  `checkAddress` and `updateLocked`, the code behind `orderUpdate`, so the order is scored again
  and may be held for review, and a confirmed order stays confirmed. It then redirects to
  `?saved`, which says so.

## Couriers' remittances

* **Couriers' statements are the logistics module's** (`@hatti/logistics`,
  [ADR-067](../architecture/13-decision-log.md#adr-067--couriers-remittance-statements-are-imported-whole-into-a-logistics-module-each-lines-cash-received-on-its-parcels-order-at-most-what-the-order-owes-and-a-parcels-cash-once)):
  `CodRemittanceService.import` reads the CSV (`readStatement`, columns by the names in
  `COLUMNS`, matched with `headingKey`), matches lines to parcels and works out what becomes of
  each in `reconcile`, a pure function with its own tests, then writes the statement and its
  lines and receives the cash, all in one transaction. A new courier's column name joins
  `COLUMNS`; a new outcome joins `REMITTANCE_OUTCOMES`, the migration's check and the API's enum.
* **It reaches orders through the orders module's functions that take its `tx`**:
  `parcelsByTrackingIn` finds parcels by `trackingKey` (no spaces, in capitals), over an index of
  the same expression; `codOwedIn` reads what their orders owe, locking them in turn by ID; and
  `receiveCodIn` receives cash on an order, at most what it owes, with its timeline and events;
  and `chargeParcelsIn` adds a statement's charges to its parcels' `courier_charges`, with their
  orders' timelines and events; `parcelStatesIn` reads the matched parcels again once their
  orders are locked, so that `reconcile` sees what changed under those locks (a parcel lost, a
  claim settled), and `payClaimsIn` pays lost parcels' claims with their lines' cash
  (`compensated`). Nothing else in the logistics module reads the orders module's tables.
* **A parcel's cash is collected once:** a line naming a parcel that an earlier line collected
  cash on is `repeated`. Lines that receive nothing stay with the statement, for staff to look
  into (`issuesOnly`); charges and tax are kept, not taken off what orders received.
* **A parcel keeps what statements charged for it** ([ADR-088](../architecture/13-decision-log.md#adr-088--a-parcel-keeps-what-couriers-statements-charged-for-it-which-cod-health-adds-up-for-those-that-came-back-a-statement-with-the-lines-of-one-imported-before-is-refused)):
  every matched line's charges but a `repeated` line's with cash, whose charges came with the
  cash collected before. COD health's `returnCharges` adds up the parcels that came back; the
  tax withheld is not a return's cost.
* **A statement is imported once**, by its reference from the courier or by its lines:
  `digestOf` hashes them as read (tracking key and amounts, sorted), and `cod_remittances.digest`
  keeps it. The same lines with cash are refused whatever the reference; charges alone are taken
  again only when both statements have references and they differ. Imports of one shop run one
  at a time under a transaction-level advisory lock (`cod_remittances:<shop>`), taken before the
  checks; dry runs check without it. Whatever a statement does to its parcels must be safe under
  that rule: charges counted twice are what it prevents.
* Statements are read and imported by owners, managers and accountants (`RECONCILING_ROLES`), and
  by apps with `read_orders`, which need `write_orders` to import.

## Courier bookings

* **A booking waits in Postgres, and only the worker books it**
  ([ADR-149](../architecture/13-decision-log.md#adr-149--shops-book-orders-with-their-own-courier-accounts-their-credentials-sealed-for-each-account-each-booking-waits-in-postgres-until-the-worker-books-it-through-the-couriers-adapter-keeps-the-couriers-number-before-shipping-the-order-with-it-and-follows-the-parcel-by-asking-the-couriers-words-read-through-mappings-kept-as-data)).
  `CourierBookingService.request` reads each order through the orders module's
  `orderShipmentFactsIn` (who receives it where, what is left to ship, what it owes, and why it
  cannot ship now) and adds a pending booking, one waiting or booked per order
  (`bookings_open_order`). `CourierBookings` in the worker takes what is due with `claimToBook`,
  a materialized CTE locked `FOR UPDATE SKIP LOCKED` and leased for five minutes, as messages
  are, and settles each with `markBooked`, `markFailed` or `retryLater`. Never call a courier
  from an event handler or a request.
* **Keep the courier's number before shipping:** `recordTrackingNumber` runs as soon as the
  courier answers. A booking claimed with a number is shipped, or found shipped among
  `OrderShipmentFacts.parcels`, and never booked again. It returns false when the booking was
  cancelled meanwhile: cancel the courier's booking then.
* **The worker changes parcels as the system:** `FulfillmentService`'s parcel changes take a
  `ParcelCaller`, `{ shopId, actor: 'system' }` from the worker, and their timeline entries
  name nobody.
* **A new courier** is a `CourierAdapter` (`book`, `track`, `cancel`) with its `CourierInfo`: its
  key, its name, the credentials it asks for and its name for a pickup address's code, added to
  `couriersOf` in `apps/core`. Its statuses go in `logistics.courier_statuses` through a
  migration, in lower case, and its names for cities that are not Hatti's in
  `logistics.courier_cities`. `book` says whether to try again (`retry` for a courier not
  reached, a 5xx or a 429); `track` leaves out parcels the courier does not know, and fails the
  round only when the courier is down or refuses the account.
* **An account's credentials are sealed for that account** (`SecretBox`, bound to
  `courier-account:{shop}:{account}`), as JSON of the courier's fields, and leave the module
  only opened for the worker (`openedOf`); the audit log and events keep their last four
  characters. They go in requests' headers, or their bodies where the courier asks, as Leopards
  does, never their addresses.
* **A courier that names cities by its own IDs** asks for its list in the adapter and keeps it a
  day, matching a parcel's city by its letters and digits in any case (`LeopardsCourier`); a city
  it does not list is refused, not tried again. A courier that tracks parcels in batches asks
  about a refused batch a parcel at a time, so one it does not know never stops the others
  ([ADR-162](../architecture/13-decision-log.md#adr-162--leopards-is-the-second-courier-shops-book-with-through-the-same-adapter-the-accounts-key-and-password-in-each-requests-body-a-parcels-city-by-leopards-own-id-from-its-list-of-cities-kept-a-day-the-accounts-own-shipper-unless-a-shipper-id-is-given-its-parcels-asked-about-fifty-at-a-time-and-its-words-read-through-rows-of-data)).
* **Parcels are followed by asking,** every `TRACK_EVERY_MS` of where they are, and never after
  `TRACK_FOR_MS`. A change of `parcel_status` publishes `shipment.status_changed`, and the worker
  marks the parcel delivered (`markDelivered`) or returning (`markReturning`) through the orders
  module, whose events tell the customer. A courier's words no mapping knows change nothing: add
  them to its mapping.
* **Each change is a step of the parcel's way** ([ADR-160](../architecture/13-decision-log.md#adr-160--each-parcels-way-is-kept-step-by-step-as-shopifys-fulfillmentevent-its-couriers-changes-recorded-once-from-the-workers-tracking-and-staffs-for-couriers-hatti-does-not-follow-the-orders-page-shows-them-the-latest-first-in-english-and-urdu-the-shipped-message-links-that-page-and-a-parcel-out-for-delivery-with-cash-to-collect-tells-its-customer-what-to-keep-ready)): `ParcelSteps` in the worker hears
  `shipment.status_changed` and records it through `FulfillmentService.recordEvent` as the
  system, with the event as its `sourceKey` (`shipment.status_changed:<event id>`), so an event
  heard twice is one step; `STEP_OF` maps couriers' statuses to Shopify's FulfillmentEvent
  statuses. Staff and apps record the steps between shipping and delivery
  (`RECORDED_EVENT_STATUSES`) through `fulfillmentEventCreate`; delivery and coming back stay
  `fulfillmentMarkDelivered` and `fulfillmentMarkReturning`, which change the parcel. A step
  never changes the parcel: it goes on the order's timeline (`parcel_event`) and publishes
  `fulfillment_event.created`. Customers' pages read steps with `fulfillmentEventsIn`, the API
  through the `orders.fulfillmentEvents` loader.
* Accounts are settings (`write_settings`); booking orders and cancelling bookings are orders'
  work (`write_orders`); reading either needs `read_orders`.
* **Labels and load sheets are documents like packing slips**
  ([ADR-150](../architecture/13-decision-log.md#adr-150--couriers-labels-and-load-sheets-are-hattis-own-printed-pages-a-booked-parcels-label-carries-the-couriers-tracking-number-as-a-code-128-barcode-and-the-cash-the-courier-was-asked-to-collect-one-to-a-46-inch-label-or-four-to-a-sheet-of-a4-and-an-accounts-load-sheet-lists-its-parcels-waiting-to-be-picked-up-for-the-shop-and-the-rider-to-sign)): HTML from
  `@hatti/documents` that the browser prints, in English, Urdu or both. A label's cash is the
  booking's `cod_amount`, what the courier was asked to collect, never worked out again; its
  items are the parcel's own (`parcelShipmentFactsIn`), not what is left to ship. A tracking
  number goes on a label as `code128`, which takes printable ASCII alone: check `isCode128`
  first. Customers' numbers show as the caller sees them elsewhere.

## Payments online

* **A shop takes payments through its own gateway account, never Hatti's**
  ([ADR-151](../architecture/13-decision-log.md#adr-151--shops-take-payments-online-through-their-own-gateway-accounts-safepay-first-their-credentials-sealed-for-each-account-an-order-waiting-for-its-money-offers-to-take-it-on-its-page-a-session-is-recorded-before-the-customer-leaves-for-the-gateway-and-the-gateways-signed-return-or-webhook-whichever-comes-first-records-it-paid-once-and-pays-what-the-order-owes-of-it-a-sandboxs-payments-pay-nothing)). An account's credentials are sealed for that account (`SecretBox`, bound
  to `payment-gateway-account:{shop}:{account}`), as JSON of the gateway's fields, and leave
  `GatewayAccountService` only opened for a call to the gateway (`openedIn`); the audit log and
  events keep their last four characters. Connecting and changing one are sensitive
  (`@RequireRecentAuthentication`) and need `write_settings`; reading accounts needs
  `read_settings`, and an order's sessions `read_orders`.
* **The orders module owns the port, the payments module the gateways.** Orders' pages ask
  `OnlinePayments` (from `@hatti/orders/public`, provided globally by `PaymentsModule`) which
  gateways take an order's currency, to start a payment and what a return says; the payments
  module reads an order only through `orderPaymentFactsIn` and records money on it only through
  `receiveOnlinePaymentIn`, in its own transaction with the order locked. Never write to orders'
  tables from the payments module, nor call a gateway from the orders module.
* **Record a session before sending the customer away**, then call the gateway outside the
  transaction, and keep its name for the payment (`gateway_ref`) or why it refused. Completing one
  is `UPDATE … WHERE status = 'open'`, so a return and a webhook, each heard any number of times,
  pay the order once; what was paid beyond what it owed goes on its timeline
  (`payment_excess`), never back to the customer by itself. A sandbox's session pays nothing on
  the order (`test`), as anyone could pay with its test cards.
* **Trust only what the gateway signed with the account's secret:** a return's form through the
  gateway's `returned`, a webhook's raw body through its `webhook`, which answers `unsigned` for a
  signature that does not hold (401). A webhook's address names its account by public ID
  (`/webhooks/payments/pga_…`), found through `payments.resolve_gateway_account` without its shop,
  and a payment the shop did not start here is left alone (200).
* **Checkout pays online after placing, never before**
  ([ADR-152](../architecture/13-decision-log.md#adr-152--checkout-offers-paying-online-where-the-shop-has-a-gateway-the-order-is-placed-to-wait-for-its-total-as-a-transfers-does-and-its-thank-you-page-sends-the-shopper-to-the-shops-gateway-which-sends-them-back-to-the-checkouts-address-on-the-core)). Paying online is the order's `online` payment method, waiting at
  `awaiting_payment` for its total (`transferOwed`) with no confirming, risk score, fee, transfer
  discount or advance, but with what the shop takes off for paying online
  ([ADR-222](../architecture/13-decision-log.md#adr-222--a-shop-may-take-something-off-orders-paid-online-as-it-may-off-those-paid-by-transfer-a-percentage-up-to-a-cap-or-an-amount-of-its-own-which-checkout-takes-off-the-items-after-any-code-and-the-order-keeps-apart),
  `onlineDiscount`); `OrderService.create` refuses it unless
  `OnlinePayments.gatewaysOf` finds one of the shop's gateways, and drafts refuse it. Checkout's
  page puts the gateways' names in its digest (`shownOf`), so a gateway connected or archived
  since makes the page stale. The thank-you page's `action=pay` starts the session and answers with
  the gateway's address (`{ placed: false, redirect }` to storefronts, which send no referrer); the
  gateway sends the shopper back to `/checkouts/{secret}/paid` on the core's own site
  (`PublicSite`), never a storefront, which refuses posts from other sites.
* **Say paying online in the shared words**: the order's page and checkout's thank-you page take
  the button, the notice and the problems from `online-payment-page.ts` in the orders module
  (`payOnlineForm`, `onlinePaidNotice`, `onlinePaymentProblemWords`), so both say it alike in
  English and Urdu, and offer a transfer as the other way only where the order has an account.
* **Offer every gateway, and start the one chosen**
  ([ADR-219](../architecture/13-decision-log.md#adr-219--customers-choose-among-the-shops-gateways-each-live-account-that-takes-the-orders-currency-is-offered-on-its-page-and-checkouts-thank-you-page-in-the-order-the-shop-added-them-and-the-payment-starts-through-the-one-chosen)): a page that takes money online
  offers `gatewaysOf`'s list whole, in the shop's order
  ([ADR-221](../architecture/13-decision-log.md#adr-221--a-shop-puts-its-gateways-in-the-order-its-customers-are-offered-them-the-admin-api-takes-all-its-live-accounts-at-once-those-connected-before-keep-the-order-they-were-connected-in-and-one-connected-later-goes-last)),
  which `liveGatewayAccountsIn` alone keeps, a button each through `payOnlineForm`, lets its form go
  on to each (`gatewayOrigins`), and starts the payment through the posted `gateway` found by
  `chosenGateway`, the first where none is posted and none where it names one not offered. Never
  choose for the customer where the shop has several.
* **Give money back through the gateway as payments are taken** ([ADR-153](../architecture/13-decision-log.md#adr-153--money-paid-online-goes-back-through-the-gateway-that-took-it-as-far-as-its-adapter-can-give-it-back-safepay-a-payment-whole-each-refund-is-recorded-before-the-gateway-is-asked-and-written-on-its-order-once-the-gateway-says-it-is-sent-a-refusal-is-said-and-a-refund-without-an-answer-holds-its-amount-until-staff-settle-it-from-the-gateways-dashboard)):
  `orderRefund` by `ONLINE` goes through the `OnlinePayments` port's `refund`, which records a
  `payments.refunds` row, pending, with the order locked, calls the gateway's `refund` outside
  the transaction, and writes the order's refund through `refundOnlinePaymentIn` once the gateway
  says it is sent (`UPDATE … WHERE status = 'pending'`). Pending and `unknown` refunds hold their
  amount; only `paymentRefundSettle` moves an unknown one on. A gateway answers `unknown: true`
  whenever it may have acted (a timeout, a 5xx, a connection lost after sending), never for a
  refusal it plainly made or a request that never left.
* **A new gateway** is a `PaymentGateway` (`checkout`, `returned`, `webhook`, and
  `checkoutOrigin` for the pages' policies; `refund` if it gives money back) with its
  `PaymentGatewayInfo`: its key, its name, the credentials it asks for, the currencies it takes
  and what of a payment it gives back (`refunds`: `none`, `whole` or `partial`), added to
  `paymentGatewaysOf` in `apps/core`. Claim `partial` only once the gateway's refund amounts are
  checked against its sandbox. `checkout` says whether to try again
  (`retry` for a gateway not reached, a 5xx or a 429); amounts cross in minor units, converted
  to what the gateway takes (`toMajorString`) and back (`fromMajor`) at its edge.
* **A gateway whose page takes a form** gives its fields as `GatewayCheckout.form` ([ADR-163](../architecture/13-decision-log.md#adr-163--jazzcash-is-the-second-gateway-shops-take-payments-through-by-its-hosted-checkout-the-customers-browser-posts-a-form-signed-with-the-accounts-integrity-salt-to-jazzcashs-page-from-a-page-of-hattis-with-a-button-as-these-pages-run-no-scripts-and-jazzcash-posts-the-outcome-back-signed-the-same-way-the-form-is-never-kept-and-nothing-is-given-back-through-its-api)):
  the pages answer with `gatewayForm`, its fields hidden and a button, and their policy names its
  origin (`checkoutOrigin`). Its session keeps no `checkout_url`, so it is never offered again,
  and the form is never stored: it may carry credentials, as JazzCash's does. Check a signed
  outcome with the account's secret in constant time (`sameHex`) before reading anything of it.
* **A payment whose customer never came back is asked after, not waited for**
  ([ADR-208](../architecture/13-decision-log.md#adr-208--a-payment-started-online-whose-customer-never-came-back-is-asked-after-the-worker-asks-the-gateways-status-inquiry-jazzcashs-first-from-a-quarter-of-an-hour-after-it-began-at-most-once-an-hour-for-two-days-and-records-one-the-gateway-vouches-for-paid-through-the-inquiry)):
  a gateway that can be asked implements `inquire`, answering `paid` with the payment it vouches
  for, `unpaid` or `unknown`; believe an answer signed with the account's secret where the gateway
  signs it, as JazzCash does, and otherwise only as it comes from the gateway's own API, asked
  with the account's secret, naming the account and the payment asked about, as Safepay's
  ([ADR-210](../architecture/13-decision-log.md#adr-210--safepays-trackers-are-asked-after-as-jazzcashs-payments-are-through-its-reporter-with-the-accounts-secret-key-its-answer-which-safepay-does-not-sign-is-believed-as-it-comes-from-safepays-own-api-and-only-naming-the-accounts-api-key-and-the-tracker-asked-about)).
  `OnlinePaymentService.inquireDue` asks each due session outside any transaction and records
  one paid through `#complete`, as `inquiry`; `PAYMENT_INQUIRIES` says when.
* **A gateway whose return is not signed names the payment in it** with `returnRef`, and the
  service asks its `inquire` at once, outside any transaction and at most once a minute a session
  (`RETURN_INQUIRY_SECONDS`), as Easypaisa's
  ([ADR-214](../architecture/13-decision-log.md#adr-214--easypaisa-is-the-third-gateway-shops-take-payments-through-by-its-hosted-checkout-the-customers-browser-posts-a-form-encrypted-with-the-stores-hash-key-to-its-page-and-the-token-it-comes-back-with-to-its-next-and-its-return-which-it-does-not-sign-is-believed-only-once-its-inquiry-asked-at-once-with-the-accounts-api-credentials-says-the-payment-is-made)); one whose pages need the customer's
  browser twice gives the next with `continued`, for which `OnlinePayments.returned` takes the
  return address. A credential the gateway gives in one shape alone has a `pattern`, checked when
  the account is connected.
* **A gateway that asks for the buyer reads it from the request** ([ADR-226](../architecture/13-decision-log.md#adr-226--baadmays-buy-now-pay-later-is-a-gateway-shops-take-payments-through-the-order-its-items-and-its-customer-go-to-its-page-in-the-address-and-its-return-which-it-does-not-sign-is-believed-only-once-its-order-status-asked-at-once-names-the-order-and-the-amount-paid)):
  `GatewayCheckoutRequest.buyer` is the order's customer, address, items and delivery charge
  (`orderBuyerIn`), absent for an order without them, and `notifyUrl` the account's webhook
  address. Where a gateway's return names the payment by an ID of its own, as Baadmay's does, its
  `inquire` takes what the customer came back with (`returned`); believe its unsigned answer
  only naming Hatti's reference, and record the amount it says was paid.
* **A gateway's word may come in the webhook's address** ([ADR-227](../architecture/13-decision-log.md#adr-227--payfast-is-a-gateway-shops-take-payments-through-an-access-token-asked-for-the-basket-and-its-amount-with-the-secured-key-then-a-form-with-the-token-posted-to-its-page-its-return-and-its-word-at-the-webhook-which-may-come-in-the-address-believed-by-their-validation-hash)):
  `PaymentWebhookController` answers a GET as well, handing `webhook` the query as it came, as a
  form's body. Read a body as JSON first and as a form otherwise, as PayFast's and JazzCash's
  adapters do.
* **Hash a gateway's pairs in the order its own sample writes them** ([ADR-228](../architecture/13-decision-log.md#adr-228--bank-alfalahs-payment-gateway-is-one-shops-take-payments-through-a-handshake-whose-request-is-hashed-with-the-accounts-two-keys-then-a-form-with-its-token-hashed-the-same-way-posted-to-its-page-its-return-which-it-does-not-sign-believed-only-once-its-order-status-asked-at-once-says-the-payment-is-made)): Alfalah's
  are `name=value` joined by `&` in a fixed order (`alfalahHash`), its hash's own field blank among
  them, and a value may hold neither `&` nor `=`, so return addresses carry no query. Read an
  answer that may be JSON written into a JSON string with `alfalahJson`'s two passes.
* **A credential that is a key is kept on one line** ([ADR-229](../architecture/13-decision-log.md#adr-229--hbls-payment-gateway-is-one-shops-take-payments-through-a-session-asked-for-with-the-order-encrypted-under-a-key-of-the-requests-own-which-hbls-public-key-wraps-with-the-password-its-return-encrypted-to-the-shops-own-public-key-believed-once-the-shops-private-key-opens-it-to-a-reference-of-hattis)): its
  field's `normalize` takes off PEM armour and blanks before it is checked, and its `maxLength`
  allows the length a key needs. `rsaKeyOf` reads Base64 of DER (PKCS#8, SPKI or PKCS#1) or
  .NET's XML. Check what a private key opens before believing it: PKCS#1 v1.5 with implicit
  rejection gives noise, not an error.

## Billing

* **What a shop pays Hatti is the billing module's** ([ADR-154](../architecture/13-decision-log.md#adr-154--shops-pay-hatti-for-a-plan-in-rupees-by-the-month-or-the-year-through-hattis-own-payment-gateway-account-a-bigger-plan-begins-once-its-invoice-is-paid-less-what-is-left-of-the-period-it-cuts-short-a-smaller-one-when-the-period-ends-each-period-is-invoiced-a-week-ahead-and-a-week-unpaid-puts-the-shop-on-free-other-modules-ask-each-plans-limits-through-a-port)): plans are its constants
  (`PLANS`), and a shop without a row in `billing.subscriptions` is on Free. Never read a plan's
  table from another module; ask the plan's limits through `PlanAllowance` (from `@hatti/api`,
  provided globally by `BillingModule`), optional so that tests and hosts without billing limit
  nothing. Identity, whose services are built before injection, takes the limit from the
  resolver that calls it (`StaffService.invite`'s `limit`).
* **A limit refuses one more, never takes away what is there:** count what the shop has inside
  the transaction that adds one, and say the plan by name with `planLimitMessage`.
* **Hatti's invoices are paid as orders are** (ADR-151): through Hatti's own gateway account
  (`HattiGateway`, from `hattiGatewayOf` in `apps/core`), each try recorded in `billing.payments`
  before the owner leaves, and the signed return or webhook paying it once
  (`UPDATE … WHERE status = 'open'`). One invoice is open at a time: a new choice voids the
  waiting one first.
* **The owner alone spends the shop's money on Hatti** (`billingPlanChange`, `billingCreditsBuy`,
  `billingInvoicePay`): staff owners only, recently authenticated; owners and managers, and apps
  with `read_settings`, only see it.
* **Message credit is a balance kept beside its ledger** ([ADR-155](../architecture/13-decision-log.md#adr-155--a-shops-messages-are-paid-from-credit-in-rupees-it-buys-from-hatti-with-an-invoice-of-its-own-each-is-charged-as-it-is-sent-at-what-it-costs-hatti-and-hattis-fee-in-a-ledger-kept-beside-the-balance-a-message-the-credit-cannot-pay-for-waits-and-a-code-is-not-sent-and-what-whatsapp-could-not-deliver-is-given-back)): add to it or take from it
  only with `walletEntryIn`, which locks the balance, writes the entry with what the wallet holds
  after and then the balance, once for its message or invoice (`ON CONFLICT DO NOTHING`); entries
  are never changed, and are timed by `clock_timestamp()` so that a transaction's keep their order.
  Credit invoices (`reason = 'credits'`) live beside plans': whatever voids or finds "the open
  invoice" for a plan says `reason <> 'credits'`. An entry that takes the wallet from
  `CREDIT_LIMITS.low` or more to below it appends `billing_credit.low` in its transaction, which
  is one more reason never to change the balance but through `walletEntryIn`.
* **Messaging charges through `MessageCharges`** (from `@hatti/messaging/public`, provided
  globally by `BillingModule`), optional so that tests and hosts without billing charge nothing:
  price a message with `messageCostOf` (its template's category, and an SMS's parts by
  `smsParts`), charge it in the transaction that records it sent, never before, and give it back
  only when its provider says it was never delivered. Hatti pays for its own notices to the shop
  (`paidByShop`): they are never charged, and never wait for credit.

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
  `style` attributes. A page in a shop's name gives `renderPage` the shop's colour as `accent`,
  which becomes a style element of its own, allowed by its hash, for a hex colour alone, and its
  logo's URL, signed as the page is made, in `images`, which the page shows in place of the
  shop's name ([ADR-069](../architecture/13-decision-log.md#adr-069--the-checkouts-page-takes-the-shops-accent-colour-from-its-published-theme-on-its-buttons-and-on-its-links-where-they-stay-readable), [ADR-081](../architecture/13-decision-log.md#adr-081--a-shops-logo-is-one-of-its-files-chosen-as-its-brands-the-checkouts-page-shows-it-in-place-of-the-shops-name-through-a-url-signed-for-an-hour-that-the-pages-policy-allows-alone)). Links' pages get both through `linkShopIn`, as the checkout's
  page gets them in its `CheckoutShop`.
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
* **Address forms ask for the area and the landmark in boxes of their own**, the landmark's with a
  hint saying what it is for. The area's box suggests `areaSuggestions(city)` from `@hatti/pk` in
  a `datalist`: the city's areas, or, while the form has no city, every listed city's, each
  labelled by its city. Suggestions never limit what may be typed.
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
* **Add items through `BuildQueue.add`**, never to the pending set itself: it lists the shop as
  waiting ([ADR-225](../architecture/13-decision-log.md#adr-225--a-shop-with-storefront-items-waiting-is-listed-in-valkey-until-a-drain-finds-none-left-and-the-worker-builds-the-shops-quiet-ten-minutes-what-their-events-tries-gave-up-on)), a drain that finds nothing left takes it off,
  and the worker's `StorefrontSweep` builds it if nothing else does. A score on the list only
  moves on (`sfList`), so a drain's `sfUnlist`, conditional on the score it read, never takes
  off a shop listed again since.
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
* **Catalog feeds come from the documents too** (`feeds.ts`, [ADR-142](../architecture/13-decision-log.md#adr-142--a-shops-catalog-feed-is-its-storefronts-at-its-own-address-an-item-for-each-variant-of-its-products-with-an-image-in-googles-rss-which-metas-catalogs-read-too-made-from-its-documents-a-chunk-at-a-time)):
  `productFeed` lists `StoreData.productIds` and fetches them `FEED_CHUNK` at a time, yielding
  each chunk's items as they are made, so the route streams the feed through `Readable.from`
  in the memory of one chunk. A field the platforms take joins `feedItems`, written through
  `xml()`, which escapes text and drops the control characters XML has no place for, and
  clipped to Google's limits, which are within Meta's. Anything read off the storefront gives an
  image's whole address with `imageAddress`: an image by URL keeps its own, and one the image
  service keeps is at a path on the shop's. A theme does the same with `image_url`, putting
  `shop.url` before it only when it has no scheme, as `meta-tags.liquid` does.
* **Atom feeds are made as the blog's and the collection's are** (`blogFeed`, `collectionFeed`,
  [ADR-216](../architecture/13-decision-log.md#adr-216--a-collection-has-shopifys-atom-feed-at-its-address-with-atom-its-first-50-products-in-its-order-each-with-its-type-vendor-and-variants-in-shopifys-own-namespace-under-ids-of-their-own-and-products-documents-say-when-each-was-made-and-last-changed)): the head, then an entry at a time
  through `xml()`, IDs of Hatti's own as `urn:uuid:`, dates from the documents and the feed's
  own where a document has none, and Shopify's details in its namespace, `s:`. A route serving
  one is kept at the edge with the tags of the page it feeds.
* **What a shopper's own browser should keep is kept by a script, not a cookie the answer
  sets**, so pages stay the same for everyone and kept at the edge, which serves them without
  asking the storefront. The visits that brought a shopper ([ADR-139](../architecture/13-decision-log.md#adr-139--a-shoppers-browser-keeps-the-visits-that-brought-them-the-first-and-the-last-from-elsewhere-checkout-passes-them-on-and-the-order-keeps-them-as-shopifys-customer-journey)) are the case:
  `VISITS_SCRIPT` in `visits.ts`, in `content_for_header` on every shopper's page (never a
  preview's or the editor's), keeps them in `hatti_visits`; `visitsAfter` is the same rules in
  the storefront's code, for requests no page answers, as a cart permalink's, and a test runs the
  script against it. A change to the rules changes both, and the script stays small, classic and
  silent on failure: pages carry it for as long as the edge keeps them.
* **Sessions are counted as visits are kept** ([ADR-180](../architecture/13-decision-log.md#adr-180--the-online-store-counts-its-sessions-as-shopify-does-a-browsers-pages-with-no-half-hour-between-them-a-script-in-each-page-keeps-a-sessions-id-in-a-cookie-of-the-shops-and-tells-the-storefront-of-each-page-which-counts-each-days-sessions-in-the-shops-time-zone-and-those-that-added-to-the-cart-reached-checkout-and-placed-an-order-as-hyperloglogs-in-valkey-with-who-saw-a-page-in-the-last-five-minutes-the-worker-keeps-each-days-counts-in-postgres-every-minute)): `SESSION_SCRIPT` in
  `sessions.ts`, beside the visits' script, keeps the session's ID in `hatti_session` for 30
  minutes from each page and posts to `/.hatti/visit` with `sendBeacon`. The storefront's
  `counted` adds the session, read from that cookie, to `StorefrontActivity`
  (`@hatti/storefront-data`): a page seen from the beacon, and a cart added to, checkout's page
  and an order placed from the routes that do them. Nothing is counted for robots (`isRobot`),
  staff's previews or the sample shop, and a count that fails never fails the request. A day's
  counts are HyperLogLogs at `{prefix}:{shop}:an:{day}:{step}` for three days, who is on the shop
  a sorted set at `…:an:live`, and the days counted a set at `{prefix}:an:changed`, which the
  worker's `StorefrontSessions` empties into `online_store.session_days` every
  `SESSIONS_INTERVAL_MS`. A step more of the funnel goes in `ACTIVITY_STEPS`, the table and the
  API together. Taps on the link page's links are counted beside them
  ([ADR-204](../architecture/13-decision-log.md#adr-204--the-link-pages-links-go-through-the-storefront-which-counts-each-tap-a-day-at-a-time-by-where-the-link-goes-beside-the-sessions-and-sends-the-shopper-on-it-follows-only-the-pages-own-links-and-the-worker-keeps-each-days-taps-in-postgres-for-a-report-of-a-periods-by-link)):
  `StorefrontActivity.tapped` adds one to `…:an:{day}:taps`, a hash by where each link goes, and
  the same sweep keeps the day's through `LinkTapsService.keep`, keyed by `linkHash`, the
  address's SHA-256, never the address itself.
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
* **`shop.brand` is the shop's document's `brand`**
  ([ADR-207](../architecture/13-decision-log.md#adr-207--themes-get-shopifys-shopbrand-its-logo-and-square-logo-as-images-from-where-the-api-serves-them-nil-for-what-hatti-does-not-keep-and-hatti-bases-header-shows-the-logo-in-place-of-the-shops-name)):
  `brandObject` gives its logos as `ImageDrop`s of unknown size, nil without; the parts of
  Shopify's brand Hatti does not keep are nil, so themes' checks of them pass over. Another part
  comes into the shop's document first, then here.
* **So does the link page** ([ADR-161](../architecture/13-decision-log.md#adr-161--a-shops-link-page-at-links-is-a-line-about-it-up-to-ten-links-and-up-to-24-of-its-products-kept-with-what-it-sets-for-its-storefront-the-storefront-shows-it-in-the-platforms-markup-inside-the-shops-theme-in-the-pages-language-a-product-with-nothing-to-choose-a-tap-from-checkout-and-the-edge-keeps-it-until-the-shop-or-any-of-its-products-changes)): `/links` gives the
  layout `linkPageMarkup`, `.hatti-links` classes Hatti Base styles, from the shop's document's
  `linkPage` and its products' documents, fetched in one round trip. Its words are its own, in each
  language the storefront speaks, and paths on the shop keep the page's prefix. It names
  `/collections/all` for the edge, whose tag every product's change purges: the products it shows
  are named by ID, not by a handle the page carries. Its links are `LINK_TAP_PATH` and their
  `linkKey`, through the storefront, which counts the tap and sends the shopper on
  ([ADR-204](../architecture/13-decision-log.md#adr-204--the-link-pages-links-go-through-the-storefront-which-counts-each-tap-a-day-at-a-time-by-where-the-link-goes-beside-the-sessions-and-sends-the-shopper-on-it-follows-only-the-pages-own-links-and-the-worker-keeps-each-days-taps-in-postgres-for-a-report-of-a-periods-by-link)).
  The page and the route share `linkTargets`, so the route follows only what the page shows: a
  link the page gains, as its chat on WhatsApp, goes there. Its image is the shop's square logo,
  else its logo, from the shop's document's `brand` (ADR-205).

## Online store themes, menus, pages, preferences, domains, redirects and policies

* **A link page links paths on the storefront or https addresses alone** (`linkAddress`), never
  `http:`, `javascript:` or `//` another host: the page shows them as they are. Its products are
  checked to be the shop's through the catalog's `recordsOf` when saved, of any status, and those
  deleted since are left out when read (`#current`), so a list read and sent back saves. A
  variant chosen of one, in `variantIds` by its product's place
  ([ADR-206](../architecture/13-decision-log.md#adr-206--each-product-a-shops-link-page-shows-may-name-one-of-its-variants-kept-beside-it-by-its-place-the-page-shows-that-variants-title-image-and-price-and-buy-now-goes-straight-to-checkout-with-it-a-variant-deleted-since-is-as-none-chosen)),
  is checked to be the product's own, and read as none chosen once deleted. Products come as
  `productIds` or as `products` with their variants, never both.

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
  now rather than trusting the event, since events can be handled late and out of order, as
  `RiskRescoring` reads the customer's history.
* **Many pages moving at once take `redirectsMoved(tx, …)`**
  ([ADR-218](../architecture/13-decision-log.md#adr-218--a-blog-whose-handle-changes-sends-its-articles-old-addresses-to-their-new-ones-when-asked-as-shopifys-redirectarticles-does-a-redirect-for-each-made-all-at-once-with-one-event-the-storefront-follows)), `redirectMoved`'s rules in five
  statements however many pages there are, with one `url_redirects.moved` event: never
  `redirectMoved` in a loop. Its moves name each page once, none moving to where another was,
  and those the shop most needs kept come first, as only those fit when it is nearly full.

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
* Read models get the main theme and its files through `ThemeService.mainOf(tx, …)`; pages the
  core renders in the shop's name get its accent colour through `shopAccentOf(tx, …)`.
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
* **A new kind of link** (search) needs its page on the storefront first, then its type in
  `menu-items.ts` and the address `MenuService` gives it, as pages, blogs and articles have.
* **An article or a page shows once its time comes**
  ([ADR-215](../architecture/13-decision-log.md#adr-215--an-article-is-published-at-a-time-ahead-as-shopifys-publishdate-schedules-one-hidden-until-then-wherever-it-would-show-and-the-worker-shows-it-once-its-time-comes-with-the-articleupdated-the-storefront-follows),
  [ADR-217](../architecture/13-decision-log.md#adr-217--a-page-is-published-at-a-time-ahead-as-an-article-is-through-shopifys-publishdate-hidden-until-then-wherever-it-would-show-and-shown-by-the-workers-same-sweep-with-the-pageupdated-the-storefront-follows)):
  read `published_at <= now()`, never `IS NOT NULL`, wherever one would show, and their records'
  `isPublished` in code. The `scheduled` mark stays until the worker's `ScheduledContent` records
  the `article.updated` or `page.updated`; anything new that shows them follows that event, not
  the clock. What a publish date may be, and what a change of one says, are `checkPublishDate`
  and `publicationOf` in `content-input.ts`: anything else published at a time ahead uses them,
  and is one more kind for `ScheduledContent`.
* **A comment is text, escaped once**
  ([ADR-220](../architecture/13-decision-log.md#adr-220--articles-take-comments-as-their-blogs-shopify-comment-policy-says-posted-from-an-articles-page-through-the-storefront-held-for-the-shops-approval-where-the-blog-moderates-them-shown-escaped-as-text-in-the-articles-document-and-approved-marked-as-spam-or-deleted-through-the-admin-api)): kept as typed, and made HTML by
  `commentHtml` alone, for the article's document and the Admin API's `bodyHtml`; never kept or
  sent as HTML, and its email never written to a document. Something new that shoppers post from
  a storefront goes as comments and sign-ups do: a route on the storefront refusing other sites'
  posts and rate-limited by address, then the core's storefront API, and back to the page with
  `…_posted` or `…_error` for the form to read.
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
  Changes from other sites are refused (`Sec-Fetch-Site: cross-site`), save `/discount/` links,
  which shops share elsewhere and which change nothing but the code; an address may make 120
  changes a minute.
* **A cart permalink, `/cart/{variant}:{quantity},…`, begins a cart of its own** and goes to its
  checkout
  ([ADR-065](../architecture/13-decision-log.md#adr-065--a-cart-permalink-begins-a-cart-of-its-own-and-goes-to-its-checkout-leaving-the-shoppers-cart-as-it-is)):
  `permalinkItems` reads the path, and the storefront adds the items to a new cart, applies the
  link's `discount`, `note` and `attributes`, and starts the checkout; it never touches the
  shopper's cart cookie. A placed order's count cookie is the shopper's own cart's.
* **A shopper is sent only along paths on the shop**: a `return_to`, a link's `redirect` or a
  `sections_url` goes through `localPath` (`apps/storefront/src/server.ts`), which reads it as a
  browser will. A pattern on the text is not enough: `/%09/elsewhere.example` passes
  `^/(?![/\\])`, and a browser drops the tab and leaves the shop.

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
* **A discount code is the cart's, applied on the page in a form of its own** (`action=discount`
  or `action=remove_discount`, which place nothing), and its use is counted with the order
  ([ADR-063](../architecture/13-decision-log.md#adr-063--a-shoppers-discount-code-is-kept-with-their-cart-and-counted-with-the-order-placed-with-it-in-the-orders-transaction)).
  `checkoutTotals` works out what the page shows and the order is placed with: the code off the
  items, then delivery, whose free threshold the discounted items must reach. A page takes
  `DISCOUNT_ATTEMPTS` codes that take nothing off, then no more.
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
* **A cart over the cash-on-delivery limit is paid on delivery with the rest in advance, where
  the shop has its account** ([ADR-188](../architecture/13-decision-log.md#adr-188--a-cart-past-the-laws-cap-on-cash-on-delivery-is-still-taken-on-delivery-where-the-shop-has-its-account-checkout-asks-in-advance-what-the-order-comes-to-past-rs-200000-or-the-shops-own-advance-where-that-is-more-says-so-wherever-the-order-may-pass-the-cap-and-the-cart-says-so-too)): `CheckoutPayments.capAdvance` is set when the order may
  pass the cap, with `highestDeliveryCharge` and the fee, and the shop has an account
  (`bankTransferSettingsIn`, offering transfers or not); `shownOf` covers it. Placing then asks
  `cashPastLimitOf` the order's total, rounded up to a rupee, or the shop's advance where that is
  more, with no advance by risk. Without the account, when the items alone come to more, the page
  offers bank transfer alone if the shop takes it, and otherwise says so, without its form
  ([ADR-058](../architecture/13-decision-log.md#adr-058--no-order-collects-more-cash-on-delivery-than-the-law-allows-whoever-places-it-the-rest-is-paid-in-advance-or-the-order-is-not-placed),
  `cod_limit`); a post that `placeIn` refuses with `COD_LIMIT` shows it too. Hatti Base's
  `cart-totals` writes the cap in paisa, as `COD_CASH_LIMIT`: change both with the law.
* **The page offers the ways to pay it can take** ([ADR-074](../architecture/13-decision-log.md#adr-074--a-shop-that-gives-its-bank-account-offers-bank-transfer-the-order-waits-for-the-money-at-a-stage-of-its-own-and-keeps-the-account-its-customer-was-told-to-pay-into)):
  `CheckoutPayments` says whether cash on delivery may take the cart, and which account a
  transfer goes to and what it takes off, from `offeredBankTransferIn`. With both, the shopper
  chooses, on delivery unless
  they pick transfer; `shownOf` covers the bank the page named, and `place` places a way the
  page offered, or shows the page again (`changed`). A new way to pay joins `CheckoutPayments`
  and `paymentOf`, after orders' `paymentMethod`.
* **The shop's rules for cash on delivery are checkout's** ([ADR-075](../architecture/13-decision-log.md#adr-075--a-shop-keeps-cash-on-delivery-to-the-orders-it-trusts-up-to-a-total-of-its-own-outside-cities-it-names-and-not-for-customers-who-refused-parcels-before-checkout-offers-transfer-instead)):
  `codRulesIn` reads them and `codRefusalOf` says why they keep cash on delivery from an order,
  from what is known: the items' total and their products' tags for the page ([ADR-078](../architecture/13-decision-log.md#adr-078--a-shop-keeps-cash-on-delivery-from-products-by-their-tags-a-cart-holding-one-is-offered-bank-transfer-alone-the-page-naming-the-product)), read
  through `CartService.productsIn` only when the shop names tags, then the total with delivery,
  the city and, where the shop limits refusals, `OrderService.deliveriesOf` for the number
  typed, which `CustomerService.idOf` finds among every customer's numbers. Staff's and apps' orders never go
  through them. A refusal shows the page again as `cod_unavailable`, with transfer chosen where it
  is offered; the customer rule's words never say why. A new rule joins `CodRefusal` and
  `codRefusalOf`, with words for the page, and the digest if the page states it. The limit for
  risk is known only once the order is placed
  ([ADR-099](../architecture/13-decision-log.md#adr-099--an-order-paid-on-delivery-that-the-shops-risk-rules-score-at-its-limit-or-above-is-not-taken-at-checkout-placed-scored-and-undone-its-page-asks-for-a-transfer-instead)):
  `place` reads the score on the order `placeIn` returns, and `RefusedForRisk`, thrown in the
  transaction, undoes the order, as `DiscountRefused` does; the page comes back as
  `cod_unavailable` for `risk`, its words saying what the shop asks, not what the checks found.
  `checkCodRules` keeps the limit above the advance's `riskScore`. The shop's fee
  for cash on delivery is with its rules (`fee`): `place` passes it as `OrderToPlace.codFee` for
  orders paid on delivery, and the page says it beside the option where the shopper chooses, or
  adds it to the summary where cash on delivery is the only way.
* **What paying by transfer takes off is the orders module's, with the account**
  ([ADR-077](../architecture/13-decision-log.md#adr-077--something-off-for-paying-by-transfer-is-part-of-the-orders-discount-kept-apart-from-the-codes-off-the-items-after-any-code-to-the-rupee-said-where-the-shopper-chooses)): `prepaidDiscountOf(discount, items, currency)` works it out, off the items after
  the code and to the rupee, for the page and for `place`, which passes it as
  `OrderToPlace.transferDiscount` and adds it to `discount`. Delivery is worked out before it, so
  its free threshold is the code's; the code's use counts the code's share alone. The page says
  it beside the option, or takes it off the summary where transfer is the only way, and
  `shownOf` covers it. What paying online takes off is the payments module's, beside the shop's
  gateways ([ADR-222](../architecture/13-decision-log.md#adr-222--a-shop-may-take-something-off-orders-paid-online-as-it-may-off-those-paid-by-transfer-a-percentage-up-to-a-cap-or-an-amount-of-its-own-which-checkout-takes-off-the-items-after-any-code-and-the-order-keeps-apart)), and goes the same way, as `OrderToPlace.onlineDiscount`.
* **Placing the order agrees to what the page linked**
  ([ADR-057](../architecture/13-decision-log.md#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)):
  the page says so above its button, `shownOf` covers the versions it linked, and `place` gives
  the orders module the versions, with where the shopper placed it from (`CheckoutClient`). The
  core's own page takes the request's address and `User-Agent`; storefronts pass their shopper's
  on in `x-hatti-client-ip` and `x-hatti-client-user-agent`, which only the storefront key can
  send.
* **A checkout keeps the visits that brought its shopper**
  ([ADR-139](../architecture/13-decision-log.md#adr-139--a-shoppers-browser-keeps-the-visits-that-brought-them-the-first-and-the-last-from-elsewhere-checkout-passes-them-on-and-the-order-keeps-them-as-shopifys-customer-journey)): storefronts pass them, the first and the last, in the body of
  `POST …/checkouts` (`CheckoutStartRequest.visits`), with the request's own added by the rules
  the pages' script keeps them by; `start` keeps what the orders module's `attributionOf` makes
  of them, which the open view carries to `place` as `OrderToPlace.attribution`. The page shows
  none of it and `shownOf` covers none of it. Anything else that brings orders where they came
  from goes through `attributionOf` too, never kept as it came.
* **The page is in the shop's colour**
  ([ADR-069](../architecture/13-decision-log.md#adr-069--the-checkouts-page-takes-the-shops-accent-colour-from-its-published-theme-on-its-buttons-and-on-its-links-where-they-stay-readable)):
  `CheckoutShop.accent`, from the online store's `shopAccentOf(tx, …)`, is the main theme's
  `color_accent`, in its current settings or the preset they name, as storefront pages have it.
  `renderPage` puts it on the buttons, with white or dark text, whichever reads better (black
  where neither reads at 4.5 to 1), and on links and focus rings where it reads on white;
  otherwise, in dark mode, and on a page with no shop to show, the platform's colours stay. Colours that say what happened, such as the red of
  a mistake and the green of an order placed, are never the shop's.
* **What the shop asks only once an order is scored is asked by undoing it**: checkout places
  the order, reads its score, and throws (`RefusedForRisk`, `NeedsCode`) so the transaction undoes
  it, then shows the page again, as the shop's limit for risk does, or sends a code as its mark
  for codes does ([ADR-148](../architecture/13-decision-log.md#adr-148--checkout-asks-a-shopper-paying-on-delivery-for-a-code-sent-to-the-number-they-typed-on-whatsapp-or-by-sms-where-the-shops-risk-rules-score-the-order-at-its-mark-a-digest-of-the-code-alone-is-kept-and-the-order-keeps-when-its-number-was-proved)). A code's tries and its proof are written in
  transactions of their own, before placing, so a refused order never loses them. The number a
  code proves is the one typed, normalised as the order will keep it; a code is checked only
  against the newest sent to it in the checkout.
* **A browser that proved a number keeps a proof of it**
  ([ADR-199](../architecture/13-decision-log.md#adr-199--a-browser-that-proved-a-number-with-a-code-at-a-shops-checkout-is-not-asked-for-another-for-it-there-for-30-days-where-the-shops-risk-rules-would-ask-it-keeps-a-random-token-in-a-cookie-for-checkouts-the-shop-a-digest-of-it-with-the-number-and-when-it-was-proved-spending-store-credit-still-asks-each-time)): an order placed with a
  number proved by a code gives `proof`, which `proveBrowserIn` keeps as a digest in
  `checkout.number_proofs` for 30 days; the core sets it as `hatti_proved` on its own address
  (`numberProofCookie`), and the storefront does on the shop's, sending it back in
  `x-hatti-number-proof` (`CLIENT_PROOF_HEADER`). `provedByBrowserIn` reads it where the shop's
  risk rules ask for a code, never for store credit. `CHECKOUT_CUSTOMER_DATA` erases and exports
  proofs by number, and the worker's erasures name it too.

## Discount codes

* **Codes are the pricing module's** (`@hatti/pricing`,
  [ADR-062](../architecture/13-decision-log.md#adr-062--discount-codes-are-the-pricing-modules-a-percentage-or-an-amount-off-an-orders-items-or-free-delivery-matched-in-any-letter-case)):
  `DiscountCodeService` makes, changes and deletes them, with `discount_code.*` events. A code
  gives one thing, its `kind`: `percentage` (kept in `percentage_bps`, hundredths of a
  percent), `fixed_amount` (`amount`, in minor units) or `free_shipping`.
* **`discountOf(code, { subtotal, shipping })` is the one place that works out what a code takes
  off**, from the items and from delivery; whether the code may be used is the caller's to ask.
* **Codes are matched in any letter case:** the table is unique on `lower(code)`, and
  `discountCodeIn(tx, shopId, code)` finds one in the caller's transaction. `typedCode` reads
  what a shopper typed.
* **An input left out stays as it is; null clears it.** Giving `percentage`, `amount` or
  `freeShipping` changes what the code gives; giving two is refused.
* Scopes are Shopify's `read_discounts` and `write_discounts`; owners, managers and marketers
  have them.
* **Shoppers' codes go through the cart and the order's transaction**
  ([ADR-063](../architecture/13-decision-log.md#adr-063--a-shoppers-discount-code-is-kept-with-their-cart-and-counted-with-the-order-placed-with-it-in-the-orders-transaction)):
  `applyDiscountIn(tx, …)` says what a typed code takes off, or why not (`DiscountRefusal`),
  and `redeemDiscountIn(tx, …)` counts a use once the order is placed, in the same
  transaction, locking the code; a refusal there undoes the order. A new way of placing orders
  with codes, such as drafts, does both. Uses are kept with the order's customer, and
  `DISCOUNT_CUSTOMER_DATA` moves them when customers merge.
* **A cart says of its code only whether it applies**
  ([ADR-064](../architecture/13-decision-log.md#adr-064--discount-links-keep-their-code-with-the-shoppers-cart-one-begun-for-it-if-need-be-and-a-cart-says-of-a-code-only-whether-it-applies)):
  `CartJson.discount` has a code that does not apply as typed, with nothing else, whether or not
  the shop has it; why is checkout's to say, which counts the codes tried there. The storefront
  writes it as Shopify's cart: `discount_codes`, `total_discount`, `total_price` after the code,
  and one cart-level discount application of type `discount_code`; a free-delivery code is in
  Liquid's `discount_applications` only, aimed at the shipping line.

## Sales tax

* **The rate is the tax module's** (`@hatti/tax`,
  [ADR-096](../architecture/13-decision-log.md#adr-096--sales-tax-is-included-in-prices-at-a-rate-the-tax-module-keeps-each-order-keeps-the-tax-in-it-as-it-was-placed-line-by-line-and-in-its-delivery)):
  `TaxSettingsService` keeps it in `tax.settings`, in hundredths of a percent, with whether
  delivery charges and the fee for paying on delivery include it (`tax_delivery`), and
  `taxSettingsIn(tx, shopId)` reads it in the caller's transaction. A shop without a row charges
  none (`NO_TAX`). Each change is a `tax_settings.updated` event and an audit entry; the scopes are
  `read_settings` and `write_settings`.
* **Prices include the tax: no total ever adds it.** `orderTaxOf(settings, { lines, discount,
  charges })` is the one place that works out the tax in an order: each taxable line's, after its
  share of the discount by the largest remainder, `includedTax` rounded half up line by line, and
  the charges' where the shop's include them. `placeIn` keeps it on the order (`tax_rate`,
  `total_tax`, `shipping_tax`) and its lines (`taxable`, `tax_rate`, `tax`) at the rate then, so a
  new way of placing orders gets its tax by going through `placeIn`.
* **The tax is said where the total is.** `taxIncludedWords(rate)` words it, "Sales tax 18%
  (included)", in English and Urdu, and the orders module's `taxByRate(order)` adds up an order's
  lines' and charges' tax by rate, for invoices, customers' pages and the API's `taxLines`.
  Checkout's page works out its own with `orderTaxOf` from the cart's lines, which say whether they
  are `taxable`, and its digest carries the rate, so that a change shows the page again; a
  draft's link's page carries its draft's tax in its digest too.
* **A variant is taxed unless the shop says otherwise** (`variants.taxable`, Shopify's `taxable`):
  `snapshotsOf` gives it to orders and carts, and the product import reads "Variant Taxable".
  Liquid's `shop.taxes_included` and `cart.taxes_included` are always true.
* **Categories are codes with rates, kept with the settings**
  ([ADR-097](../architecture/13-decision-log.md#adr-097--tax-categories-are-the-shops-codes-with-rates-of-their-own-which-variants-name-by-shopifys-tax-code-every-other-variant-it-taxes-is-at-the-shops-rate)):
  `tax.settings.categories`, replaced whole, checked by `checkTaxCategories`. A variant names one
  by Shopify's tax code (`variants.tax_code`, "Variant Tax Code" in imports), text to the catalog,
  and `lineRateOf(settings, line)` is the one place that gives a line its rate: its code's
  category's in any letter case, else the shop's, and none for a variant not taxed or while the
  shop charges none. Each line keeps its rate; `taxesByRate` adds an order's tax up by rate,
  leaving out what comes to nothing, for every page that shows it.
* **What was given back gives its tax back.** A refund keeps its share of the order's tax, and the
  sales report its sales' tax less the items that came back, taken out of its other amounts
  ([ADR-105](../architecture/13-decision-log.md#adr-105--a-refund-keeps-its-share-of-its-orders-sales-tax-the-orders-tax-in-all-it-has-refunded-less-what-the-refunds-before-it-gave-back-the-sales-report-adds-up-the-tax-its-sales-include)).
  A new way of giving money back works its tax out with `refundTaxOf`, so that the refunds of an
  order never give back more or less than its tax.
* **A draft's tax is worked out when it is read, never kept on it**
  ([ADR-106](../architecture/13-decision-log.md#adr-106--a-draft-says-the-sales-tax-its-prices-include-an-open-ones-at-the-shops-rates-now-as-placing-it-would-work-it-out-a-completed-ones-as-its-order-keeps-it)):
  `draftTaxOf(settings, draft, variants)` works out an open draft's with `orderTaxOf`, from its
  variants' `snapshotsOf`, as `placeIn` will; a completed draft's is its order's,
  `taxByRate(order)`. `DraftOrderService.taxesOf(tenant, drafts)` gives a page of drafts theirs
  at once, for the API's loader (`orders.draftTaxes`), and the link's view carries its open
  draft's, for its page and its digest. Anything new that shows a draft takes its tax from these.
* **The shop's tax registration is the tax module's too**
  ([ADR-190](../architecture/13-decision-log.md#adr-190--a-shops-ntn-and-sales-tax-registration-number-are-kept-with-its-tax-settings-as-fbr-writes-them-and-its-invoices-name-them-with-a-sales-tax-registration-number-they-are-sales-tax-invoices-which-say-their-value-without-the-tax-too)):
  `tax.settings.ntn` and `strn`, checked by `checkNtn` and `checkStrn`, which take what is typed
  and keep it as FBR writes it. Documents get it in `DocumentContext.registration`, read with
  `taxSettingsIn` in the transaction that loads their orders: an invoice names it under the shop,
  and with an STRN is a sales tax invoice (`WORDS.taxInvoice`) that says its value without the
  tax. A new document that is a tax document does the same; one that is not, like the packing
  slip, names none.

## Search

* **A list's search takes filters among its words, as Shopify's syntax writes them**
  ([ADR-118](../architecture/13-decision-log.md#adr-118--an-orders-search-takes-filters-among-its-words-as-shopifys-search-syntax-writes-them-a-filter-or-value-it-doesnt-know-is-refused-naming-those-it-takes)):
  `key:value`, a value in double quotes if it has spaces, a leading minus to leave matches out.
  The syntax is the lists' own, read once by `parseSearch` in `@hatti/api`
  ([ADR-120](../architecture/13-decision-log.md#adr-120--a-products-search-takes-shopifys-filters-among-its-words-in-the-syntax-the-orders-search-reads-which-the-admins-lists-share)): a list gives
  its `SearchSyntax` (what it holds, its filters with the values each takes, an example for those
  that take any) and never parses a search itself. `parseOrderSearch`, `parseProductSearch`,
  `parseCustomerSearch` ([ADR-126](../architecture/13-decision-log.md#adr-126--a-customers-search-takes-a-tag-and-each-channels-marketing-consent-among-its-number-or-words-in-the-syntax-the-lists-share-segments-stay-the-shops-saved-views-of-customers)) and `parseDraftSearch` ([ADR-123](../architecture/13-decision-log.md#adr-123--a-drafts-search-finds-a-draft-by-its-number-its-customers-mobile-or-words-of-their-name-city-or-email-with-filters-among-them-as-the-orders-search-does-each-draft-keeps-its-words-folded)) split their lists' searches into filters and the words left, and
  refuse a filter or value they don't know, naming those they take: resolvers check a query first
  (`orderSearch`, `productSearch`, `customerSearch`, `draftSearch`, `BAD_USER_INPUT`) and
  mutations return the error
  on `query`, so that `orderConditions`, `productSearchConditions`, `customerSearchConditions`
  and `draftSearchConditions`
  never see one they can't read. A list's words match a `search_text` its rows keep, folded by
  `searchKey` whenever what it is made of changes (`searchTextOf` for orders and drafts alike). A filter's
  values are its column's own, from the schema's value sets (`ORDER_SEARCH_FILTERS`,
  `PRODUCT_SEARCH_FILTERS`), so a new value is found without another list; a filter that takes
  any value matches it whole, in any letter case. A minus leaves out only the rows a filter
  matches (`NOT coalesce(…, false)`): one without a value stays. A new list that takes filters
  does the same, with its own keys. A filter whose value names the caller, `assignee:me`, takes them
  from the tenant: `orderConditions` gets `me`, the member of staff searching
  (`staffMemberOf`), so the list and its export read it alike, and an app, which is no one,
  matches nothing ([ADR-127](../architecture/13-decision-log.md#adr-127--an-order-is-given-to-one-member-of-staff-at-a-time-to-see-it-through-owners-managers-and-apps-give-it-to-anyone-other-staff-take-one-no-one-has-staff-find-theirs-with-assigneeme-and-those-who-leave-give-their-open-orders-back)). A filter whose values are no set, such as an account's
  ID, is checked by its list's parser after `parseSearch`. A saved search
  keeps the string, checked with the same parser when saved
  ([ADR-119](../architecture/13-decision-log.md#adr-119--the-shop-keeps-searches-of-its-orders-by-name-for-all-its-staff-as-shopifys-saved-searches-each-a-query-the-orders-search-takes-checked-when-saved)), so the list reads it as it
  is; its `filters` and `searchTerms` are the parser's split. A saved search names its list, and
  `parseSavedSearch` checks it with that list's parser ([ADR-124](../architecture/13-decision-log.md#adr-124--saved-searches-take-the-shops-drafts-and-products-as-well-as-its-orders-each-query-checked-by-its-own-lists-search-names-unique-within-a-list-and-keeping-one-needs-the-scope-that-changes-its-list)): a new list
  joins `LISTS` in `saved-search.service.ts` with its parser, and the resolver's `WRITE_SCOPES` with
  the scope that changes it, checked in the resolver since the list is known only from the input
  or the saved search.
* **Storefronts search through the core**, at `/storefront/shops/{shop}/search`, which finds
  products with the catalog's `ProductService.searchIdsOf`, as the admin's search does
  ([ADR-046](../architecture/13-decision-log.md#adr-046--storefront-search-asks-the-core-which-finds-products-in-postgres-as-the-admins-search-does-until-typesense)).
  A search matches `search_text`, folded by `searchKey` from `@hatti/pk`: fold what is typed the
  same way, and never match the fields as they were written. When Typesense comes, it answers the
  same request. The shop's pages and articles are found by the online store at
  `/storefront/shops/{shop}/search/content`, each keeping its words with `contentSearchText`
  whenever its title, names or text change
  ([ADR-212](../architecture/13-decision-log.md#adr-212--a-storefronts-search-finds-the-shops-published-pages-and-articles-beside-its-products-as-shopifys-does-by-the-words-each-keeps-folded-through-the-online-stores-own-search-in-the-core-products-then-pages-then-articles-the-kinds-shopifys-type-names-and-suggested-as-a-shopper-types)).
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
  what was paid and the balance due; a registered shop's are sales tax invoices, naming its
  NTN and STRN (ADR-190), though not yet in a series of their own (TAX-05) or through FBR's
  digital invoicing (TAX-04).

## Files

* **Files are kept by key in `ObjectStorage`** ([ADR-079](../architecture/13-decision-log.md#adr-079--files-are-kept-in-object-storage-under-each-shops-prefix-uploaded-straight-there-through-urls-the-admin-api-signs-and-shown-only-through-short-lived-signed-urls-a-directory-stands-in-for-r2-in-development)), which the host gives every
  module: `S3Storage` (R2, through the S3 API) in production, `LocalStorage` (a directory the
  core serves at `/storage`) in development and tests. Code asks storage for what it needs, never
  for a driver: `signUpload` and `signDownload` for clients, `head`, `readStart`, `put` and
  `delete` for the core itself.
* **A shop's files are under `shops/{shopId}/`**, and a module's under a prefix of its own
  there, such as `shops/{shopId}/files/{fileId}/{name}`. Keys are plain segments
  (`isObjectKey`): never put what someone typed in one unchanged.
* **Nothing is public.** A file is shown through `signDownload`, for an hour at most, by its name,
  and only to those who may see what it belongs to.
* **Bytes go straight to storage.** Clients upload through a URL signed for the exact size and
  type (`signUpload`), as `stagedUploadsCreate` gives; the core checks the upload is in, of that
  size, and that its first bytes are its type's (`looksLike`) before it counts as a file, and
  removes it otherwise. Only a page without scripts sends a file through the core.
* **A page without scripts sends its file in a form** (`multipart/form-data`), which the core
  reads only on the paths it lists (`readFileForms`): orders' and drafts' pages, for the
  receipts of transfers and advances ([ADR-080](../architecture/13-decision-log.md#adr-080--a-customer-sends-the-receipt-of-their-transfer-through-their-orders-page-in-a-form-the-core-reads-and-keeps-in-storage-by-order-the-shop-sees-it-with-the-order)). One file, of a limit set there, held in memory; past it, the rest is
  dropped and the file marked `truncated`, so the page can say it is too large. Elsewhere such a
  form is refused (415). What the file is comes from its first bytes (`sniffContentType`), never
  from the browser. Storage takes it before any transaction, so none waits on storage; what the
  transaction then refuses, or a failure, is removed.
* **A file goes after the record that names it, by the worker** ([ADR-113](../architecture/13-decision-log.md#adr-113--an-erased-customers-receipts-leave-storage-too-the-erasure-records-each-orders-receipt-files-in-an-event-and-the-worker-removes-them-once-it-commits)):
  the transaction that deletes the record appends an event naming the file's key, and the
  worker removes it once that commits, as `ErasedReceipts` does for `order.receipts_erased`.
  The handler removes only keys under the record's own prefix. The worker reads the API's
  storage settings, so the two name the same place.
* **Checkout's limits count orders, not attempts** ([ADR-087](../architecture/13-decision-log.md#adr-087--checkout-takes-at-most-three-orders-a-day-from-one-mobile-number-and-twenty-an-hour-from-one-internet-address-counting-the-orders-it-placed-one-at-a-time)):
  `checkoutOrdersFrom` counts the shop's checkout orders by number in the last day and by
  internet address in the last hour, after taking the placement transaction's advisory locks on
  the number and then the address, always in that order, so concurrent placements count one at
  a time without deadlocking. An address is used only if `isIP` takes it, as orders keep it.
  Both counts take checkout's orders alone (`source = 'online_store'`): orders that came another
  way keep addresses too, such as drafts confirmed through their links.
* **Trust badges are the platform's words and the shop's choice** ([ADR-086](../architecture/13-decision-log.md#adr-086--a-shop-chooses-trust-badges-for-its-checkout-from-the-platforms-set-worded-in-english-and-urdu-and-shown-under-the-button-where-they-hold)):
  a `TrustBadgeValue` names one of the set, with days for an exchange or returns alone;
  `checkTrustBadges` checks a list without the database, and the service checks the WhatsApp
  number it needs. The page words each in English and Urdu and drops those that don't hold for
  it (`badgeList`), so none is shown untrue: nothing the shop types reaches it.
* **A form whose answer sends the browser to another site names that site's origin in
  `renderPage`'s `formTargets`**, as the order's page names its shop's payment gateway's checkout
  (`OnlineGateway.origin`): browsers such as Chrome hold a form's redirects to the page's
  `form-action`, which is `'self'` alone otherwise. Name origins alone, https or this machine's,
  and only those the page's forms go on to.
* **A page that shows a file, such as the shop's logo on the checkout's, signs its URL as it is
  made** and names it in `renderPage`'s `images`, so the page's policy allows that image and no
  other ([ADR-081](../architecture/13-decision-log.md#adr-081--a-shops-logo-is-one-of-its-files-chosen-as-its-brands-the-checkouts-page-shows-it-in-place-of-the-shops-name-through-a-url-signed-for-an-hour-that-the-pages-policy-allows-alone)): its address without the signature, https, or http on localhost.
* **A file another module needs is found through the files module's public functions**, in the
  caller's transaction, as `shopLogoOf` gives a page the logo's key; never by reading its tables.
* **The shop's logos are served by the API, never signed, wherever a page is kept**
  ([ADR-205](../architecture/13-decision-log.md#adr-205--a-shops-brand-has-shopifys-square-logo-beside-its-logo-one-of-its-files-served-by-the-api-at-an-address-of-its-own-the-shops-document-names-where-each-logo-is-served-each-address-naming-its-file-and-the-link-page-shows-the-square-logo-else-the-logo-at-its-top)):
  `/logos/{shop}` and `/logos/{shop}/square`, an hour in browsers. `shopLogoOf(tx, shop, which)`
  gives each with its file's `id`, which `logoPathOf` puts in the address the shop's document
  names (`?v=`), so another image is another address; the publisher rebuilds the document on
  `shop_brand.updated` and `file.deleted`. Another image of the brand goes in `BRAND_IMAGES`, the
  table, the route and the document together.
* **An article's image is served the same way**, at `/article-images/{shop}/{article}` while the
  article is published ([ADR-213](../architecture/13-decision-log.md#adr-213--an-article-has-shopifys-image-one-of-the-shops-files-with-its-alt-text-the-api-serves-it-at-an-address-of-its-own-while-the-article-is-published-the-address-naming-its-file-the-articles-document-names-that-address-and-hatti-base-shows-it-in-its-blog-and-on-the-articles-page)): a module keeping
  one of the shop's files for a page checks it with `readyImagesIn` when it is chosen and again
  when it is shown, keeps no key to the files module's tables, and has the publisher follow
  `file.deleted`.
* **Tests use `LocalStorage` in a temporary directory**: the API's test harness serves one at
  `http://localhost:4000/storage`, so a test uploads and reads through the URLs it was given.

## Customers

* **A customer is whoever a mobile number belongs to**, one per number (E.164) per shop
  ([ADR-011](../architecture/13-decision-log.md#adr-011--phone-first-shopper-identity)). A customer needs only a number; name and email
  are optional.
* **A customer can have other numbers** besides their main one, such as a second SIM, up to 10
  (`otherPhones`); `customers.customer_phones` holds every number, so each belongs to one
  customer ([ADR-026](../architecture/13-decision-log.md#adr-026--a-customer-can-have-several-numbers-modules-with-customer-data-join-merges-and-erasure)).
  Orders, searches and the blocklist's `customer` find a customer by any of them; `blocked`
  counts any of them. Marketing consent is for the main number only. A new main number drops the
  old one unless `otherPhones` lists it. Imports match customers by main numbers; their other
  numbers travel in an Other phones column, which exports write and imports read ([ADR-109](../architecture/13-decision-log.md#adr-109--a-customers-other-numbers-travel-in-a-csv-column-of-their-own-after-the-main-number-in-exports-and-in-imports-a-new-customers-or-on-overwrite-in-place-of-an-existing-ones)).
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
  * `deliveryHistory` counts orders by how they ended up (delivered, returned, lost, cancelled,
    in progress), for the Confirmation Desk. A refused parcel counts as returned from when it
    starts coming back, though the courier then loses it; one lost before reaching them, as lost;
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
  ones with one of their numbers or their email. Their receipts for transfers are deleted, and
  each order's `order.receipts_erased` event has the worker remove their files. It is a
  `customer.erased` event, and cannot be undone. Their next order starts a new customer.
  Blocklist entries stay: they are the shop's record of a number.
* **Erasure asked for ahead** (`customerErasureRequest(id)`) happens in ten days
  (`ERASURE_WAIT_DAYS`), unless `customerErasureCancel(id)` stops it first
  ([ADR-110](../architecture/13-decision-log.md#adr-110--a-customers-erasure-can-be-asked-for-ten-days-ahead-and-cancelled-until-then-the-workers-sweep-carries-it-out-as-the-system-naming-who-asked)).
  The customer's `erasureScheduledAt` says when; asking again keeps the first time.
  `customers.erasure_requests` holds who asked and when, a row per customer. The worker's sweep
  then erases them as `customerErase` would, as the system: their orders' timelines say so, and
  the `customer.erased` event and audit entry name who asked, with `requestedAt`. One with an
  order still open waits for a later sweep. A duplicate whose erasure waits can't be merged into
  another customer (`INVALID`); erasing at once takes the request with the customer. Handlers'
  `erase` get `'system'` as the actor then.
* **A customer's own data** (`customerDataExport(id)`), at their request, is one JSON file,
  `customer-cus_….json`, for an owner or manager to give them
  ([ADR-102](../architecture/13-decision-log.md#adr-102--a-customers-own-data-is-one-json-file-of-everything-the-shop-keeps-of-them-which-each-module-with-their-data-adds-to-the-blocklist-and-risk-scores-stay-out)):
  their profile with every number, marketing consent and its history, `orders` whole (items,
  amounts in major units, contact details, address, note, tags, what they agreed to and from
  where, parcels, refunds, calls to confirm and receipts sent), `draftOrders` found as erasure
  finds them, and `discountCodeUses`. Its `format` is `hatti.customer-data/1`; a new shape is a
  new version. The rule: everything erasure would take, and the records it would keep while they
  name the customer. The shop's defences against fraud stay out (the blocklist, orders' risk
  scores and reasons, and timelines, which hold the reasons for holds), as does which of the
  staff did what. It takes `write_customers` and `read_orders`, and each export is an audit
  entry, `customer.data_exported`.
* **Timeline messages never hold contact details** (numbers, emails, streets), so erasure leaves
  them as they are. What staff write in notes is theirs to keep clean.
* **Modules with customer data** register a `CustomerDataHandler` at start-up: what stops an
  erasure, how to move data on a merge (run before and after the numbers move, so it must be
  safe to repeat), how to erase it, and what to give the customer in their own export, as
  sections of the file named for the module's data (`orders`, `draftOrders`). Erasing and
  exporting get the customer's numbers and email too (`CustomerIdentity`), for records that name
  no customer, such as draft orders. A field a module adds to what erasure clears goes into its
  export too. The worker erases too, so a new handler joins `workerCustomerDataHandlers` as well;
  a test holds it equal to the API's registry.
* **The consent ledger** changes only through `customers.move_consent_history` and
  `customers.erase_consent_history`, which merges and erasures call; both act only in the
  caller's shop.
* **Scopes:** `read_customers` and `write_customers`, which merging and erasure need too, and a
  customer's own export with `read_orders`. An order's `customer` needs `read_customers`; a
  customer's orders and stats need `read_orders`.
* **Search** takes a mobile number in any format, four or more of its digits (found anywhere in
  the number), or words of the name or email.

## Who sees customers' numbers

* **Owners, managers and apps see numbers whole; every other staff role sees them masked**,
  "0300 ••••567", wherever they appear: orders and their addresses, customers and their other
  numbers, the blocklist and consent history
  ([ADR-027](../architecture/13-decision-log.md#adr-027--customers-numbers-are-masked-by-role-and-reveals-go-to-an-append-only-audit-log)).
  `ROLE_PHONE_ACCESS` in `@hatti/api` says who; `shownPhone(tenant, e164)` masks.
* **Only the GraphQL mappers mask.** Services, events, CSV exports and a customer's own file
  (owners and managers only) work with whole numbers; a mapper that shows a number takes the
  caller's tenant.
* **Confirmation agents reveal** a number with `orderPhoneReveal(id)` or
  `customerPhoneReveal(id)`. Roles that only see numbers masked (packers, marketers,
  accountants) get `ACCESS_DENIED`. Every reveal is an audit entry.
* **Staff who see numbers masked search by whole numbers only**, for customers and the
  blocklist: matching four digits anywhere would let them rebuild a number digit by digit. An
  agent can still find the customer or order of someone who calls.

## Audit log

* **`platform.audit_log`** records what a shop may need to account for later: who did it (app,
  staff member and the role then, or Hatti's support), what (`customer.phone_revealed`,
  `order.phone_revealed`, `customers.exported`, `customer.merged`, `customer.erased`,
  `customer.erasure_requested`, `customer.erasure_cancelled`, `customer.data_exported`,
  `shop.ownership_transferred`, `order_risk_settings.updated`, `order.refunded`,
  `orders.exported`, `support.access_granted`, `support.access_ended`, `support.looked`), to
  which customer, order or shop, and details as the API has them (public IDs, amounts in major
  units). Never contact details.
* **`recordAudit(tx, shopId, entry)`** (`@hatti/events`) writes in the caller's transaction, so
  an entry stands only if what it describes does. Request code cannot change or delete entries.
* **`auditLog(first, after, subjectId, action)`** reads them, newest first, with
  `read_settings`: owners and managers.

## COD risk

* **Cash-on-delivery orders are scored** for how likely they are to come back unpaid (COD-06),
  when they are placed and when their address changes, and the score is kept on the order
  ([ADR-025](../architecture/13-decision-log.md#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)),
  and again while they wait to be confirmed, as the customer's history changes (below).
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
* **Scored again as the customer's history changes**
  ([ADR-112](../architecture/13-decision-log.md#adr-112--an-order-waiting-to-be-confirmed-is-scored-again-when-its-customers-history-changes-by-the-worker-a-score-that-makes-it-risky-holds-it-and-a-held-order-stays-held)):
  a parcel of theirs delivered, refused, back or lost, an order of theirs cancelled, or another
  customer merged into them. The worker's `RiskRescoring` takes those events (`fulfillment.updated`
  with its status changed, `order.cancelled`, `customer.merged`) and calls `rescoreRisk`, which
  scores the customer's open, unshipped cash-on-delivery orders still `pending` or `needs_review`.
  A different score goes on the timeline (`rescored`, by the system) and in an `order.updated`
  event naming `risk`. A pending order the new score makes risky, as the old did not, is held as
  at placement; a held one stays held. The duplicate rule then counts orders placed in the 6
  hours before the order, not before now. A rule reading other orders must stay right when
  scored again later.
* **The policy:** `orderRiskSettings` and `orderRiskSettingsUpdate` read and set the threshold
  (0.01 to 1 in hundredths, or null to hold none) and the high-value amount. A change applies to
  orders placed or re-addressed afterwards, and is an `order_risk_settings.updated` event naming
  who made it.
* **Scopes:** `read_settings` and `write_settings`, for shop settings and policies; owners and
  managers have them. The order's `risk` needs only `read_orders`.
* **Events:** `order.created` carries the order's `riskLevel`; `order.updated` names `risk` when
  the order was scored again.

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
* **Checkout records the boxes ticked on its page** ([ADR-187](../architecture/13-decision-log.md#adr-187--a-shops-checkout-offers-a-box-for-its-news-and-offers-on-each-channel-it-chooses-whatsapp-until-it-does-unticked-until-the-shopper-ticks-it-a-box-ticked-records-the-customers-consent-as-the-order-is-placed-in-the-words-beside-it-where-the-number-or-email-typed-is-the-customers-own)):
  `checkoutMarketingIn` gives the channels the shop offers (`checkout.marketing_options`,
  WhatsApp alone without a row), and the page draws a box for each, never ticked beforehand,
  each its own field (`MARKETING_FIELDS`), which the form keeps as `marketing`, the channels
  ticked. Once the order is placed, `recordCheckoutConsentIn` subscribes its customer on each,
  source `checkout`, by the system, in the box's words (`marketingWording`, the English and the
  Urdu the page showed), where what was typed is the customer's own contact for it: the main
  number for WhatsApp and SMS, their email for email. It locks the customer after the number
  the order found them by, in the order's transaction.
* **The storefront's sign-up form is Shopify's customer form** ([ADR-189](../architecture/13-decision-log.md#adr-189--shoppers-sign-up-for-a-shops-news-and-offers-on-whatsapp-through-its-online-stores-form-as-shopifys-customer-form-posts-it-the-storefront-sends-the-number-on-to-the-core-which-keeps-it-as-consent-from-the-storefront-in-the-words-the-form-showed-for-the-customers-main-number-and-the-form-comes-back-to-its-page-saying-how-it-went)):
  `{% form 'customer' %}` posts to `/contact`, in the page's language; the storefront sends
  `contact[phone]`, `contact[tags]` and `contact[consent]` on with `StorefrontApiClient.signUp`,
  and back to the page (`return_to`, else the shop's own referring page, else home) with
  `customer_posted=true` or `customer_error=<fields>`, which the form tag turns into
  `form.posted_successfully?` and `form.errors`. In the core, `SignUpService` finds or makes the
  customer (`findOrCreateCustomerIn`, source `storefront`) and subscribes their main number on
  WhatsApp from the `storefront`, in the form's words or `marketingWording`'s, which checkout's
  boxes share.

## Ad platforms

* **What goes to an ad platform waits in Postgres, and only the worker sends it**
  ([ADR-143](../architecture/13-decision-log.md#adr-143--orders-placed-through-checkout-go-to-metas-conversions-api-from-the-worker-as-they-are-placed-confirmed-and-delivered-the-shop-choosing-which-is-purchase-each-moment-waits-in-postgres-until-meta-takes-it-or-its-seven-days-are-up)).
  An event handler records an order's moment, once by the table's unique key
  (`ConversionsService.recordPlaced`, `recordAfterPlaced`), and `ConversionsSender` sends what
  is due. It takes moments with `claim`: a materialized CTE locks them `FOR UPDATE SKIP LOCKED`,
  so no two senders take one, and no subquery run again takes more. It settles each with
  `settle`. Never call a platform from an event handler or from a request: a failing call would
  run the event's other handlers again, or fail what the request did.
* **A new platform** adds its name to `marketing.conversions`' check, and a client like
  `MetaConversionsClient`, whose `send` says whether to try again.
* **Customers' details leave hashed, as each platform normalises them** (`metaUserData` is
  Meta's). Nothing of an erased customer's goes (`OrderConversionFacts.erased`). The browser's
  address, its user agent and the ad's click ID go as they are, as the platforms ask.
* **A platform's token is sealed for its shop** (`SecretBox`, bound to `meta-conversions:{shop}`).
  `metaConversionsUpdate` alone changes it, with `write_pixels` and recent authentication,
  audited by what changed and the token's last four characters. Only the worker opens it, and
  needs `ENCRYPTION_KEYS` to. Tokens go in requests' bodies, never their addresses, so no access
  log keeps them.
* **A moment's event ID is the order's number and the moment** (`order-1043-delivered`), however
  often it is sent: the platforms keep one. Only the server sends an order's moments: checkout's
  page runs no scripts, and the pixel sends none of them.
* **A platform's pixel is the storefront's**
  ([ADR-144](../architecture/13-decision-log.md#adr-144--a-shops-storefront-loads-its-meta-pixel-while-meta-is-connected-for-the-steps-shoppers-take-before-checkout-orders-go-from-the-server-alone-each-keeping-the-pixels-browser-and-click-ids-for-them)).
  The shop's document names it (`ShopDoc.metaPixelId`) only while the shop has the platform
  connected, and leaves it out otherwise, so other shops' documents stay as they were.
  `metaPixelScript` loads it on shoppers' pages, never in previews or the editor's frame. Pages
  are everyone's, kept at the edge, so a pixel's script knows only the page's product, by the
  catalog feed's IDs (`pixelProduct`); what shoppers do it reads from the forms they send,
  listening in the capture phase, before the theme's own scripts. Never put a shopper's cart or
  details in a page for a pixel.
* **A pixel's cookies reach the server's events through the order.** The storefront reads them as
  the order is placed (`browserIdsOf`) and passes them in `x-hatti-client-browser-ids`; the orders
  module keeps those in the platform's format (`orders.browser_ids`), and erasure clears them with
  the address the order was placed from. A new platform's cookie adds its name to
  `BrowserIdsValue` and to both `browserIdsOf`s.

## Messages to customers

* **A message to a customer waits in Postgres, and only the worker sends it**
  ([ADR-146](../architecture/13-decision-log.md#adr-146--a-shops-customers-hear-of-their-orders-from-hattis-shared-whatsapp-number-or-by-sms-where-the-shop-saves-or-whatsapp-cannot-deliver-each-message-waits-in-postgres-queued-once-from-the-orders-events-until-the-worker-sends-it-and-whatsapps-webhook-follows-it-and-hears-customers-ask-to-stop)). Queue it with
  `MessagesService.queueIn`, in the transaction that read what it says, with a key that names
  what it is about once (`order_shipped:<parcel>`): an event heard twice queues it once. The
  shop's settings choose its channel and language, and leave out a notification turned off; a
  message for a member of staff names theirs in `language` (ADR-194).
  `MessagesSender` in the worker takes what is due with `claim` (a materialized CTE locked
  `FOR UPDATE SKIP LOCKED`, as conversions are) and records each message with `settle` as soon as
  it is sent, before the next: WhatsApp's webhook may tell of it within seconds. Never call a
  provider from an event handler or a request.
* **A new kind of message** adds its name to `MESSAGE_KINDS`, its WhatsApp template's name and
  variables and its SMS's words in English and Urdu to `TEMPLATES`, and its enum value to
  `MessageKind`; a kind that is only news goes in `INFORMATIONAL`, for shops that send news by
  SMS. Its template is approved for Hatti's number before it ships: one that is not fails, and
  goes by SMS.
* **The shop's own alerts** ([ADR-157](../architecture/13-decision-log.md#adr-157--the-shop-hears-on-whatsapp-when-a-variant-runs-low-on-stock-and-again-when-it-runs-out-at-the-number-it-gives-for-hattis-alerts-once-for-each-spell-of-low-stock-which-inventory-keeps-until-the-variant-is-stocked-above-the-threshold-again-the-worker-hears-each-levels-change-and-queues-the-alert-as-a-message-the-shops-credit-pays-for)) go as messages too, to the number it gives for them
  (`settings.alertsPhone`), with no customer or order; none is queued while it gives none. Keep
  the number off the audit log and out of events, as any contact detail. Hatti's notices of the
  shop's bills go there too ([ADR-169](../architecture/13-decision-log.md#adr-169--hatti-tells-a-shop-on-whatsapp-at-the-number-it-gives-for-hattis-alerts-when-its-plans-next-period-is-invoiced-when-its-plan-ends-unpaid-and-when-its-message-credit-falls-below-rs-100-each-once-queued-with-its-messages-from-billings-events-at-hattis-cost-whatever-its-credit-and-never-turned-off)), queued by the worker's
  `BillingNotices` from billing's events: their templates say `hattiPays`, so that `paidByShop`
  keeps both settling and the sender's credit check from charging the shop for them, and they
  are in `ALWAYS_SENT`. Each is queued as an email to the owner too
  ([ADR-195](../architecture/13-decision-log.md#adr-195--a-shops-owner-hears-of-its-bills-with-hatti-by-email-too-at-the-address-their-account-proved-and-in-their-own-language-from-hattis-own-address-the-worker-finds-them-through-identitys-functions-for-the-shop-alone-and-queues-each-email-with-the-shops-messages-at-hattis-cost-with-an-alerts-number-or-without)), whether or not the shop
  gives a number: `ownerEmailIn` gives their proved email and language through identity's
  functions, the message is keyed by the notice's key and `:email`, and `messageEmail` marks it
  `from: 'hatti'`, which `SesMessageEmails` sends from `EMAIL_FROM` itself.
* **Staff's own alerts** ([ADR-191](../architecture/13-decision-log.md#adr-191--a-member-of-staff-hears-on-whatsapp-at-the-number-their-account-signs-in-with-of-an-order-someone-else-gives-them-and-of-a-comment-that-names-them-as--and-their-name-the-orders-events-say-which-the-worker-finds-whom-through-the-identity-login-and-each-is-one-of-the-shops-alerts-paid-from-its-credit)) go
  to the number each member's account signs in with, from `staffPhonesIn`, which reads
  `identity.staff_phones` in the shop's own transaction, as `identity.staff_email` gives staff's
  emails ([ADR-193](../architecture/13-decision-log.md#adr-193--the-worker-reads-staffs-numbers-as-it-reads-their-emails-through-a-function-of-identitys-that-answers-for-the-shop-of-its-transaction-alone-never-identitys-tables-staffs-alerts-need-no-identity-login)): the worker never reads
  identity's tables, and never sends to a number the shop keeps. Each goes in the member's own
  language, which `staff_phones` gives too (ADR-194). The orders module says what happened in events that name accounts and comments,
  never a comment's words (`order.assigned`, `order_comment.created`, `order_comment.updated`),
  and `StaffAlerts` finds whom to tell: `mentionsIn` finds the members a comment names as `@` and
  their name, and `staffAlertFactsIn` reads the order and the comment as they are now. A new
  alert for staff is a `MessageKind` queued the same way, once by a key naming what it tells of
  and the member, and its words name the shop and the order but nothing of the customer.
* **A provider's `send` says what to do with a refusal:** `retry` for what may pass (a 5xx, a 429,
  a provider not reached), `replace` for what WhatsApp will never deliver, which an SMS replaces
  once, and `fail` for the rest. A provider's answer of success is final: a message sent is never
  sent again, though its ID is missing.
* **Webhooks are signed over their raw bodies.** The API keeps the body of every request under
  `/webhooks/` as `rawBody` (`keepRawBodies`), and a controller checks the signature against it
  before it reads anything. A webhook names messages across shops: it finds them through a
  `SECURITY DEFINER` function (`messaging.resolve_provider_messages`,
  `messaging.resolve_last_sender`), as order links do, and changes them as their shop. What it
  hears may come twice: statuses move a message forward only, and an opt-out is kept once.
* **A customer who says stop hears no more from the shop on that channel** (`optOut`): the opt-out
  stays through erasure, and `MessagesSender` checks it before every send, as a message queued
  before it may still wait.
* **A customer's answer is an event, and the worker acts on it**
  ([ADR-147](../architecture/13-decision-log.md#adr-147--a-cash-on-delivery-order-waiting-for-its-customer-asks-them-on-whatsapp-to-confirm-it-with-confirm-cancel-and-change-address-buttons-and-its-link-their-answer-comes-through-the-webhook-as-an-event-and-the-worker-confirms-or-cancels-the-order-as-their-link-would)). A template's quick replies carry
  payloads set as the message is sent (`TEMPLATES[kind].buttons`); the webhook records the one
  pressed as `message.replied` in the message's shop, and nothing more. A handler in the worker
  reads it by the message's kind, and calls the module that owns what it changes
  (`CustomerAnswers` for orders), which keeps the same rules as a customer's link does. Answers
  are heard twice at times: each handler does its work once.
* **A message that holds a secret marks its template `secret`** (a code, [ADR-148](../architecture/13-decision-log.md#adr-148--checkout-asks-a-shopper-paying-on-delivery-for-a-code-sent-to-the-number-they-typed-on-whatsapp-or-by-sms-where-the-shops-risk-rules-score-the-order-at-its-mark-a-digest-of-the-code-alone-is-kept-and-the-order-keeps-when-its-number-was-proved)): the
  engine drops the secret from the message once it is sent, or will never be, after an SMS in its
  place took it, and sends no SMS for it later. A shopper asks for another instead. Such kinds
  go in `ALWAYS_SENT` when shops must not turn them off.
* **A link a message carries is made once the message is queued**, in the same transaction
  (`queueIn` returns the new message's ID, or null; `linkIn` then adds the link), so an event
  heard twice makes neither a second message nor a second link. An order's later messages carry
  the link it has ([ADR-160](../architecture/13-decision-log.md#adr-160--each-parcels-way-is-kept-step-by-step-as-shopifys-fulfillmentevent-its-couriers-changes-recorded-once-from-the-workers-tracking-and-staffs-for-couriers-hatti-does-not-follow-the-orders-page-shows-them-the-latest-first-in-english-and-urdu-the-shipped-message-links-that-page-and-a-parcel-out-for-delivery-with-cash-to-collect-tells-its-customer-what-to-keep-ready)): pass the links its messages carried (`linksIn`) to `messageLinkIn`,
  which keeps one still the order's and working, and makes a new one only otherwise, as making
  one replaces the order's last.
* **The news of an order goes to its email too** ([ADR-181](../architecture/13-decision-log.md#adr-181--a-shops-customers-hear-of-their-orders-by-email-too-where-they-gave-one-at-checkout-each-message-about-an-order-queues-a-copy-for-the-address-with-the-same-words-and-link-which-the-worker-sends-through-amazon-ses-from-hattis-address-under-the-shops-name-emails-cost-the-shop-nothing)):
  pass `email: order.email` to `queueIn` with any message to an order's customer, and it queues
  a copy for the address, lowercased, keyed by the message's key and `:email`, when the kind has
  an email `subject` in `TEMPLATES` (`EMAILED_KINDS`). `linkIn` gives the copy the message's link.
  The worker gives an order with an email its shop's look
  ([ADR-198](../architecture/13-decision-log.md#adr-198--an-email-of-an-orders-news-is-laid-out-as-its-shops-own-under-its-logo-served-at-an-address-of-the-apis-that-lasts-as-an-email-does-or-its-name-in-its-themes-accent-colour-with-the-orders-first-ten-lines-and-its-total)): `accent`, `logo` (the
  API's `/logos/{shop}`), `items` (a line each, its name and quantity, a tab, its total, ten at
  most) and `more`, which `messageEmail` lays out; keep a message's variables within 4 KB.
  A new kind of news gives its template a `subject` in English and Urdu; an answer to a button, a
  code or an alert to the shop gives none. Hatti's notices of the shop's bills have one too, for
  their emails to its owner (ADR-195). SES's notifications move each email's message on
  ([ADR-197](../architecture/13-decision-log.md#adr-197--an-email-hatti-sends-for-a-shop-is-delivered-or-failed-for-good-as-sess-notifications-on-hattis-sns-topic-say-identity-hears-the-topic-and-passes-each-notification-on-and-messaging-moves-the-emails-message-by-the-id-ses-gave-it-as-whatsapps-statuses-move-its-messages)): identity's feedback
  service passes each to `onNotification`, which `createApi` points at
  `MessagesService.recordEmailEvent`; `emailStatusOf` reads delivered or failed for good, and
  `recordStatuses(updates, SES_EMAIL)` moves the message SES gave the ID, sent as `ses`. The shop's credit never pays for an email
  (`chargedFor`), and `PhoneChannel` names the channels a code or a reply goes by.

## Import and export

* **CSV through `@hatti/csv`:** `parseCsv` reads RFC 4180 files (quotes, line breaks in cells,
  CRLF, LF or CR, a byte-order mark); `toCsv` writes CRLF with a byte-order mark, so Excel shows
  Urdu, and puts an apostrophe before text that a spreadsheet would run as a formula (`=`, `+`,
  `-`, `@`). Write quantities as numbers, which it leaves as they are: one below zero, as text,
  would take the apostrophe, which a reader of numbers then strips.
* **Customer imports** (`customersImport`) take Hatti's own export, Shopify's customer export or
  a spreadsheet with a Phone column (Mobile, or Shopify's Default Address Phone, also work);
  headings are matched ignoring case, spaces and underscores. Rows that fail are reported by row
  number and column, and the rest go in, in one transaction. Customers already here are left as
  they are unless the import overwrites them. `dryRun` counts what would happen. Consent columns
  take yes, no, subscribed and unsubscribed; consent goes into the ledger with the source `import`.
  Other phones, separated by commas, semicolons or slashes, are checked with `checkOtherPhones`,
  as `customerUpdate` checks them, and against every number in the file and the shop; a list
  replaces a customer's on overwrite, and a blank cell leaves them.
* **Product imports** (`productsImport`) take Shopify's product export
  ([ADR-059](../architecture/13-decision-log.md#adr-059--a-shopify-product-export-is-imported-product-by-product-as-productcreate-makes-them-keeping-their-handles-the-core-sets-the-stock)):
  `readShopifyProducts` in the catalog groups its rows by handle and reads them as Shopify writes
  them; `ProductImportService` makes each product through `ProductService.create`, checked first
  with `checkCreate`, which a dry run stops at, then adds its images through `MediaService`. A
  field error is said at the row and column it came from (`located`). The stock Shopify tracked
  comes back as `ImportedStock` for the core to set through inventory, which the catalog cannot
  reach. A new Shopify column the import should read joins `COLUMNS`, with a test from a real
  export.
* **Product exports** (`productsExport`) write the same file
  ([ADR-129](../architecture/13-decision-log.md#adr-129--products-leave-as-shopifys-product-csv-a-file-the-import-takes-back-whole-filtered-as-the-products-list-is-each-tracked-variants-stock-for-callers-who-may-read-it-a-larger-catalog-in-parts-the-import-links-variants-to-their-images)):
  `writeShopifyProducts` writes the rows `readShopifyProducts` reads, under
  `SHOPIFY_PRODUCT_HEADINGS`, and `ProductExportService.export` counts the rows a search's
  products take before it reads any, refusing past `PRODUCT_EXPORT_LIMITS`, which are the
  import's, so that every export can be imported back whole. Stock comes from the caller
  (`ExportStock`), the core asking inventory for those who may read it. A column the export
  writes is one the import reads back, and the round trip into another shop is tested: change
  them together.
* **Imports that overwrite** ([ADR-130](../architecture/13-decision-log.md#adr-130--told-to-overwrite-an-import-updates-the-shops-products-from-the-file-fields-from-the-columns-it-has-a-blank-cell-clearing-an-optional-one-variants-matched-by-their-option-values-and-new-ones-added-options-and-stock-stay-the-admins-and-inventorys)) update a product the shop has through the services the
  admin uses, `ProductService.update` and `VariantService.bulkUpdate` and `bulkCreate`, never by
  writing rows: what the file has comes from `ShopifyFileResult.columns`, so that a missing
  column leaves a field alone while a blank cell clears an optional one. A product's changes are
  all checked first (`checkCreate`, `checkVariantFields`, the count of variants), and its
  variants are matched by their option values, never by position or SKU, so their IDs last.
  Stock stays inventory's: an update reports stock only for the variants it made.
* **Stock files** ([ADR-133](../architecture/13-decision-log.md#adr-133--stock-leaves-and-comes-back-as-shopifys-inventory-csv-a-row-for-each-tracked-variant-at-each-active-location-named-by-handle-options-and-location-a-count-sets-on-hand-where-on-hand-new-says-and-refuses-a-row-whose-on-hand-changed-since-the-file-was-exported)) are Shopify's inventory CSV, all its states:
  `writeShopifyInventory` and `readShopifyInventory` in the catalog, under
  `SHOPIFY_INVENTORY_HEADINGS`, and `StockFileService`, which finds a search's products for an
  export, refusing past `STOCK_FILE_LIMITS`, the import's, and a file's rows' variants by handle
  and option values. The stock is the core's to give and set (`inventory-file.resolver.ts`):
  levels through `InventoryService.itemsOf`, counts through `setQuantities`, 250 at a time, each
  with On hand (current) as its compare quantity, a row whose on hand changed since being
  refused before any is set. A row names what a spreadsheet keeps, a handle, option values and a
  location's name, never an ID.
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
* **Limits:** 1.5 million characters per import; 5,000 rows for customers', products' and stock
  files', and 20,000 for redirects'; 10,000 customers per export.

## Staff sign-in

Staff identity is its own module (`@hatti/identity`); why it is built in-house is in
[ADR-020](../architecture/13-decision-log.md#adr-020--staff-identity-built-in-house-on-audited-primitives).

| Endpoint | Purpose |
|---|---|
| `POST /auth/sign-up` | Create an account; returns tokens |
| `POST /auth/shops` | Open a shop of the signed-in user's own, `{ name, handle? }`: the user is its owner, and its storefront is published at its handle's subdomain |
| `POST /auth/sign-in` | Email and password. Returns tokens, or `mfa_required` with a `challengeToken`, the `methods` that answer it and, for a passkey, `passkeyOptions` |
| `POST /auth/sign-in/verify` | The second step: an authenticator code, a recovery code or a passkey's response |
| `POST /auth/sign-in/passkey/options`, `POST /auth/sign-in/passkey` | Sign in with a passkey alone; the session has passed the second factor |
| `POST /auth/phone/code` | Send a code to a Pakistani mobile, `{ phone, channel?, language? }`: on WhatsApp unless `sms` is asked for or WhatsApp cannot deliver it; returns the number masked, the channel it went by, when it expires and when another may be sent |
| `POST /auth/phone/sign-in` | The number and its code, `{ phone, code }`. Returns what `/auth/sign-in` does for the account whose number it proves, or `sign_up_required` with a `signUpToken` for a number no account has |
| `POST /auth/phone/sign-up` | Open an account with a number just proved, `{ signUpToken, name, email? }`; returns tokens (201) |
| `POST /auth/phone` | Prove a number for the signed-in user's account with the code sent to it, `{ phone, code }`, from a session proved lately: it signs the account in from then on, in place of any before it |
| `DELETE /auth/phone` | Take the number off the signed-in user's account, from a session proved lately, while another way in remains: a proved number signs in to nothing then, and is told (ADR-202) |
| `POST /auth/google/options` | Start Google's sign-in: the admin's client ID and a nonce, good once for ten minutes |
| `POST /auth/google/sign-in` | Google's ID token, `{ idToken }`. Returns what `/auth/sign-in` does for the account the Google account is connected to, or signs in to an account it opens (`signedUp: true`) |
| `POST /auth/google`, `DELETE /auth/google` | Connect a Google account to the signed-in user's, `{ idToken }` (201), or disconnect it |
| `POST /auth/email/verification`, `POST /auth/email/verify` | Send the signed-in user a link proving their email, `{ language? }`; prove it with the link's token, `{ token }` |
| `POST /auth/password/forgot`, `POST /auth/password/reset` | Send a reset link to an account's email, `{ email, language? }` (202, whether or not an account has it); set a new password with its token, `{ token, password }` (204) |
| `POST /auth/refresh` | Swap a refresh token for new tokens |
| `POST /auth/sign-out` | End the current session |
| `GET /auth/me` | The user, the session, the shops they can open and the Google account connected |
| `POST /auth/language` | The language Hatti's emails and messages to the signed-in user are in, `{ language }`, `en` or `ur` ([ADR-194](../architecture/13-decision-log.md#adr-194--an-account-keeps-its-own-language-english-or-urdu-as-its-owner-signs-up-in-or-chooses-since-and-hattis-emails-and-messages-to-them-use-it-sign-in-alerts-links-and-codes-invitations-they-send-emailed-exports-and-staffs-alerts)); returns the user |
| `GET /auth/sessions`, `DELETE /auth/sessions/:id` | Signed-in devices, each with the `device` it signed in from ("Chrome on Android"); sign one out remotely |
| `POST /auth/two-step/totp/setup`, `…/confirm` | Turn on an authenticator app; returns 10 recovery codes once |
| `POST /auth/reauthenticate/options`, `POST /auth/reauthenticate/code`, `POST /auth/reauthenticate` | How the user confirms who they are before a sensitive action, a code sent to their number for it, and confirming it: a passkey or an authenticator code, else the password, Google's sign-in or a code sent to the number of an account with neither (ADR-201) |
| `GET /auth/passkeys`, `POST /auth/passkeys/options`, `POST /auth/passkeys`, `DELETE /auth/passkeys/:id` | The user's passkeys: list, add one (with recovery codes, the first second factor), remove one |
| `POST /auth/invitations/preview`, `POST /auth/invitations/accept` | What an invitation to a shop says, before signing in; accept it, signed in |
| `GET /auth/support/shops` | For Hatti's support agents, signed in with a second factor: the shops whose owners let support look now (ADR-156) |

Rules the module enforces:

* **Passwords** are hashed with argon2id (19 MiB, 2 passes), must have at least 10 characters,
  must not contain the email's name, and are checked against Pwned Passwords by k-anonymity. That
  check fails open, so an outage never blocks sign-ups.
* **Tokens** are random, prefixed (`hsa_` access, `hsr_` refresh, `hmc_` sign-in challenge,
  `hsu_` sign-up with a number proved, `hev_` proving an email, `hpr_` resetting a password) and
  stored only as SHA-256 digests. Access tokens last 15 minutes. Refresh tokens rotate on every use;
  presenting a used one ends the whole session, except within 10 seconds (a client race). Sessions
  end after 30 days, or 7 days unused.
* **Two-step verification:** each TOTP code works once; authenticator secrets are encrypted with
  `SecretBox` (AES-256-GCM, keys in `ENCRYPTION_KEYS`) and bound to their user. Replacing an
  authenticator needs a session that passed the current one. **Owners, managers and accountants**
  cannot use a shop until their session has passed a second factor (`MFA_REQUIRED`).
* **Passkeys** ([ADR-100](../architecture/13-decision-log.md#adr-100--staff-sign-in-with-a-passkey-alone-which-passes-the-second-factor-or-answer-the-second-step-after-their-password-with-one-once-an-account-has-a-second-factor-only-a-session-that-passed-one-adds-another)),
  through `@simplewebauthn/server`: discoverable, their user verified, no attestation asked for;
  the relying party and origins are `PASSKEY_RP_ID` and `PASSKEY_ORIGINS`, `PUBLIC_URL`'s host
  and origin unless set. Each challenge is kept in `identity.passkey_challenges`, or on the
  sign-in's own challenge after a password, and spent as it is answered, within 5 minutes; a
  passkey's counter must move on where its authenticator keeps one. A passkey alone passes the
  second factor. Adding a passkey or an authenticator app, and removing a passkey, takes a
  session that passed a second factor once the account has one, and whose user proved who they
  are in the last 15 minutes. Tests make and use passkeys with
  `SoftAuthenticator` (`@hatti/identity/testing`), ES256 with "none" attestation, synced or not.
* **Re-authentication** ([ADR-103](../architecture/13-decision-log.md#adr-103--sensitive-actions-need-staff-to-have-proved-who-they-are-in-the-last-15-minutes-by-signing-in-or-confirming-with-the-strongest-factor-their-account-has-apps-are-not-asked)):
  each session keeps when its user last proved who they are (`authenticatedAt`), at sign-in or
  re-authenticating since; refreshing leaves it, and `/auth/me` and token responses show it.
  `POST /auth/reauthenticate` takes the strongest factor the account has: its passkey (answering
  `…/options`, whose `methods` say which), a code from its authenticator app, or, where it has
  neither, any way it signs in ([ADR-201](../architecture/13-decision-log.md#adr-201--an-account-with-no-second-factor-confirms-who-is-at-it-with-any-way-it-signs-in-its-password-a-sign-in-with-the-google-account-connected-to-it-carrying-a-nonce-the-options-gave-or-a-code-sent-to-its-proved-number-neither-of-the-last-two-passes-a-second-factor)):
  its password, `googleIdToken` from the Google account connected, carrying the options'
  `googleOptions.nonce`, or `phoneCode`, sent by `POST /auth/reauthenticate/code` to the number
  the options mask in `phone`. Recovery codes don't, and a second factor marks the session as
  having passed one; Google and a code never do. Wrong answers are `INVALID_PASSKEY`,
  `INVALID_CODE`, `CODE_EXPIRED`, `INVALID_GOOGLE_SIGN_IN` or `INVALID_PASSWORD` (422), never
  401, as the session holds; a
  method the account doesn't take, `INVALID_METHOD`. Each attempt is on the account's activity.
* **Signing in by phone** ([ADR-159](../architecture/13-decision-log.md#adr-159--merchants-open-an-account-and-sign-in-with-their-mobile-number-and-a-code-sent-to-it-on-whatsapp-or-by-sms-from-hattis-own-number-at-hattis-cost-six-digits-for-ten-minutes-and-five-tries-a-number-sent-five-an-hour-and-ten-a-day-a-number-proved-is-one-accounts-alone-one-only-typed-never-signs-in-and-an-accounts-second-factor-is-still-asked)):
  `PhoneCodeSender` is the identity module's port for sending codes; the core's
  `ProviderPhoneCodes` sends them at once through the message providers the worker uses, as the
  platform's own `sign_in_code`, never queued with a shop's messages or charged to its credit.
  `tellReplaced` sends `number_replaced` the same way to a number another took the place of
  ([ADR-173](../architecture/13-decision-log.md#adr-173--a-number-an-account-had-proved-is-told-on-whatsapp-from-hattis-own-number-or-else-by-sms-when-another-takes-its-place-which-number-signs-in-now-masked-and-to-contact-support-if-its-owner-did-not-change-it-a-number-only-typed-is-told-nothing)); a sender that cannot leaves it to say nothing.
  Without a provider, `PHONE_SIGN_IN_UNAVAILABLE` (503). Codes (`identity.phone_codes`) are six
  digits kept as SHA-256 of `{id}:{code}`, for ten minutes and five tries (`INVALID_CODE`, then
  `TOO_MANY_ATTEMPTS`; `CODE_EXPIRED`), the last sent to a number alone working. A number waits
  30 seconds between codes (`TOO_SOON`, 429 with `Retry-After`) and is sent five an hour and ten
  a day (`TOO_MANY_CODES`); a client's address asks for 30 an hour. Sends for one number take an
  advisory lock (`phone_codes:{phone}`) for the check and the insert, never for the send itself;
  a code not sent is deleted, counting against nothing (`CODE_NOT_SENT`, 503). Codes are kept 30
  days. Only `users.phone_verified_at` makes a number sign in, and a unique index keeps a proved
  number to one account (`PHONE_TAKEN`); an account has an email, a proved number or both.
  Signing in by phone is the first factor alone: `afterFirstFactor` asks the second as after a
  password, and records `sign_in_with_phone`. A signed-in account proves a number with
  `POST /auth/phone` ([ADR-166](../architecture/13-decision-log.md#adr-166--an-account-opened-with-an-email-or-with-google-proves-a-mobile-number-with-the-same-codes-from-a-session-proved-lately-and-past-its-second-factor-where-it-has-one-the-number-signs-it-in-from-then-on-in-place-of-any-it-typed-or-proved-before-and-a-number-another-account-proved-stays-that-accounts)):
  the same check of the code (`checkPhoneCode`), from a session that proved who is at it lately
  and passed the second factor where the account has one; it replaces any number before it,
  records `phone_verified`, and another account's proved number is `PHONE_TAKEN`.
  `DELETE /auth/phone` ([ADR-202](../architecture/13-decision-log.md#adr-202--an-accounts-owner-takes-its-number-off-it-from-a-session-proved-lately-and-past-its-second-factor-where-it-has-one-while-a-password-a-passkey-or-google-still-signs-it-in-the-number-signs-in-to-nothing-from-then-on-may-be-proved-for-another-account-and-is-told-on-whatsapp-else-by-sms))
  takes it off from such a session, a proved one only while a password, a passkey or Google
  remains (`ONLY_SIGN_IN_METHOD`), records `phone_removed`, and `tellRemoved` sends a proved one
  `number_removed`; a template with no variables goes to WhatsApp with no body component.
* **Signing in with Google** ([ADR-164](../architecture/13-decision-log.md#adr-164--merchants-sign-up-and-in-with-google-through-googles-own-sign-in-its-id-token-checked-against-the-keys-google-publishes-for-one-of-hattis-client-ids-and-carrying-a-nonce-hatti-gave-out-once-names-the-account-by-googles-id-a-google-account-new-to-hatti-opens-an-account-with-the-email-google-confirmed-an-email-alike-never-connects-one-and-an-accounts-owner-connects-or-disconnects-google-from-a-session-that-proved-who-is-at-it)):
  the client starts Google's own sign-in with `/auth/google/options`' client ID and nonce
  (`identity.google_nonces`, ten minutes, spent once) and sends the ID token it gets. `GoogleIdTokens`
  checks it with `jose` against the keys Google publishes (`createRemoteJWKSet`, kept ten minutes):
  RS256 alone, Google's issuer, an audience among `GOOGLE_CLIENT_IDS`, unexpired with 60 seconds'
  leeway, `sub` and `nonce` present; a failure is `INVALID_GOOGLE_SIGN_IN` (401) and
  `google_sign_in_failed`, Google's keys out of reach `GOOGLE_UNREACHABLE` (503), and without client
  IDs `GOOGLE_SIGN_IN_UNAVAILABLE` (503). `identity.google_accounts` keeps each `sub` against one
  account, one to an account, under an advisory lock (`google:{sub}`). A connected `sub` signs in
  through `afterFirstFactor` (`sign_in_with_google`); a new one opens an account with Google's name
  and its confirmed email, `email_verified_at` set (`sign_up_with_google`), unless that email has
  an account (`GOOGLE_NOT_CONNECTED`, 409) or Google has not confirmed it
  (`GOOGLE_EMAIL_UNCONFIRMED`, 422). Connecting and disconnecting take a session proved in the
  last 15 minutes that passed the second factor where the account has one (`google_connected`,
  `google_disconnected`); a Google account elsewhere is `GOOGLE_TAKEN`, a second one
  `GOOGLE_CONNECTED`, and the last way in `ONLY_SIGN_IN_METHOD`. Tests sign tokens with
  `GoogleTestIssuer` (`@hatti/identity/testing`) and pass its `keys` in Google's place.
* **Email for accounts** ([ADR-165](../architecture/13-decision-log.md#adr-165--hatti-sends-its-own-email-about-accounts-through-amazon-ses-a-link-proving-an-accounts-email-good-once-for-a-day-and-one-resetting-a-forgotten-password-good-once-for-an-hour-each-carrying-a-token-of-its-own-in-the-links-fragment-kept-as-a-digest-the-last-of-its-kind-alone-working-a-reset-ends-every-session-and-proves-the-email-and-the-accounts-second-factor-is-still-asked)):
  `AccountEmailSender` is the identity module's port for Hatti's own emails, which it writes itself
  (`accountEmail`, English or Urdu, text and HTML, names and links escaped); the core's `SesEmails`
  sends them through SES's v2 API, signed with `@hatti/storage`'s `signRequest` for `ses`, and
  `LogEmails` writes them to the log in development. Without SES in production, the email
  endpoints are `EMAIL_UNAVAILABLE` (503). Links open `{ADMIN_URL}/verify-email` or
  `/reset-password` with the token in the fragment (`#token=`). `identity.email_tokens` keeps each
  token's digest, its address and purpose: 24 hours to prove an email, an hour to reset a password,
  once, the last of its kind alone, and only while the address is still the account's
  (`INVALID_EMAIL_LINK`). Sends for an account and a purpose take an advisory lock
  (`email_tokens:{user}:{purpose}`): a minute apart (`TOO_SOON`) and five an hour
  (`TOO_MANY_EMAILS`) to an account, 20 an hour from an address; one not sent is deleted
  (`EMAIL_NOT_SENT`). Sign-ups with an email are sent a link at once, its failure ignored. A forgotten
  password is answered 202 whatever the email; a reset checks the password as sign-up does, upserts
  it, sets `email_verified_at`, ends every session (`password_reset`) and signs no one in. A
  change of email ([ADR-172](../architecture/13-decision-log.md#adr-172--an-accounts-owner-changes-its-email-or-gives-one-to-an-account-opened-with-a-phone-from-a-session-proved-lately-and-past-its-second-factor-a-link-to-the-new-address-good-once-for-a-day-proves-it-before-it-counts-an-address-another-account-has-is-refused-and-the-address-before-is-told)) is a token of its own (`change_email`, `hce_`) to the new
  address, asked from a session past `mustHavePassedSecondFactor`; it changes `users.email` only
  when opened, as proved, and tells the address before in the language each token now keeps.
* **No email of Hatti's goes to an address suppressed** ([ADR-170](../architecture/13-decision-log.md#adr-170--hatti-hears-amazon-sess-bounces-and-complaints-through-an-sns-topic-of-its-own-posted-to-its-webhook-and-checked-against-the-certificate-sns-signs-with-served-from-snss-own-host-an-address-that-bounced-for-good-or-whose-recipient-marked-an-email-as-spam-is-sent-none-of-hattis-emails-again-and-the-webhook-confirms-its-topics-subscription-itself)): whatever
  sends one checks `suppressed` first, as `sendAccountEmail` and invitations do. SES's bounces and
  complaints come to `/webhooks/ses` from the SNS topic `SES_FEEDBACK_TOPIC_ARN` names:
  `SnsMessages` takes a message of that topic alone, signed over the fields SNS signs (not the
  body) with the certificate its `SigningCertURL` names on `sns.<region>.amazonaws.com`, before any
  is fetched for one elsewhere; the webhook confirms the topic's subscription itself, and a bounce
  for good or a complaint upserts `identity.email_suppressions`, and every notification is
  passed to the settings' `onNotification` first, a failure of it answered 503 so that SNS sends
  it again (ADR-197). Tests sign with `SnsTestTopic`
  (`@hatti/identity/testing`) in place of SNS.
* **An address is lifted through `liftSuppression`** ([ADR-200](../architecture/13-decision-log.md#adr-200--an-address-hatti-stopped-emailing-for-a-bounce-is-emailed-again-once-google-where-it-answers-for-the-address-confirms-it-in-a-sign-in-sess-own-list-is-asked-first-and-both-are-lifted-a-complaint-stays-on-either-list-and-hattis-operators-lift-either-from-the-command-line)),
  never by deleting its row alone: it asks SES's own list (`SesSuppressionList`, given as
  `AccountEmails.suppressions`) first and leaves a complaint unless told `complaints`, as the
  `email-suppression` command does. A sign-in with Google lifts a bounce where
  `GoogleAccount.authoritative` (Gmail, or a Workspace organisation's `hd`); `suppressIn` never
  turns a complaint into a bounce. Requests to AWS services but S3 sign their path encoded once
  more (`canonicalPath`).
* **Sign-in alerts** ([ADR-179](../architecture/13-decision-log.md#adr-179--a-sign-in-from-a-device-none-of-an-accounts-sessions-was-used-from-in-90-days-tells-its-owner-what-signed-in-when-and-from-where-a-device-is-the-random-id-its-client-keeps-or-for-a-client-that-keeps-none-its-user-agent-version-numbers-aside-by-email-where-the-accounts-email-is-proved-else-on-whatsapp-or-by-sms-to-its-proved-number-five-a-day-at-most-never-failing-the-sign-in)): clients make a random ID for the
  device they run on, 16 to 128 URL-safe characters, keep it with their data and send it with
  every `/auth` request in `X-Hatti-Device` (`DEVICE_HEADER`); a session keeps SHA-256 of the
  account's ID with it (`sessions.device_hash`). After each sign-in's session is made, out of its
  transaction (`afterFirstFactor` without a second factor, the second step, a passkey alone;
  never opening an account or refreshing), `alertSignIn` looks for another session of the
  account used in the last 90 days from the same device: the same digest, or, for a client that
  sent no ID, the same user agent with its digits taken out among sessions without one; a session
  ended as `refresh_token_reuse` counts for nothing. None found, it emails
  `signInAlertEmail` to a proved, unsuppressed email, else asks `PhoneCodeSender.tellSignedIn`,
  whose core sender sends the platform's `sign_in_alert` on WhatsApp, else by SMS, to a proved
  number; each sent is `sign_in_alerted`, five a day an account at most (`SIGN_IN_ALERT`), in
  the account's language. `describeDevice` names the browser and system in Hatti's own words, never the user
  agent's, and the device list uses it too. Nothing in it fails the sign-in.
* **An account keeps its language** ([ADR-194](../architecture/13-decision-log.md#adr-194--an-account-keeps-its-own-language-english-or-urdu-as-its-owner-signs-up-in-or-chooses-since-and-hattis-emails-and-messages-to-them-use-it-sign-in-alerts-links-and-codes-invitations-they-send-emailed-exports-and-staffs-alerts)):
  `users.language`, `en` or `ur`, is set at sign-up from the request's `language` (English
  unless it names one), changed by `POST /auth/language` and returned on the user. Whatever Hatti
  sends the account unasked is in it, and a request that names no language uses it:
  `input.language ?? user.language`, never English by default where the account is known. An
  invitation names its inviter's. The worker learns it with a member's email or number, from
  `identity.staff_email` and `identity.staff_phones`.
* **Staff are managed by staff** ([ADR-101](../architecture/13-decision-log.md#adr-101--owners-and-managers-invite-staff-by-a-link-they-send-themselves-accepted-once-by-a-signed-in-account-the-owner-manages-every-role-but-its-own-managers-those-below-them-apps-none)):
  `StaffService` keeps memberships and invitations, and the core's `StaffResolver` serves
  `staffMembers`, `staffInvitations` and the five changes to the owner and managers alone, never
  apps, writing each to the audit log once it stands. `managedRoles` says whom each role manages:
  the owner every role but its own, managers those below them. Each change reads the acting
  member's role again under a lock. Invitation secrets (`hsi_`) are returned once and kept as
  SHA-256 digests; they travel in request bodies, never in paths. With `email`
  ([ADR-167](../architecture/13-decision-log.md#adr-167--hatti-emails-an-invitation-to-work-in-a-shop-to-the-address-its-inviter-gives-beside-the-link-the-inviter-shares-themselves-in-english-or-urdu-20-a-day-for-a-shop-at-most-the-invitation-keeps-the-address-and-its-link-is-still-whoever-holds-its-to-accept)),
  `StaffService` also emails the link (`{ADMIN_URL}/invitation#token=`) through the identity
  module's `AccountEmails` after the invitation commits, `invitationEmail` writing it; the address
  is kept lowercased on the invitation, `emailed` says whether it went, and a shop's invitations
  with an address in the last 24 hours stop at 20 (`TOO_MANY` on `email`).
  `resendInvitation` (`staffInvitationResend`) emails one still waiting again
  ([ADR-196](../architecture/13-decision-log.md#adr-196--an-invitation-still-waiting-is-emailed-again-as-a-new-one-in-its-place-of-the-same-role-note-and-address-by-a-new-link-good-for-7-days-the-one-before-is-taken-back-its-link-opening-nothing-and-the-new-one-is-held-to-the-limits-any-invitation-is-20-emailed-a-day-for-a-shop-among-them)): it takes the invitation
  back and makes another of its role, note and address with `createInvitationIn`, in one
  transaction, which a limit's refusal rolls back (`UserErrorsRollback`), and emails the new
  link as `invite` does.
* **The owner hands the shop over** ([ADR-104](../architecture/13-decision-log.md#adr-104--the-owner-hands-the-shop-to-one-of-its-managers-who-has-a-second-factor-and-stays-on-as-a-manager-the-shop-has-one-owner-throughout)):
  `shopOwnershipTransfer(staffMemberId)` makes one of its managers, with a passkey or an
  authenticator app, the owner, and the owner a manager, from their next requests. Only the
  owner, recently authenticated, does it; never apps. The old owner steps down before the new
  one steps up, in one transaction, so the shop has one owner throughout; it is
  `shop.ownership_transferred` on the audit log.
* **Opening a shop** ([ADR-145](../architecture/13-decision-log.md#adr-145--a-signed-up-user-opens-a-shop-of-their-own-through-the-identity-login-its-name-a-handle-made-from-it-or-chosen-and-never-the-platforms-the-user-its-owner-and-shopopened-for-its-storefront-in-one-transaction)):
  `IdentityService.openShop` inserts the shop's ID, name and handle into `control.shops`, makes
  the user its owner and records `shop.opened` in the outbox, in one transaction of the identity
  login; the publisher builds the shop whole on that event. A handle is made from the name when
  none is given (`handleFrom`) and numbered while another shop has it; one asked for and taken
  is `HANDLE_TAKEN` (409). `handleProblem` refuses what the storefront cannot serve and the
  platform's own subdomains (`RESERVED_HANDLES`): add a subdomain the platform starts using
  there. An account owns `SHOP_LIMITS.ownedShops` (5) shops at most (`TOO_MANY_SHOPS`).
* **Hatti's support looks only with the owner's consent** ([ADR-156](../architecture/13-decision-log.md#adr-156--hattis-support-looks-at-a-shop-only-while-its-owner-allows-it-15-minutes-to-a-day-its-agents-hattis-own-people-signed-in-with-a-second-factor-come-as-a-caller-of-their-own-with-every-read-scope-numbers-masked-change-nothing-and-each-of-their-requests-goes-on-the-shops-audit-log-before-it-runs)):
  `SupportAccessService` keeps Hatti's agents (`identity.support_agents`, set with the core's
  `support-agent` command, never an API) and the owners' grants (`identity.support_grants`, one
  open a shop, 15 minutes to a day). The access check makes an agent without a membership, under
  a grant open now and with a second factor, a caller of its own kind: `actor.kind ===
  'support'`, with `SUPPORT_SCOPES` (every read). A check that lets in what is not staff, as
  "staff must be the owner or a manager; apps with the scope", lets support read it too: refuse
  support where only the shop's own people may look. Never record what support does with
  `actorColumnsOf`, which throws for it: support changes nothing (the core's hook refuses
  anything but one query, and `ScopesGuard` its mutations), and the hook writes each of its
  queries to the audit log with `supportColumnsOf` before it runs.
* **Abuse limits** (Redis): sign-in by email (10 per 15 minutes) and by IP (100), sign-up by IP (10
  per hour), second-factor attempts by user (10), re-authentication by user (10), opening shops by
  user (10 a day), plus 5 attempts per challenge. Limits fail open if Redis is down.
* Wrong email and wrong password get the same answer after the same work, so responses do not
  reveal who has an account.
* **Database logins:** identity tables are reachable only by `hatti_identity`. Request-serving code
  resolves staff tokens through `identity.resolve_staff_access()`, a `SECURITY DEFINER` function
  that returns the role and when the session's user last proved who they are, and never sees
  password hashes. The identity login inserts a shop's `id`, `name` and `handle` alone, and
  `shop.opened` alone of the outbox's events; it changes no shop.

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
* **A test of how a migration treats old data** makes its database `before` it and applies it
  alone with `migrateThrough`; its `describe` takes `{ timeout: MIGRATION_TEST_TIMEOUT }`, as
  every migration before it runs from nothing, which a busy CI runner takes more than 30 seconds
  over.
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
