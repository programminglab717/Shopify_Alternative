# 13 · Architecture Decision Log

> **Status:** Living document · **Last updated:** 2026-09-29 (ADR-028 added)
> Each decision records its context, the choice, the consequences and the alternatives considered.
> Status values: **Accepted** (build on it), **Proposed** (needs a spike or business input),
> **Superseded** (kept for history). Add new decisions at the end. Never rewrite history; supersede
> instead.

| ADR | Title | Status |
|---|---|---|
| 001 | Modular monolith deployed as process pools | Accepted |
| 002 | TypeScript as the primary language; NestJS for Core | Accepted |
| 003 | PostgreSQL, shared schema with `shop_id` + RLS; cells for scale-out | Accepted |
| 004 | UUIDv7 keys with type-prefixed public IDs | Accepted |
| 005 | Transactional outbox + BullMQ first; Kafka-compatible log later | Accepted |
| 006 | Liquid-compatible theme engine with JSON templates | Accepted |
| 007 | Cloudflare as the edge (CDN, custom hostnames, Workers, R2) | Accepted |
| 008 | GraphQL for public Admin and Storefront APIs | Accepted |
| 009 | Merchant-owned payment accounts first; partner-powered payments later | Accepted |
| 010 | Courier adapters with data-driven mappings; merchant-owned courier accounts first | Accepted |
| 011 | Phone-first shopper identity | Accepted |
| 012 | WhatsApp primary, SMS fallback; Hatti as a Meta Tech Provider | Accepted |
| 013 | Typesense for search with app-level Urdu/Roman Urdu normalisation | Accepted |
| 014 | ClickHouse for analytics | Accepted |
| 015 | Primary hosting in Singapore; Pakistan data-centre cell later; no Gulf primary | Proposed (pending latency bake-off) |
| 016 | AI through an internal gateway; Claude as the default provider | Accepted |
| 017 | Built-in essentials over app-marketplace dependency | Accepted |
| 018 | React Native (Expo) for merchant and POS apps | Accepted |
| 019 | Drop Mode inventory tokens in Valkey for flash sales | Proposed (spike) |
| 020 | Staff identity built in-house on audited primitives | Accepted |
| 021 | PgBouncer transaction pooling with no session state | Accepted |
| 022 | Stock changes lock levels in one order, check, then write | Accepted |
| 023 | Customer order stats are worked out from orders when read | Accepted |
| 024 | Segments are queries evaluated on demand, over fields modules contribute | Accepted |
| 025 | Order risk is a snapshot taken when an order is placed or re-addressed | Accepted |
| 026 | A customer can have several numbers; modules with customer data join merges and erasure | Accepted |
| 027 | Customers' numbers are masked by role, and reveals go to an append-only audit log | Accepted |
| 028 | Printable documents are HTML pages with print styles; PDFs will render the same pages | Accepted |

---

## ADR-001 · Modular monolith deployed as process pools

* **Context:** a small team must deliver a very broad product (Shopify-scale scope) quickly while
  keeping transactional integrity across catalogue, inventory, orders and payments.
* **Decision:** one Core codebase with strictly enforced module boundaries (public facades,
  owned tables, domain events). It is deployed as separate pools (admin API, storefront API,
  checkout, workers) from the same image. Only components with a distinct runtime profile are
  separate services: storefront renderer, edge workers, webhook ingress, ML service.
* **Consequences:** in-process calls and local transactions; one deploy pipeline; boundaries must
  be policed by tooling (lint rules, schema ownership checks). A module can be extracted later
  if scale or team structure demands it.
* **Alternatives:** microservices from day one (distributed-transaction and ops cost too high for
  the team size); an unstructured monolith (fast now, unmaintainable later).

## ADR-002 · TypeScript as the primary language; NestJS for Core

* **Context:** hiring market, shared code across web, mobile and edge, and speed of delivery.
* **Decision:** TypeScript everywhere. NestJS (Fastify adapter) structures Core. Python only for
  ML. Rust only for the future Wasm Functions runner.
* **Consequences:** the largest local talent pool; shared Zod schemas and types; Node needs care for
  CPU-heavy work (templating limits, worker threads, caching).
* **Alternatives:** Go (efficient, but a second language and a smaller local pool); PHP/Laravel
  (big local pool, but splits the stack); Ruby on Rails (Shopify's choice, with a small local pool).

## ADR-003 · PostgreSQL shared schema with `shop_id` + RLS; cells for scale-out

* **Context:** 100k+ small tenants and a few large ones; cost per store must stay low.
* **Decision:** shared tables with `shop_id` on every row. Postgres Row-Level Security is a
  backstop behind application scoping. Scale out by adding **cells** (Postgres + Valkey + workers)
  and moving shops between them.
* **Consequences:** very low cost per tenant; the blast radius is limited to a cell; no cross-cell
  joins; a Shop Mover tool must be built (Growth phase) before cell 2 is needed.
* **Alternatives:** database per tenant (too costly and operationally heavy at 100k shops);
  Citus (elegant but operationally complex outside its managed offering); Vitess/MySQL (more ops).

## ADR-004 · UUIDv7 keys with type-prefixed public IDs

* **Decision:** internal UUIDv7 primary keys; public IDs are type prefix + base32 (`ord_…`);
  per-shop human numbers for orders and gapless series for tax invoices.
* **Consequences:** globally unique IDs make shop moves between cells trivial; index locality from
  time ordering; 16-byte keys (acceptable).
* **Alternatives:** bigint sequences (collisions across cells); Snowflake IDs (needs an ID
  service).

## ADR-005 · Transactional outbox + BullMQ first; Kafka-compatible log later

* **Decision:** domain events are written to an outbox table in the same transaction; a relay
  publishes them to BullMQ queues on Valkey. Introduce Redpanda (Kafka API) when analytics
  volume or independent consumers require a replayable log.
* **Consequences:** correctness (no lost or phantom events) with minimal infrastructure;
  consumers must be idempotent. The later migration changes transport only, not the event
  contract.
* **Alternatives:** Kafka from day one (ops cost); pg-boss (adds load to the primary DB); Temporal
  (powerful, heavy; revisit for complex long-running workflows).

## ADR-006 · Liquid-compatible theme engine with JSON templates

* **Context:** Pakistan has a very large pool of Shopify/Liquid developers and agencies. Merchants
  want no-code editing. Storefronts must be very light.
* **Decision:** LiquidJS-based engine implementing Shopify-compatible Liquid objects, filters and
  tags, plus OS 2.0-style JSON templates, sections and blocks, and Hatti extensions (RTL, COD,
  WhatsApp, delivery estimates). Server-rendered HTML with a tiny JS runtime.
* **Consequences:** developers are productive immediately; merchant-owned themes are portable; we
  must keep up with Liquid semantics and build strong sandboxing and limits.
* **Alternatives:** a React/RSC theme system (heavier pages, harder no-code editing); a proprietary
  template language (no ecosystem).

## ADR-007 · Cloudflare as the edge

* **Decision:** Cloudflare for DNS, CDN, WAF, bot management/Turnstile, Workers (routing, waiting
  room, event collection), KV, Durable Objects, R2 and Cloudflare for SaaS custom hostnames.
* **Consequences:** in-country PoPs; automatic TLS for thousands of merchant domains; zero-egress
  media storage; some vendor concentration, mitigated by keeping origin logic portable.
* **Alternatives:** Fastly (cost, local presence), CloudFront + ACM (per-certificate limits,
  egress cost).

## ADR-008 · GraphQL for public Admin and Storefront APIs

* **Decision:** date-versioned GraphQL APIs with cost-based rate limiting; REST only for OAuth,
  webhooks and file uploads.
* **Consequences:** efficient rich clients (admin, mobile, apps) and a familiar model for Shopify
  developers. Needs a query-cost engine, persisted queries and resolver-level authorisation.
* **Alternatives:** REST-first (simpler, chattier); both from the start (doubles the surface).

## ADR-009 · Merchant-owned payment accounts first; partner-powered payments later

* **Context:** licensed payment providers must not hold customer funds without the right licence.
  EMI/PSP licences need large paid-up capital and heavy compliance. Small merchants struggle to
  get gateway accounts.
* **Decision:** MVP integrates gateways with **merchant-owned credentials**, so funds never touch
  Hatti. The Growth phase launches partner-powered payments with a licensed PSP that onboards sub-merchants
  and settles directly to each merchant's IBAN. Our own licence is considered only at scale.
* **Consequences:** zero regulatory dependency at launch; slower onboarding for merchants without
  gateways until the Growth phase; a payments revenue line arrives in the Growth phase.
* **Alternatives:** obtain a licence first (years and capital); collect funds informally (illegal
  and unacceptable).

## ADR-010 · Courier adapters with data-driven mappings; merchant-owned courier accounts first

* **Decision:** one adapter per courier behind a common interface. Status and city mappings are
  data (editable without deploys). Merchants connect their own courier accounts at first, and
  couriers remit COD directly to them. A negotiated-rate programme follows, still without Hatti
  holding COD cash.
* **Consequences:** fast launch, no cash handling; mapping data needs ongoing curation; adapters
  need contract tests because courier APIs change without notice.

## ADR-011 · Phone-first shopper identity

* **Decision:** shopper identity is the verified mobile number (E.164); email is optional. OTP
  goes via WhatsApp first, then SMS.
* **Consequences:** matches local behaviour and COD operations; OTP costs and SIM-swap risks must
  be managed; email-dependent features (receipts, marketing) become channel-agnostic.

## ADR-012 · WhatsApp primary, SMS fallback; Hatti as a Meta Tech Provider

* **Decision:** WhatsApp Cloud API through Embedded Signup (merchant-owned WABAs), a shared
  platform number for small shops' utility messages, SMS failover through two aggregators, and IVR
  for high-value confirmations. Message credits are sold in PKR.
* **Consequences:** best reach and engagement; dependency on Meta policy and pricing; regional
  WhatsApp restrictions are handled by automatic fallback.

## ADR-013 · Typesense for search with app-level Urdu/Roman Urdu normalisation

* **Decision:** Typesense (HA) with per-cell collections and per-shop scoped keys; our own
  normalisation layer for Roman Urdu phonetics and Urdu script, applied at index and query time.
* **Alternatives:** OpenSearch (heavy), Meilisearch (similar; either is acceptable), Postgres FTS
  (admin only).

## ADR-014 · ClickHouse for analytics

* **Decision:** storefront events and order/shipment facts go to ClickHouse; merchants query it
  only through the Analytics module's parameterised, shop-scoped queries.
* **Alternatives:** BigQuery/Snowflake (query-based cost and USD exposure), Postgres (too slow at
  event scale).

## ADR-015 · Primary hosting in Singapore; Pakistan data-centre cell later; no Gulf primary *(Proposed)*

* **Context:** Pakistani users need low latency, and no hyperscaler has a region inside Pakistan.
  The closest regions (Gulf, 20–50 ms) carry demonstrated war risk: in March 2026 drone strikes
  reportedly impaired AWS's UAE and Bahrain regions for months, with reported permanent data loss.
  Revenue is in PKR and costs in USD. Startup credits matter. Measured 2026 latency: in-country
  hosting 2–40 ms, Singapore about 90–130 ms, Europe 130–200 ms. Submarine-cable faults
  (8 since 2024) multiply international latency 2–6× but do not affect in-country traffic.
* **Proposal:** launch cells in a **Singapore** hyperscaler region (managed Postgres, Valkey and
  Kubernetes; Multi-AZ), with backups and DR in a second non-Gulf region (e.g. Europe), behind
  Cloudflare. In the Growth phase, add a **Pakistan data-centre cell** (multi-homed Tier-III facility):
  first storefront renderers and read replicas, then full cells for Pakistani merchants. This cuts
  latency, removes cable-fault exposure, prepares us for data-residency rules and hedges FX with
  PKR-billed capacity. Do not run a Gulf region as primary. Keep everything portable (Kubernetes,
  Postgres, S3 API, OpenTelemetry, portable egress IPs for FBR/courier allow-lists).
* **To decide:** a latency bake-off from 5+ Pakistani networks, including which Cloudflare edge
  serves our custom hostnames; credits and pricing (AWS vs GCP vs others in Singapore); a shortlist
  of local DCs for the PK cell; a legal review of data-localisation direction. See
  [10 · Infrastructure & DevOps](./10-infrastructure-and-devops.md) and
  [Research · Local Ecosystem](../research/03-local-ecosystem.md).

## ADR-016 · AI through an internal gateway; Claude as the default provider

* **Decision:** every LLM call goes through the AI Gateway (routes, quotas, caching, batching,
  evals). The default is the flagship Claude model (Opus tier), with effort tuned per route. Cheaper tiers are
  adopted per route only with eval evidence and a product decision.
* **Consequences:** consistent cost control and safety; provider and model changes are
  configuration changes.

## ADR-017 · Built-in essentials over app-marketplace dependency

* **Context:** Pakistani merchants on Shopify pay in USD for many apps (COD forms, courier booking,
  WhatsApp, reviews, upsells, pixels). This is a large share of their total cost and a common
  frustration.
* **Decision:** ship these essentials as first-party, plan-gated features. The app platform serves
  integrations and specialised needs.
* **Consequences:** a larger core scope and team; a strong pricing advantage and a coherent UX;
  there are fewer ecosystem revenue opportunities for third parties in core areas, so we must
  still court partners for the long tail.

## ADR-018 · React Native (Expo) for merchant and POS apps

* **Decision:** one codebase for Android (priority) and iOS; shared TS packages; native modules for
  Bluetooth thermal printers and barcode scanning; offline-first storage for POS.
* **Alternatives:** Flutter (a second language), native apps (double the effort).

## ADR-019 · Drop Mode inventory tokens in Valkey *(Proposed, spike required)*

* **Decision:** during scheduled drops, checkout claims pre-loaded per-variant tokens atomically
  in Valkey. Orders are written without hot-row inventory locks, and a reconciler folds consumption
  back into Postgres.
* **Spike exit criteria:** 2,000 checkouts/min on one SKU with zero oversell under failure
  injection (Valkey failover, worker crash), and full reconciliation within 60 s.

## ADR-020 · Staff identity built in-house on audited primitives

* **Context:** [02 · Tech stack](./02-tech-stack.md) proposed better-auth for staff sign-in, to be
  confirmed by a Foundations spike. [11 · Security](./11-security-and-compliance.md) §2.1 requires
  argon2id passwords with a breached-password check, TOTP (and later passkeys), MFA for owners and
  finance roles, **short-lived access tokens with rotating refresh tokens**, and a device list with
  remote sign-out. Our data conventions are forward-only SQL migrations, separate database logins
  per concern, UUIDv7 keys and prefixed public IDs.
* **Spike finding (better-auth 1.7.6, package inspection):** first-party sessions are sliding
  session tokens (usually cookies); its refresh tokens belong to linked OAuth accounts, so the
  rotating-refresh model would be ours to build anyway. Its schema comes from its own CLI and
  adapters (it bundles adapters for Kysely, Drizzle, Prisma and MongoDB), which conflicts with our
  hand-written migrations and role separation. Its organisation plugin models roles differently
  from our per-shop presets.
* **Decision:** an Identity module (`@hatti/identity`) built on small, audited primitives:
  argon2id via `@node-rs/argon2` (OWASP parameters), `node:crypto` for AES-256-GCM secret
  encryption and RFC 6238 TOTP (tested against the RFC vectors), Pwned Passwords k-anonymity for
  breached passwords, and opaque random tokens stored only as SHA-256 digests. Identity tables sit
  behind their own database login; request-serving code reaches them only through one
  `SECURITY DEFINER` function. Passkeys will use `@simplewebauthn/server`; OAuth for apps stays with
  `oidc-provider`.
* **Consequences:** we own security-critical code, so it stays small, fully tested (reuse
  detection, replay protection, rate limits, role boundaries) and goes into the pre-launch
  penetration test. We avoid a large dependency tree and keep one data model for staff, shops and
  roles.
* **Alternatives:** better-auth (above); Keycloak, Zitadel or Ory (extra services to operate, as
  noted in the tech stack); Lucia (now a guide rather than a maintained library).

## ADR-021 · PgBouncer transaction pooling with no session state

* **Context:** [02 · Tech stack](./02-tech-stack.md) put PgBouncer in transaction mode in front of
  Postgres, relying on transaction-local settings for row-level security (ADR-003). Spike 5
  ([results](../engineering/spikes/05-rls-and-pooling.md)) measured this on the products listing
  (1,000 shops, 460k products). It found that the application could not connect through
  PgBouncer at all: the driver sent timeouts as startup parameters, which PgBouncer refuses. It
  also found that the outbox relay's `LISTEN` would silently stop receiving notifications.
* **Decision:**
  * Request-serving processes reach Postgres through PgBouncer in transaction mode. Nothing may
    outlive a transaction: settings go through `set_config(…, true)` or `SET LOCAL`, and code
    never uses session `SET`, `LISTEN`, session advisory locks, temporary tables or named
    prepared statements.
  * Timeouts are defaults on each login (15 s per statement, 30 s idle in a transaction). Each
    tenant transaction also sets its surface's budget, in the same statement as the shop.
  * Only migrations, setup, the relay's `LISTEN` (`DATABASE_LISTEN_URL`, checked at start-up)
    and operator tools connect directly.
  * CI runs every database test through PgBouncer.
  * Queries always filter by shop explicitly, and index only leakproof conditions. Text search
    and similar filters go to Typesense or to rows with B-tree indexes.
* **Consequences:**
  * Row-level security costs about 0.1 ms per transaction and keeps every listing plan.
  * The pooler adds about 0.03 ms per round trip on one host. Hot paths therefore keep round
    trips few: a product loads in one statement.
  * PgBouncer served 1,024 clients on 20 server connections, where direct connections failed
    above 100. Overload becomes queueing, which admission control at the edge must bound.
  * PgBouncer should run beside the API pods, on its own CPU. The spike's single machine
    understated pooled throughput for lack of it.
* **Alternatives:**
  * Session pooling: keeps session state, but gives each client its own server connection, so
    nothing is multiplexed.
  * RDS Proxy: pins a session on `SET`, which defeats pooling.
  * Application pools only: pods × pool size outgrows `max_connections`.
  * Supavisor, PgCat, Odyssey: multithreaded poolers. Revisit if PgBouncer's single thread
    becomes the limit; it used half a core in the spike.

## ADR-022 · Stock changes lock levels in one order, check, then write

* **Context:** [03 · Data](./03-multi-tenancy-and-data.md#62-inventory-quantities) protects
  against overselling with one conditional `UPDATE` per order line. Real changes touch many
  levels at once: an order has several lines and must take all or none, and a stock count sets up
  to 250 levels. Conditional updates run line by line can half-apply, and two orders that list
  the same variants in a different order lock rows in a different order, so they can deadlock.
  Deactivating a location also has to be sure no sale is adding stock there at the same moment.
* **Decision:** every stock change takes one path, for merchants and orders alike
  ([conventions](../engineering/conventions.md#inventory)):
  1. Create missing items and levels, in (variant, location) order (merchant changes only).
  2. Lock the levels with `SELECT … ORDER BY variant_id, location_id FOR UPDATE`, which also
     takes a key-share lock on each location.
  3. Check the whole change against the locked quantities in application code. Report shortages
     or user errors and write nothing if any line fails.
  4. Write the levels, the adjustment and one movement per quantity changed in one statement,
     then one `inventory_level.updated` per level.
  Deactivating a location takes an exclusive lock on it, so it waits for sales in progress there,
  and new sales wait for it. A variant whose stock was never recorded has no item: it is not
  tracked and sells freely, and its first stock starts tracking.
* **Consequences:**
  * Nothing sells a unit twice, and concurrent orders queue rather than deadlock. Tests run 20
    buyers against 5 units, 30 orders listing two variants in opposite orders, and a deactivation
    racing a sale, directly and through PgBouncer.
  * An order commit costs three round trips (lock, write, events) instead of one. A best-selling
    variant's level is a hot row: every order for it waits on the one before. Flash sales still
    need Drop Mode (ADR-019).
  * The ledger records why every quantity changed, and who changed it; request code can only
    add to it.
* **Alternatives:**
  * One conditional `UPDATE` per line, inside a savepoint to undo partial orders: more round trips
    on failure, and still deadlock-prone across lines.
  * `SERIALIZABLE` isolation: correct without explicit locks, but concurrent buyers of one
    variant abort and retry, which is worst exactly when demand peaks.
  * Optimistic version checks: the same retry storms on hot variants.

## ADR-023 · Customer order stats are worked out from orders when read

* **Context:** customer profiles (CUS-01) show what a customer's orders add up to: how many,
  what they paid, and how they turned out (delivered, refused, cancelled), which the Confirmation
  Desk reads before every call. [03 · Data](./03-multi-tenancy-and-data.md) sketched
  `orders_count` and `total_spent` columns on the customer. Kept there, they would be written by
  the orders module into another module's table on every stage change, parcel and payment, and
  would drift whenever one path forgot. Each write would also lock the customer row, adding a
  hot row for repeat buyers to the order, stock and counter locks an order already takes.
* **Decision:** customers store only their profile. The orders module works the numbers out from
  a customer's orders when they are asked for, with one grouped query per page of customers
  (batched per request, on an index of orders by customer), and adds them to the `Customer`
  GraphQL type. A customer's addresses are likewise the different addresses their orders went
  to. Orders find or create their customer by mobile number in the transaction that places them
  (ADR-011).
* **Consequences:**
  * The numbers are always right, including after an order moves to another customer because
    its number was corrected, and nothing needs backfilling.
  * Customers cannot be sorted or filtered by these numbers in SQL. Segments and "top customers"
    will read a customers search index fed by order events (ADR-013), which is where filtering at
    scale belongs anyway.
  * A customer with thousands of orders costs a larger aggregate per read; an index-only summary
    or cached counts can come later if profiles show up in latency profiles.
* **Alternatives:**
  * Counters on the customer, updated by the orders module through a facade: fast to sort by,
    but a second copy of the truth, with cross-module writes and extra locks in every order
    transaction.
  * A projection updated asynchronously from order events: no locks, but profiles lag the orders
    staff just changed, and it needs a consumer before there is anything else to consume.

## ADR-024 · Segments are queries evaluated on demand, over fields modules contribute

* **Context:** segments ([07 · Messaging §5.1](./07-messaging-and-marketing.md#51-segments)) filter
  customers by facts that belong to several modules: their tags (customers), what they ordered and
  how it turned out (orders), and later consent and storefront behaviour. The customers module
  owns segments but must not read other modules' tables, and the orders module already depends on
  customers, so customers cannot call into orders. Order facts are worked out when read, not
  stored (ADR-023).
* **Decision:**
  * A segment is a name and a query in a small language modelled on Shopify's segment queries
    (`number_of_orders >= 2 AND city IN (Lahore, Karachi) AND last_order_date < -60d`). The
    customers module parses it, type-checks it against the fields, and compiles it to one SQL
    statement with every value a parameter.
  * **Fields are contributed.** The customers module has a `SegmentFieldRegistry`. A module that
    owns facts about customers registers a source at start-up: SQL giving one row per customer,
    and fields that read its columns. The orders module registers its order facts, the same query
    behind a customer's stats. The customers module joins a source only when a query uses its
    fields, without knowing its tables.
  * **Members are found when asked for**, not stored, so a segment is always current and there is
    nothing to keep in step.
* **Consequences:**
  * Adding consent, behaviour or loyalty fields later means registering a source; the language,
    API and saved segments stay as they are.
  * A query using order fields aggregates the shop's orders each time it runs. That is fine for
    shops with tens of thousands of orders, but not for the largest. The customers search index
    fed by order events (ADR-013, ADR-023) is the route to scale, behind the same language.
  * Automations that react to someone entering a segment will need membership changes, which
    on-demand evaluation does not give; they will evaluate incrementally, per event.
* **Alternatives:**
  * Stored membership, refreshed by a job: fast to read, stale between runs, and every field
    change means a rebuild.
  * A generic JSON filter tree instead of a text language: easier to parse, harder for merchants
    and AI assistants to read and write, and unlike what merchants migrating from Shopify know.
  * The customers module querying orders' tables directly: simplest, but breaks the module
    boundary that lets modules move into services later.

## ADR-025 · Order risk is a snapshot taken when an order is placed or re-addressed

* **Context:** cash-on-delivery orders that come back unpaid cost the merchant shipping both ways
  and tie up stock. The MVP scores them with transparent rules (COD-06), and V1 with a model
  trained on delivery outcomes ([09 · AI §4.1](./09-ai-and-intelligence.md#41-rto--cod-risk-model-v1)).
  A risky order should wait for review before anyone confirms or ships it, and staff should see
  why. Customer stats, which the rules read, are worked out when read (ADR-023); the question was
  whether risk should be too.
* **Decision:**
  * The orders module scores cash-on-delivery orders with weighted rules: the customer's history
    in this shop (from the same query as their stats), another unshipped order from the number in
    the last 6 hours, the order's value and size, and how complete the address is. Points out of
    100 inside, 0 to 1 in the API, with the reasons strongest first.
  * **The score is taken when the order is placed and when its address changes, and stored on the
    order with its reasons.** The hold decision is made at those moments, and the order keeps what
    it was based on.
  * A shop's policy is a hold threshold and a high-value amount, with defaults in code. Orders at
    or above the threshold wait for review (`needs_review`), with the reasons on the timeline. An
    address change holds an order only if the change is what makes it risky, so staff who
    reviewed a risky order can still correct it.
  * Guardrails: no rule looks at which city an order is for, no address rule alone reaches the
    medium level, prepaid orders are not scored, and merchants see every reason.
* **Consequences:**
  * The order list filters by risk level with an index, and the Confirmation Desk can sort by
    score.
  * A score can go stale: an open order does not pick up a refusal of another order that happens
    after it was placed. The customer's delivery history, which staff see beside the order, is
    always current; re-scoring on such events can come with the Confirmation Desk.
  * The V1 model plugs in behind the same shape (score, level, reasons) and storage, and the
    stored reasons are a record of what each decision was based on.
* **Alternatives:**
  * Scoring when read, like customer stats: always current, but the basis of a hold would change
    after the decision, and filtering by level would need the rules in SQL.
  * A hold flag without a score: simpler, but nothing to rank a review queue by and no path to
    model thresholds.
  * Merchant-editable rule weights: flexible, but easy to misconfigure and hard to support. The
    MVP exposes the threshold and the high-value amount; weights can follow once there is data on
    what merchants change.

## ADR-026 · A customer can have several numbers; modules with customer data join merges and erasure

* **Context:** a customer is whoever a mobile number belongs to (ADR-011), but many shoppers in
  Pakistan carry two SIMs, so one person can become two customers, each with half the delivery
  history the risk rules read (ADR-025). Merging them has to keep working afterwards: an order
  from either number must find the merged customer. A customer can also ask for their data to be
  erased, while the shop must keep its order records for its accounts
  ([03 · Data §11](./03-multi-tenancy-and-data.md#11-data-lifecycle--privacy)). Customers own
  profiles; orders own orders, and depend on customers, not the other way round.
* **Decision:**
  * **Every number of every customer is a row** in `customers.customer_phones`, keyed by shop and
    number, so a number belongs to one customer at a time. The customer row keeps the main
    number, which marketing consent is for; a deferred foreign key keeps it one of theirs.
    Orders find their customer by any of the numbers, and hold a lock on it until they commit.
  * **Modules that keep data about customers register a handler** with the customers module at
    start-up, as they register segment fields (ADR-024): what stops an erasure, how to move data
    to the customer a duplicate is merged into, and how to erase it. The customers module runs
    them inside the merge's or erasure's transaction, without knowing their tables.
  * **Merging** moves the duplicate's data, then its numbers (which waits for orders being placed
    with them), then the data again, and deletes the duplicate. The customer's own name and email
    win; the duplicate's fill gaps, an email with its consent.
  * **Erasure** is refused while any order of the customer is open. Otherwise it deletes the
    profile, numbers and consent history, and orders keep their items, amounts, statuses and
    city, without the name, number, email, street or note. Timeline messages hold no contact
    details, so they need no rewriting.
  * The consent ledger stays append-only for request code: two narrow functions, limited to the
    caller's shop, move it on a merge and delete it on an erasure.
* **Consequences:**
  * A customer's history and risk score cover all their numbers, and a later order from a merged
    number needs no second merge.
  * A new module with customer data must register a handler, or merges and erasures leave its
    data behind; the registry makes that one line at start-up.
  * Erasure is immediate and cannot be undone. A waiting period with a cancel, as Shopify has,
    needs scheduled jobs, which the worker does not run yet.
* **Alternatives:**
  * One number per customer, with merging dropping the duplicate's number: simple, but every
    later order from the second SIM would make the duplicate again.
  * A `merged_into` pointer instead of moving data: nothing to move, but every read would follow
    pointers, and uniqueness of numbers would span two tables.
  * The orders module erasing when it sees a `customer.erased` event: no handler interface, but
    an erasure would leave personal data in orders until the event is handled, and could not be
    refused for open orders.

## ADR-027 · Customers' numbers are masked by role, and reveals go to an append-only audit log

* **Context:** a shop's customer list is its most valuable data, and its numbers are what a
  departing agent or a careless marketer could take. The role design gives confirmation agents a
  masked number with a logged reveal, and packers, marketers and accountants no numbers
  ([11 · Security §2.1](./11-security-and-compliance.md#21-merchant-staff),
  [IA §6](../design/02-information-architecture.md#6-permissions--navigation-matrix-presets)).
  A logged reveal needs somewhere lasting to log it; the outbox keeps events for days.
* **Decision:**
  * **Masking is decided by the caller's role, in the API layer.** Owners, managers and apps
    see numbers whole; every other role sees "0300 ••••567" wherever a number appears: orders,
    addresses, customers, other numbers, the blocklist and consent history. Services return
    whole numbers; only the GraphQL mappers mask, through one function in `@hatti/api`.
  * **Confirmation agents reveal a number** with `orderPhoneReveal` or `customerPhoneReveal`;
    roles that only see numbers masked are refused. Each reveal is an audit entry naming who, in
    what role, and which order or customer.
  * **The audit log** is a platform table beside the outbox (`platform.audit_log`), written in
    the transaction of what it records and append-only for request code. It also records
    exports, merges, erasures and policy changes, and owners and managers read it as the shop's
    activity log.
* **Consequences:**
  * A number a role should not see never reaches its screen, whichever screen asks.
  * Apps see numbers whole for now. Protected customer data scopes, as Shopify has, would let a
    shop grant an app orders without numbers.
  * The log grows with every reveal; it is one table until monthly partitions are needed.
* **Alternatives:**
  * Masking in the admin app only: simplest, but anyone with the role's token could ask the API
    for whole numbers.
  * A `read_customer_phones` scope: fits apps too, but every existing token and role would need
    it to keep working, and a reveal is not a scope.
  * Logging reveals as domain events only: consumers see them, but the outbox forgets after a
    week, and a log a merchant relies on must not depend on a consumer.

## ADR-028 · Printable documents are HTML pages with print styles; PDFs will render the same pages

* **Context:** packers print packing slips and invoices for dozens of orders at a time, on A4
  printers or on thermal label and receipt printers, in English and Urdu. Urdu is set in
  Nastaliq, which needs a full text-shaping engine; PDF libraries for Node shape it poorly, which
  is why the [tech stack](./02-tech-stack.md) plans Gotenberg (headless Chromium) for PDFs. That
  service comes with the infrastructure, which waits on the hosting decision (ADR-015).
* **Decision:**
  * **Documents are HTML pages** rendered on the server from TypeScript templates, with print
    styles for each paper: A4, 4×6 inch thermal labels and 80 mm receipt rolls. One page holds
    many orders, each on a sheet of its own. The admin opens it and prints it from the browser,
    which shapes Nastaliq correctly.
  * **Templates escape by default.** They are tagged templates (`html` in `@hatti/documents`)
    that escape every value unless it is markup the package built, so a customer's name cannot
    add a tag. Documents run no scripts.
  * **Wording is English, Urdu or both.** Urdu documents run right to left; names, addresses and
    products stay as typed, isolated so each reads in its own direction.
  * **A document shows what its caller may see**, as the API does: customers' numbers are masked
    for staff who see them masked (ADR-027).
  * **PDFs will come from the same pages:** the documents service will print them with Gotenberg,
    in bulk through the queue, to store, email or send on WhatsApp.
* **Consequences:**
  * Printing works now, with no new infrastructure, and PDFs will reuse the templates rather than
    a second layout.
  * The merchant prints through the browser's print dialog. The page sets the paper size and
    margins, but a thermal printer needs its paper size set once in its driver.
  * Fonts load from Google Fonts until the CDN serves them.
  * Merchants cannot edit the templates yet. Shopify lets them edit packing slips in Liquid;
    merchant-edited templates could render into the same page shell through the theme engine
    (ADR-006).
* **Alternatives:**
  * PDFs from a Node library (pdfmake, pdf-lib): weak Nastaliq shaping, and CPU-heavy work in
    request handlers.
  * Headless Chromium inside the API process: a browser's memory and patching in every API pod;
    a separate Gotenberg service is the plan.
  * A template language (Handlebars, Liquid) for these fixed documents: another syntax to learn
    and to escape correctly, where TypeScript templates are type-checked against the order
    records.
  * ESC/POS commands for thermal printers: exact control, but most printers cannot shape Urdu
    text themselves and there is no preview. ESC/POS stays the plan for POS receipts.
