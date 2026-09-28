# Engineering progress log

> Newest first. Every change that lands on the branch gets an entry, and so does the work in
> progress. The current state of each roadmap deliverable is on
> [Phase 0 status](./phase-0-status.md); this log records how it got there and what was learned.

## In progress

### Inventory · started 2026-09-28

Locations, stock levels per variant and location, and adjustments with reasons recorded in a
ledger. Available stock is on hand minus committed, reserved and safety stock. Oversell protection
comes from conditional updates, ready for checkout.

## 2026-09-28

### Catalog depth: options, bulk variants, images and collections

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
