# 13 · Architecture Decision Log

> **Status:** Living document · **Last updated:** 2026-09-30 (ADR-033 to ADR-051 added)
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
| 029 | Refunds record money staff sent back; only owners and managers make them | Accepted |
| 030 | Idempotency keys are kept in Postgres, per caller, for a day | Accepted |
| 031 | Draft orders keep agreed prices and hold no stock; customers confirm them through a secret link | Accepted |
| 032 | Customers confirm or cancel cash-on-delivery orders through a link that then follows the order | Accepted |
| 033 | Customers correct an order's address through its link until it is packed; the number stays the shop's | Accepted |
| 034 | Customers add a draft's address, and their number while it has none, through its link | Accepted |
| 035 | The storefront renders Liquid with limits of its own, fetching lists a chunk at a time | Accepted |
| 036 | One publisher per shop rebuilds storefront documents from the database, its writes fenced by its lock | Accepted |
| 037 | Every shop has a handle naming its storefront on the platform's domain; storefronts find shops through a directory in Valkey | Accepted |
| 038 | An order's link lasts until 30 days after the order ends | Accepted |
| 039 | A shop's theme is a platform theme with the shop's own JSON files over it | Accepted |
| 040 | A shop's menus are kept whole, linking to collections and products by ID | Accepted |
| 041 | What a shop sets for its storefront as a whole is the online store's, starting with its WhatsApp number | Accepted |
| 042 | Carts are kept by the core and priced whenever they are read; storefronts change them with a key of their own | Accepted |
| 043 | A shop charges for delivery once for everywhere, by zones of cities, and not at all from a subtotal | Accepted |
| 044 | Checkout is one page the core renders and storefronts serve on the shop's address, placing a cash-on-delivery order as the page showed it | Accepted |
| 045 | A shop's pages keep HTML cleaned of anything that runs when saved; the storefront shows it as it is | Accepted |
| 046 | Storefront search asks the core, which finds products in Postgres as the admin's search does, until Typesense | Accepted |
| 047 | The edge keeps storefront pages by the handles they name before they stream, and forgets those whose documents change | Accepted |
| 048 | A shop's own domains are the online store's, one shop's each, served once DNS points them at the platform, the primary one where pages send shoppers | Accepted |
| 049 | A theme is previewed through a link the core seals, which storefronts keep in a cookie and render from the core's files, never kept | Accepted |
| 050 | The theme editor talks to its preview through postMessage: a framed preview is in design mode, and renders sections with the editor's unsaved files | Accepted |
| 051 | Search engines and link previews are told each page's address at the shop's own, in each language, and find pages through sitemaps of the storefront's documents | Accepted |

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

## ADR-029 · Refunds record money staff sent back; only owners and managers make them

* **Context:** merchants give money back when an item arrives damaged, a delivery charge is
  waived or a prepaid order is cancelled, by bank transfer, JazzCash or Easypaisa, or in cash.
  No payment gateway is integrated yet, so Hatti cannot send refunds itself. A refund is money
  leaving the shop, and the role design keeps money matters with owners and managers
  ([IA §6](../design/02-information-architecture.md#6-permissions--navigation-matrix-presets)),
  while confirmation agents and packers change orders all day.
* **Decision:**
  * **A refund is a record** of money staff already sent: amount, method, an optional reference
    and note, who and when (`orders.refunds`). The order keeps what was paid (`amount_paid`,
    which refunds never lower) and what was refunded since (`amount_refunded`, never more). Its
    financial status becomes `refunded` or `partially_refunded`.
  * **Refunds do not move orders.** An order is complete once it is delivered and was paid in
    full, even if some of it went back later: a completed order stays completed and closed, and
    closed and cancelled orders still take refunds.
  * **Refunds touch money only.** Items come back to stock through returns (the refused-parcel
    check-in now, customer returns with ORD-07), not through refunds.
  * **Only owners and managers refund**, besides apps with `write_orders`: the API refuses other
    staff roles, which have `write_orders` too, with `ACCESS_DENIED`. Every refund is also an
    audit entry (ADR-027).
  * What a customer has spent counts refunds out.
* **Consequences:**
  * Merchants keep one record of what was paid and given back, for their accounts and for
    customers' spending, before any gateway exists. Gateway refunds will create the same record
    once the provider confirms them.
  * A refund recorded by mistake cannot be undone yet; a correction would be a new kind of entry,
    as the ledger never edits money after the fact.
  * Store credit waits for a store-credit ledger.
* **Alternatives:**
  * Lowering `amount_paid` on a refund: simpler columns, but it loses what was received, and an
    order refunded in part would stop counting as paid in full.
  * A `write_refunds` scope: apps would need it too, and every existing role preset would change.
    Shopify gates refunds by staff permission, not by an app scope.
  * Refund lines with restocking, as Shopify has: needed with customer returns, which come later.

## ADR-030 · Idempotency keys are kept in Postgres, per caller, for a day

* **Context:** a client whose request times out cannot tell whether it ran. Retrying `orderCreate`
  could place the order twice, and retrying `orderRefund` could record a refund twice. The API plan
  makes an `Idempotency-Key` header mandatory for order, refund and fulfilment mutations ([08 · API
  §1.1](./08-api-and-app-platform.md#11-conventions)). A mutation's work can span several
  transactions (a bulk action runs one per order), so the key cannot share one transaction with the
  work.
* **Decision:**
  * **The Admin API honours `Idempotency-Key` on any mutation, before GraphQL runs.** The key is
    claimed in `platform.idempotency_keys`, the request runs, and its answer, the HTTP status and
    body, is kept for 24 hours. A retry with the same key and the same request (query, operation
    name and variables, in any key order) gets that answer back, marked
    `Idempotent-Replayed: true`, whether it held data, user errors or an error.
  * **Keys belong to one shop and one caller:** an app's access token, or a staff member.
  * **Mistakes are refused, not guessed at.** The same key with a different request gets `422`;
    a retry while the first request still runs gets `409`. A request that dies holds its key
    for a minute at most, then a retry runs it.
  * **Mutations that must not run twice need a key** (`400` without one): `orderCreate`,
    `orderFulfill`, `orderRefund` and `inventoryAdjustQuantities`. Resolvers say so with
    `@RequireIdempotencyKey()`. Mutations that are safe to repeat, such as confirming or
    cancelling, accept a key but need none; queries ignore it.
* **Consequences:**
  * A retry after a timeout never does the work twice while the answer is kept.
  * Each request with a key costs two small transactions, before and after it runs.
  * A kept answer can hold a customer's details for up to a day; erasing the customer does not
    reach it.
  * If the process dies after the work commits but before the answer is kept, a retry more than
    a minute later runs again. Closing that gap would need the key in the transaction of the
    work, which single-transaction mutations could do later.
* **Alternatives:**
  * Valkey with a time-to-live: fewer writes to Postgres, but tests and development would need
    it too, and a flush would forget keys whose work had happened.
  * An `idempotencyKey` argument on each mutation, as some newer Shopify mutations take: visible
    in the schema, but every service would repeat the check that one hook does here.
  * Keys per shop rather than per caller: two apps choosing the same key would collide, and one
    could read the other's answer.

## ADR-031 · Draft orders keep agreed prices and hold no stock; customers confirm them through a secret link

* **Context:** many Pakistani orders are agreed in Instagram and WhatsApp chats: the customer
  picks items, a price is agreed, and the address comes later. Staff type such orders in by hand
  and then call to confirm cash on delivery, and some customers never answer ([05 · Checkout
  §7](./05-checkout-and-payments.md#7-payment-links-draft-orders-and-social-selling), ORD-03).
  There is no storefront or checkout yet, no payment gateway (spike 4), and no WhatsApp or SMS
  sending (spike 3).
* **Decision:**
  * **A draft order keeps its items at the prices agreed, and holds no stock.** A line's price is
    fixed when it is added: the price given, or the variant's price then. Placing the draft
    commits its stock as any order does, so an item that sold out fails then, and the draft
    stays open.
  * **Staff place a draft** with `draftOrderComplete`, as `orderCreate` would place it: a
    cash-on-delivery order then waits for confirmation. **Or they send the customer a link**
    (`draftOrderLinkCreate`) to a page with the items, the total and the address, where the
    customer confirms: the draft becomes an order the customer confirmed, unless the number is
    blocked or the order risky, which waits for review as any order does.
  * **A link is a secret of 128 random bits, kept only as a SHA-256 digest.** It works for 72
    hours unless set otherwise (1 to 720), and a draft has one at a time: a new link replaces the
    old. A `SECURITY DEFINER` function finds a link's shop and draft, as access tokens are found.
    Only a cash-on-delivery draft with an address gets a link, and a draft that stops being one
    loses it (since [ADR-034](#adr-034--customers-add-a-drafts-address-and-their-number-while-it-has-none-through-its-link), any cash-on-delivery draft: its page asks for the
    address).
  * **The core API serves the page at `/d/<secret>`, under `PUBLIC_URL`**, until the storefront
    exists. A GET only shows it; a POST confirms, carrying the version of the draft the page
    showed (since [ADR-032](#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order),
    a digest of what the page showed), so a link preview never places an order, and a draft that
    changed after the customer opened the page is shown to them again. The page runs no scripts, and is sent with a
    content security policy that allows only its own styles (by hash) and Google Fonts, never
    cached, indexed or framed, and with `Referrer-Policy: no-referrer`, since its address is the
    secret. The customer's number is masked on it; the address is whole, for them to check.
  * **An order confirmed through a link is placed by the system**, as its timeline and the stock
    history record, with the draft named in its timeline.
  * **The page has no rate limit of its own.** Secrets cannot be guessed, an unknown one costs
    one indexed lookup, and limits per client address would misfire behind the carrier-grade NAT
    of Pakistani mobile networks. Floods are for the edge to stop.
* **Consequences:**
  * Staff stop retyping orders from chats, and a customer who confirms through the link needs no
    confirmation call.
  * Stock can sell out between sending a link and the customer confirming: the page names the
    item, the customer asks the shop, and the draft stays open.
  * Drafts hold customers' details without naming a customer, so erasure finds them by the
    customer's numbers and email, and through their orders; the customers module now hands
    those to modules taking part in erasure.
  * Anyone holding a link sees the customer's name and address until it expires.
* **Alternatives:**
  * Reserving stock for a draft, as Shopify offers: a chat can go quiet for days, and the units
    held would stop other sales. It could come later as an option, with an expiry.
  * Drafts as orders in a draft state: every order list, count, export and report would have to
    leave them out. Shopify keeps them apart too.
  * Payment links now: they need gateways (spike 4). A draft paid by bank transfer is completed
    by staff once the money is in.
  * The storefront serving the page: it does not exist yet. The page can move there, under the
    shop's own domain, with the same paths.

## ADR-032 · Customers confirm or cancel cash-on-delivery orders through a link that then follows the order

* **Context:** a cash-on-delivery order waits for its customer to confirm it before it ships, and
  the confirmation sequence ends in a tap-to-confirm link, sent by SMS when WhatsApp fails ([06 ·
  Orders §3](./06-orders-fulfillment-logistics.md#3-order-confirmation), COD-02). Draft orders
  have such a link already ([ADR-031](#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link)).
  Messaging, which would send it, is spike 3. Customers also change their minds, and hearing so
  before a parcel ships saves a return.
* **Decision:**
  * **Any open order can get a link** (`orderLinkCreate`), made and kept as a draft's is: a
    secret of 128 random bits, kept only as a digest, working for 72 hours unless set otherwise,
    one at a time. Staff send it themselves for now; the confirmation sequence will send it
    later. Making one goes on the order's timeline and is an `order.updated` event, since the
    link shows the customer's address.
  * **While a cash-on-delivery order waits for its customer** (pending or no response, nothing
    shipped), the page at `/o/<secret>` offers to **confirm** it or **cancel** it. Confirming
    confirms it. Cancelling asks first, on a page (`?cancel`) that changes nothing, then cancels
    it because the customer asked, records its confirmation as rejected, and releases its stock.
    Both go on the timeline as the customer's doing, through the system.
  * **After that, the page follows the order:** confirmed, on its way with the courier and
    tracking number, delivered, not delivered, or cancelled. An order held for review, or placed
    by staff and not confirmed yet, reads "the shop will be in touch", as for drafts. A customer
    who tries to cancel an order that has moved on is told to ask the shop.
  * **A post carries a digest of what the page showed**, not the record's version: the items,
    the amounts and the address, with the number masked. A change the customer could see still
    sends them back to look again; notes, tags or a new link no longer do. Drafts' links work the
    same way now.
* **Consequences:**
  * The tap-to-confirm step exists before messaging does; the confirmation sequence only has to
    send the link.
  * A customer who declines costs the shop a cancelled order rather than a parcel sent back, and
    the order's stock is free again at once.
  * Whoever holds a forwarded link can confirm or cancel the order until it expires; the timeline
    says it happened through the link.
  * Following a parcel for longer than the link works takes a new link, until the order status
    page (05 §8) gives orders a lasting one.
* **Alternatives:**
  * Links only for orders waiting to be confirmed: the page has to show what became of the order
    when the customer comes back anyway, and a page that follows the order is the start of the
    order status page.
  * Cancelling with one tap: a slip of the thumb would cancel an order; asking first costs one
    more tap.
  * Keeping the version in the form: staff noting or tagging orders while customers read their
    pages would send those customers back to confirm again.

## ADR-033 · Customers correct an order's address through its link until it is packed; the number stays the shop's

* **Context:** the confirmation message offers "Confirm / Cancel / Change address" ([06 · Orders
  §3.1](./06-orders-fulfillment-logistics.md#31-channels-and-policy)), and a wrong or incomplete
  address is a common reason parcels come back. Orders' links
  ([ADR-032](#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order))
  let customers confirm or cancel; correcting the address still took a message to the shop and
  staff retyping it.
* **Decision:**
  * **Until an order is packed, its link's page offers to change the address**, on a page of its
    own (`?address`) filled in as the address is: name, house and street, landmark, city,
    province and postcode. Saving it (`action=address`) runs the checks and the update behind
    staff's `orderUpdate`: the city spelled the standard way, the province from the city unless
    one is picked, and a cash-on-delivery order scored again for its new address, held for
    review if that makes it risky. The timeline says the customer changed it through their link,
    and the page then says the address is saved.
  * **Packed is the cutoff, not shipped:** a packed parcel may carry the old address on its slip.
    After that, and for a cancelled order, the page tells the customer to ask the shop.
  * **The number is not the customer's to change here.** The page shows it masked, as these pages
    do everywhere, since links get forwarded; a form holding it would show it whole. A new number
    would also make the order another customer's, perhaps a blocked one: that is for staff.
  * **The form carries the digest of what the page showed**, as confirming does, so a customer
    never saves over a change the shop made while they typed. An address that does not check out
    comes back as typed, with what is wrong under each field, in English and Urdu.
  * **Confirming is not undone:** a customer who confirmed and then corrects the address stays
    confirmed, since they have just said where the order goes.
* **Consequences:**
  * Customers fix their own addresses before anything ships, without a call, and the
    confirmation message's third button has its page.
  * Staff see the change on the timeline and as an `order.updated` event. A shop that prints
    slips before marking orders packed can still pack a parcel with the old address; marking
    orders packed as their slips print closes the gap.
  * Whoever holds a forwarded link can redirect the parcel until it is packed, as they could
    cancel the order before; the timeline says it happened through the link, and the number the
    courier calls stays the customer's.
* **Alternatives:**
  * Changes until the parcel ships, as staff can make them: by then it may be packed and
    labelled.
  * Letting the customer change the number too: the page would have to show it whole, and the
    order would move to another customer.
  * Asking the customer to confirm again after a change: they have just said where it goes.
  * A correction request for staff to apply: staff would retype it, which the link avoids.

## ADR-034 · Customers add a draft's address, and their number while it has none, through its link

* **Context:** in a chat the items often come first and the address later: customers type it in
  pieces, and staff copy it into the draft before they can send its link
  ([ADR-031](#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link)).
  Customers can now correct an order's address on its link ([ADR-033](#adr-033--customers-correct-an-orders-address-through-its-link-until-it-is-packed-the-number-stays-the-shops)).
* **Decision:**
  * **Any cash-on-delivery draft gets a link, with or without an address.** Without one, the page
    shows the order and asks for the address before it can be confirmed, and the link's message
    asks the customer to add it. A draft that loses its address keeps its link; one that stops
    being cash on delivery loses it, as before.
  * **The form is the order link's**: the same checks, sent back as typed with what is wrong, and
    carrying the digest of what the page showed. It also asks for the customer's **mobile number
    while the draft has none**: they type their own, so the page shows nothing they did not give.
    Once the draft has a number, from them or from staff, the form shows it masked and a new one
    is for the shop.
  * **The customer can correct the address until they confirm**, and after that, through the
    same link, the order's address until it is packed, as on an order's link.
  * **A draft records that the customer changed it:** its `draft_order.updated` event names the
    address and says `byCustomer`. Drafts have no timeline; the order placed from one does.
* **Consequences:**
  * Staff send the items and the total, and customers fill in the rest in fields a courier can
    use, with the city spelled the standard way: nobody copies addresses out of chats.
  * Whoever holds a link sent without an address can give any address and number. The order it
    places is checked when it is confirmed, as any order is: a blocked number or a risky order
    waits for review, and the courier calls that number before delivering.
  * One link serves the order taken in a chat from the items to the parcel's doorstep.
* **Alternatives:**
  * The address in the chat, as before: slower, and retyped by staff.
  * One form that saves the address and confirms at once: the customer would confirm an address
    before seeing it as the shop will, with the city spelled the standard way and the province
    worked out.
  * Customer accounts with saved addresses: they need sign-in by one-time code, which Hatti does
    not have yet; the link needs none.

## ADR-035 · The storefront renders Liquid with limits of its own, fetching lists a chunk at a time

* **Context:** themes are Liquid, with JSON templates
  ([ADR-006](#adr-006--liquid-compatible-theme-engine-with-json-templates)), rendered at origin
  in 250 ms or less at p95 on a cache miss, each render held to 150 ms of CPU, 5,000 loop
  iterations and 2 MB of output, with drops batching their fetches per request
  ([04 · Storefront §3.3](./04-storefront-and-themes.md#33-rendering-pipeline)). Spike 1 built a
  renderer and a Dawn-class reference theme to test it
  ([report](../engineering/spikes/01-liquid-rendering.md)).
* **Decision:**
  * **LiquidJS is the engine** (MIT, pure JavaScript), with Hatti's tags and filters for
    Shopify's (`section`, `sections`, `schema`, `style`, `form`, `paginate`; `money`,
    `image_url`, `image_tag`, `t` and more) and Hatti's extensions (`money_pk`, `whatsapp_url`,
    `direction`, `cod`).
  * **Every render has limits of Hatti's own:** a section's, and the layout's. A limiter LiquidJS
    consults before each template node counts nodes (50,000; they stand in for loop iterations,
    since a loop counts its body on every pass) and watches the clock (150 ms); an emitter caps
    output (2 MB); snippets go 32 deep; LiquidJS's own memory limit bounds ranges. A section over
    a limit, or failing, is left out and logged, and the page is sent without it.
  * **Templates get plain objects**, and LiquidJS runs with `ownPropertyOnly` and `strictFilters`.
    Drops only where lookups are by name (`collections['sale']`) or lists fetch on first touch.
  * **Lists fetch a chunk at a time**, 12 products when a template first touches one, not batched
    by the tick: LiquidJS evaluates one expression at a time, so DataLoader would fetch each
    product in its own round trip. What a page will certainly need (its product or collection,
    sections' resource settings, the shop) is asked for before rendering.
  * **A page's sections render side by side**, those its layout names too, and the layout last.
* **Consequences:**
  * Pages of the reference theme render in 2 to 6 ms at p50, and one process renders about 260
    a second: rendering is not what the storefront's latency will be made of.
  * The node count bounds CPU the same whatever renders beside a section; the clock includes
    waits for data and the work of sections rendering alongside, so it is the backstop.
  * The limiter goes in through LiquidJS's `Context`, which is public but little used: the
    version is pinned, and tests go over every limit.
  * Themes put `dir="auto"` on merchants' text, which may be English on an Urdu page.
* **Alternatives:**
  * Shopify's Liquid in Ruby, or a Rust or WebAssembly port: another runtime beside Node, for
    rendering that already takes a few milliseconds.
  * Handlebars or a template language of our own: faster to sandbox, but no Liquid developer or
    Shopify theme could use it, which is the point of ADR-006.
  * Worker threads or isolates per render, for a true CPU limit: they would cost more than the
    renders; to revisit if apps' Liquid, which merchants do not write, proves abusive.

## ADR-036 · One publisher per shop rebuilds storefront documents from the database, its writes fenced by its lock

* **Context:** the storefront renders from documents in Valkey, rebuilt on catalog and stock
  events ([03 §8](./03-multi-tenancy-and-data.md#8-read-models--caching)). Events arrive at
  least once and in no set order, several at a time in each worker process. A bulk edit of 500
  products sends 500 events, and a smart collection's listing may change with any product.
* **Decision:**
  * **Events say what is stale, not what it is now.** Each maps to items: `product:<id>`,
    `collection:<id>`, `all-products`, `menus` and `shop`, and items standing for many
    (`collections-with:<product>`, `smart-collections`, `every-collection`, `every-product`,
    `everything`). They wait in a sorted set per shop; adding one already waiting changes nothing.
  * **Documents are built from the database as it is then**, never from events' payloads, so
    order and repeats do not matter.
  * **One publisher per shop at a time**, holding the shop's lock in Valkey (15 seconds, kept while
    it works). It takes 100 items at a time, those standing for many first, then products and the
    shop, then listings, then menus, so a listing seldom names a product not written yet. Other
    publishers add their items and return; the holder builds them before it lets go, and looks
    once more after. A batch is kept aside until built: put back if its build fails, and by the
    next holder if its publisher stopped.
  * **Writes are fenced:** each is a script that first checks the lock is still the writer's, so
    a publisher that stalled past its lock cannot write over what its successor built from newer
    data.
  * **Handles are indexes of their own**, a hash of IDs by handle and one of handles by ID. A
    document lets go of its old handle only if the handle still leads to it, so products that
    swap handles, or one built before another gives its handle up, keep the right ones.
  * **A shop without documents gets all of them** on its next event; the seed publishes its shop
    at once. Building everything also takes off documents whose rows went without an event.
* **Consequences:**
  * An edit through the Admin API showed on the storefront about 220 ms later, locally, through
    the outbox, the queue and the worker.
  * A burst of edits is built about once, not once per event, and a shop's build holds one worker
    slot while others go on with other shops.
  * An edit that can move a product in or out of listings, or reorder them, rebuilds the shop's
    smart collections, the collections holding it, `/collections/all` and the menus. Changing only
    a description, handle or images rebuilds the product alone.
  * A listing keeps all its product IDs in one document, read whole for each page of it: fine for
    thousands of products, not a hundred thousand.
  * Documents are overwritten in place, each write atomic, without 03 §8's versioned keys; the
    edge cache will carry versions, per theme version and locale.
* **Alternatives:**
  * Rebuilding in each event's handler: a bulk edit would rebuild the shop's listings once per
    product, and handlers racing each other could leave older documents last.
  * A BullMQ job per shop, deduplicated by its ID: the ID stays taken while the job runs, so
    events arriving as it finishes would be dropped. BullMQ Pro's groups would serve, at a price.
  * Comparing versions per document: stock changes do not change a product's version, and
    listings have none.
  * Change data capture into the documents: another system to run before the outbox is
    outgrown ([ADR-005](#adr-005--transactional-outbox--bullmq-first-kafka-compatible-log-later)).

## ADR-037 · Every shop has a handle naming its storefront on the platform's domain; storefronts find shops through a directory in Valkey

* **Context:** one storefront process has to serve every shop in its cell, each at its own
  address: `{handle}.hatti.pk`, or a domain of the shop's own through Cloudflare for SaaS
  ([04 §2.1](./04-storefront-and-themes.md#21-hostname-routing)). In production the edge will look
  hosts up in a copy of the shop directory and tell the cell which shop a request is for. Until the
  edge and the control plane exist, the storefront has to find the shop itself, and it reads only
  Valkey ([ADR-036](#adr-036--one-publisher-per-shop-rebuilds-storefront-documents-from-the-database-its-writes-fenced-by-its-lock)).
* **Decision:**
  * **Every shop has a handle** in `control.shops`: a lowercase DNS label of up to 40 characters
    with no double hyphen, unique across the platform, given when the shop is made and not changed
    by the shop. Request code may rename its shop; the handle, status, currency and time zone are
    the control plane's. Until the control plane chooses handles with merchants, a shop made
    without one gets a random one (`shop-…`).
  * **The storefront reads the handle from the host**: `zari.hatti.pk` names `zari`. It finds the
    shop in a hash of shops by handle in Valkey, which the publisher writes with the shop's
    settings, for open shops only, and remembers each answer for a few seconds. The platform's
    domain itself shows the sample shop in development; any other host gets a 404 until shops
    have domains of their own.
  * **The Admin API gives a shop's handle and storefront address** (`shop { handle url }`), from
    `STOREFRONT_URL`, the address of the platform's storefronts, which production requires.
* **Consequences:**
  * `pnpm dev:storefront` serves every published shop at `http://{handle}.localhost:4100/`:
    browsers and curl send `*.localhost` to this machine without setting anything up.
  * A suspended or closed shop's storefront stops answering the next time its shop is published;
    nothing publishes it when its status changes yet, since the control plane has no events.
  * Every storefront request asks the directory, answered from memory for five seconds: a new
    shop can take that long to appear.
  * Handles are platform-wide, so two cells cannot give out the same one: the control plane, which
    spans cells, will own them.
* **Alternatives:**
  * The shop's ID in the host or path: stable, but no merchant would print it on a card.
  * The storefront reading `control.shops` from Postgres: a database connection per storefront
    process and a query per request, where Valkey already holds everything else it reads.
  * Resolving hosts only at the edge: right for production, but development and tests would need
    a Worker running before they could see a shop.

## ADR-038 · An order's link lasts until 30 days after the order ends

* **Context:** an order's link works for 72 hours unless staff choose otherwise
  ([ADR-032](#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order)),
  but a cash-on-delivery parcel can take a week to arrive, and longer to come back; the order status
  page (05 §8) is meant for following it the whole way. The link shows the customer's address, so
  it should not work for ever.
* **Decision:**
  * **By default an order's link has no expiry of its own**: it works while the order is open, and
    for 30 days after the order is closed or cancelled. Staff may still make one expire after 1 to
    720 hours; it then stops at that time, or 30 days after the order ends if that comes first.
  * **What the customer may do keeps its own window**: confirm or cancel while the order waits for
    them, correct the address until it is packed. Only watching lasts.
  * **The page tells the customer to keep the link** where it would have shown when it stops
    working. The Admin API gives an order's `customerLink`, whose `expiresAt` is null while a
    lasting link's order is open, replacing `linkExpiresAt`.
  * Drafts' links keep their 72 hours: a draft waits for a quick answer, and its order gets a link
    of its own.
* **Consequences:**
  * One link sent when the order is placed serves the customer from confirming to delivery, and a
    return after.
  * A forwarded link shows the order, with the address and a masked number, for as long; erasing
    the customer's details still takes it.
  * Orders that stay open for months keep their links working; closing or cancelling them ends
    that 30 days later.
* **Alternatives:**
  * A longer fixed expiry, such as 30 days from the link: still too short for an order held for
    review, and needlessly long for one delivered the next day.
  * A second, read-only link for following the order: two links for customers to tell apart,
    where one whose actions end on their own suffices.

## ADR-039 · A shop's theme is a platform theme with the shop's own JSON files over it

* **Context:** themes are Shopify's shape: Liquid layouts, sections and snippets, JSON templates
  and settings ([ADR-006](#adr-006--liquid-compatible-theme-engine-with-json-templates),
  [04 §3](./04-storefront-and-themes.md#3-theme-architecture)). Merchants change their home page,
  their colours and their announcement first; the visual editor (OS-02) saves exactly those. A
  code editor that lets them change Liquid comes later (OS-04, V1), after Theme Check.
* **Decision:**
  * **A shop's theme is a platform theme, Hatti Base for now, with the shop's own files over it**:
    JSON only, its templates (alternates such as `product.unstitched` too), section groups and
    `config/settings_data.json`. Liquid, assets and translations stay the platform theme's.
  * **The main theme is the one the storefront shows.** Others are prepared and then published in
    its place (`themeCreate` copying the main one, `themeFilesUpsert`, `themePublish`); a shop
    keeps up to 20. The main one is made on first use, with no files of the shop's own.
  * **Every change raises the theme's version**, and `theme.updated` or `theme.published` tells
    the storefront's publisher.
  * **The storefront reads the main theme from a document of its own**, which the publisher
    writes with the shop's document and before it, from one read
    ([ADR-036](#adr-036--one-publisher-per-shop-rebuilds-storefront-documents-from-the-database-its-writes-fenced-by-its-lock)).
    The shop's document names the theme's version; a storefront lays each version over the
    platform theme once, and keeps it for the pages after, up to 64 MB of shops' files a
    process.
  * **Files are checked when saved**: for their shape (JSON, sections listed in their order,
    blocks, IDs of letters, digits, `_` and `-`, at most 25 sections, 50 blocks a section and
    256 KB a file), then by Theme Check against the platform theme, as the storefront would read
    them: the sections, blocks and settings they name, blocks' limits, and each setting's value
    against its type. A file with a problem is refused, with what is wrong and where. Theme Check
    is in `@hatti/themes`, the code the storefront reads themes with, so the two cannot disagree.
    The storefront still leaves out a file it cannot use, and holds each setting to its type, the
    default taking the place of a value that is not, for files saved before a platform theme
    changed.
  * **The Admin API follows Shopify's**: `themes`, `theme`, `themeCreate`, `themePublish`,
    `themeDelete`, `themeFilesUpsert` and `themeFilesDelete`, under `read_themes` and
    `write_themes`, which owners and managers have.
* **Consequences:**
  * A fix or a new section in the platform theme reaches every shop at once; a shop keeps only
    what it changed.
  * Nothing a shop saves runs as code, so its storefront stays within the renderer's limits
    whatever it saves; and nothing it saves ends a style or an attribute the theme prints it in.
  * A change replaces the file before it: versions to roll back to and scheduled publishing
    (04 §3.4, OS-03) are to come.
  * A platform theme that drops a section or a setting leaves shops' files that name it: the
    storefront leaves those files out, and saving them again is refused until they no longer
    name it. The platform theme keeps what shops use, or moves their files on itself.
* **Alternatives:**
  * Copying the whole platform theme into each shop, as Shopify does: every fix to the platform
    theme would need merging into every shop's copy.
  * Settings only, without templates: the home page's sections are what merchants change most.
  * Checking files only in the storefront: a merchant would find a page no longer showing their
    change, and no reason.
  * Liquid from shops now: the renderer's limits would hold it, but Theme Check reads only JSON
    files so far, so nothing would tell a merchant what their Liquid broke.

## ADR-040 · A shop's menus are kept whole, linking to collections and products by ID

* **Context:** themes show menus by handle, as `linklists['main-menu']`. Merchants arrange them
  as in Shopify's navigation editor: items nested up to three levels, each linking to a
  collection, a product, a page or an address. Until now the storefront's menus were made from
  the shop's collections.
* **Decision:**
  * **A menu's items are one JSON tree, saved whole** (`online_store.menus.items`), as Shopify's
    `menuUpdate` replaces all of them: three levels deep, at most 250 items and 200 KB.
  * **Links to collections and products name them by ID**, and take their current handles when
    read. The Admin API gives each item's `url`; the storefront leaves out a link to what it
    cannot show, gone or not active, with the links under it.
  * **Every shop has a main menu and a footer menu**, which keep their handles and are not
    deleted. They are made the first time the shop looks at its menus, from what its storefront
    showed until then: its first five collections with products, by title, then all products.
    Until then the storefront's menus follow its collections as they change.
  * **Links go to the home page, all products, a collection, a product or an address**
    (Shopify's `FRONTPAGE`, `CATALOG`, `COLLECTION`, `PRODUCT` and `HTTP`); the other kinds come
    with pages, blogs and search. An address is a path on the storefront, or a web, mail or phone
    address, with nothing that could end the attribute a theme prints it in: checked when saved,
    and again by the storefront.
  * **The Admin API follows Shopify's**: `menus`, `menu`, `menuCreate`, `menuUpdate` and
    `menuDelete`, under `read_online_store_navigation` and `write_online_store_navigation`, which
    owners and managers have. `menu.created`, `menu.updated` and `menu.deleted` tell the
    storefront's publisher, which writes all of a shop's menus as one hash, so a deleted menu
    goes.
* **Consequences:**
  * Menus stay right as the catalog changes: a collection's new handle, or a product taken off
    sale, needs no menu edit. The publisher reads the collections and products menus link to
    when it builds them, and builds menus again when a product's handle changes.
  * Saving a menu replaces it: of two people editing one menu at once, the last save stands.
* **Alternatives:**
  * A row per menu item: Shopify's API edits a menu whole, and menus are small.
  * Links kept as addresses, as the storefront prints them: a collection's new handle would
    break every menu linking to it.
  * Default menus made with every shop: shops made before menus would need them too, and made on
    first use they come from what the shop's storefront already showed.

## ADR-041 · What a shop sets for its storefront as a whole is the online store's, starting with its WhatsApp number

* **Context:** Pakistani shoppers ask and order on WhatsApp, so Hatti Base's product pages offer
  "Order on WhatsApp" and its home page a WhatsApp section, both needing the shop's number. The
  shop directory (`control.shops`) belongs to the control plane, which replicates it read-only
  into cells, so settings a shop edits every day do not belong there.
* **Decision:**
  * **The online store module keeps a shop's storefront preferences**, a row per shop once it
    sets any (`online_store.preferences`), as the orders module keeps its risk settings. The
    first is the WhatsApp number; the storefront's title, description and password would join
    it.
  * **The number is a Pakistani mobile, kept in E.164**, given in any common format; blank takes
    it away.
  * **The Admin API has `onlineStorePreferences` and `onlineStorePreferencesUpdate`**, under the
    settings scopes owners and managers have. Only the preferences given change, and
    `online_store_preferences.updated` tells the storefront's publisher, which writes the number
    into the shop's document.
* **Consequences:**
  * The storefront shows a shop's number a moment after it is set, and nothing where it has none.
  * The number is the shop's to give: nothing checks that it is on WhatsApp until the shop
    connects its WhatsApp account (MSG-02).
* **Alternatives:**
  * A column in `control.shops`: request code would write to the control plane's copy.
  * A setting in the theme's settings: it would change with the theme, and apps and the admin
    would have to find it there.

## ADR-042 · Carts are kept by the core and priced whenever they are read; storefronts change them with a key of their own

* **Context:** carts are the first thing shoppers write; until now a storefront only read
  documents in Valkey
  ([ADR-036](#adr-036--one-publisher-per-shop-rebuilds-storefront-documents-from-the-database-its-writes-fenced-by-its-lock)).
  Themes change carts through Shopify's cart forms and Ajax cart (`/cart/add`, `/cart/change`,
  `/cart/update`, `/cart/clear`, `/cart.js`) on the shop's domain, the cart named by a cookie,
  and Dawn's cart drawer asks for sections rendered after each change. Checkout starts from a
  cart and prices everything again on the server
  ([05 §1](./05-checkout-and-payments.md#1-principles)).
* **Decision:**
  * **The core keeps carts**, in the checkout module's `checkout.carts`: a row per cart, its
    lines as JSON (a variant, a quantity and what the shopper typed), with the cart's note and
    attributes. A cart holds no prices or titles: the catalog and inventory are read whenever it
    is, in the same transaction, so it always shows today's prices.
  * **A cart is found by a secret**, 128 random bits in the shopper's cart cookie, of which the
    core keeps only the SHA-256, as for customers' links. A secret naming no cart, as once it
    expired, is never taken up: the next change makes a new cart with a secret of its own. A cart
    lasts 14 days after its last change; expired carts are deleted as the shop gets new ones.
  * **Carts behave as Shopify's do**: adding a variant with the same properties adds to its line;
    new lines go first; `change` names a line by its key, its variant or its place; `update` adds
    variants the cart lacks; `clear` keeps the note and attributes. A cart has at most 100 lines
    and 10,000 units a line, as an order. A change that would give the cart more of a variant
    than can be sold online is refused; a line whose stock ran out after it was added stays,
    saying how many can be bought, for checkout to deal with. Lines whose product is gone or no
    longer active are left out, and leave the cart at its next change.
  * **The storefront fronts carts; the core keeps them.** The storefront serves every path of a
    shop's domain, `/cart` too, since the cart page and the sections the Ajax cart asks for are
    the theme's: it turns Shopify's forms and Ajax calls into the core's actions, and renders the
    answers. The core's routes under `/storefront/` answer only storefronts, which present the
    platform's storefront key and name the shop they found by host. `@hatti/storefront-api`
    holds what the two say to each other, and the client.
  * **Refusals are codes with their facts**, such as `MAX_QUANTITY` with the most that can be
    bought: the storefront words them in the shopper's language.
* **Consequences:**
  * A cart change is one short transaction on the core, and a cart page one request to it;
    neither is cached. The edge (04 §2) sends cart paths to the storefront uncached, rather than
    to a storefront API pool.
  * Limits on how fast a shopper can change carts are the storefront's, which sees their
    address.
  * Pages stay the same for every shopper: the cart page alone shows the cart, and other pages
    show its count from a cookie the storefront sets beside the cart's secret, which scripts
    cannot read.
  * Lines kept as JSON cannot be searched across carts; abandoned checkouts, which will have rows
    of their own, carry what recovery needs (CHK-12).
* **Alternatives:**
  * Carts in Valkey, written by the storefront: it would need prices and stock, which its
    documents leave out on purpose, and a cart would be lost with the cache.
  * A row per line: more statements per change, for nothing a cart needs yet.
  * The edge sending the Ajax cart straight to the core: its answers' `sections` need the theme,
    which only the storefront renders.
  * Shopify's GraphQL Storefront API for carts now
    ([ADR-008](#adr-008--graphql-for-public-admin-and-storefront-apis)): a second schema in the
    core for one caller. It comes with headless storefronts (04 §7), on the same service.

## ADR-043 · A shop charges for delivery once for everywhere, by zones of cities, and not at all from a subtotal

* **Context:** most Pakistani shops charge shoppers a flat delivery fee, often less in their own
  city, and nothing above an order value, whatever the courier charges them. Checkout adds it
  ([05 §3](./05-checkout-and-payments.md#3-cart--pricing-calculation-pipeline), step 4), and
  shoppers should see it before checkout, not at the last step (05 §1). CHK-04's MVP half is
  city-group zones, a flat charge and a free threshold.
* **Decision:**
  * **The checkout module keeps what a shop charges for delivery**
    (`checkout.delivery_settings`, a row per shop once it sets any): one charge for everywhere,
    up to 20 zones of cities with charges of their own, and a subtotal from which delivery is
    free. Zones are saved whole, as a shop edits them together.
  * **Zones name cities as addresses do**, through `@hatti/pk`'s cities and their aliases
    ("khi", "Pindi"), each city in one zone. A city the list lacks takes the charge for
    everywhere.
  * **`deliveryCharge(settings, city, subtotal)` is the one rule**: nothing from the free
    subtotal, else the charge of the city's zone, else the charge for everywhere. Checkout adds it
    for the delivery address's city.
  * **The Admin API has `deliverySettings` and `deliverySettingsUpdate`**, under the settings
    scopes owners and managers have. `delivery_settings.updated` tells the storefront's
    publisher, which puts the charges in the shop's document, and themes show them (Liquid's
    `delivery`): "Free delivery on orders of Rs 5,000 or more", "Add Rs 500 more for free
    delivery".
* **Consequences:**
  * A shop that set nothing delivers free, and its storefront says nothing of charges.
  * Rates by weight or value, couriers' own rates, local delivery and pickup (CHK-04's V1 half)
    come with shipping profiles, in the fulfilment context, which may take these settings over.
* **Alternatives:**
  * Shopify's delivery profiles, with rates per product group, zone and condition: far more than
    shops here set, and a shop's profile can grow from these settings later.
  * A row per zone: more to keep consistent, for no query that needs it.
  * The charges in the online store's preferences: what an order costs is checkout's.

## ADR-044 · Checkout is one page the core renders and storefronts serve on the shop's address, placing a cash-on-delivery order as the page showed it

* **Context:** shoppers fill carts the core keeps
  ([ADR-042](#adr-042--carts-are-kept-by-the-core-and-priced-whenever-they-are-read-storefronts-change-them-with-a-key-of-their-own)),
  shops set what delivery costs
  ([ADR-043](#adr-043--a-shop-charges-for-delivery-once-for-everywhere-by-zones-of-cities-and-not-at-all-from-a-subtotal)),
  and the orders module places orders with their stock committed, their customer found by
  number, the blocklist and the COD risk score applied
  ([ADR-025](#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)).
  Checkout joins them: one page, phone first, that works without scripts (CHK-01, CHK-19),
  recomputes everything on the server and never places an order twice
  ([05 §1](./05-checkout-and-payments.md#1-principles)). Shopify's checkout is its own
  application, not the theme's, on the shop's domain.
* **Decision:**
  * **A checkout is a row with a secret of its own** (`checkout.checkouts`): the cart form's
    `checkout` button, or `/checkout`, has the storefront ask the core for one
    (`POST /storefront/shops/{shop}/checkouts`, with the cart's secret). The core keeps the
    SHA-256 of 128 random bits, the cart it checks out and, once placed, the order. It lasts 24
    hours, its thank-you page with it; a shop's new checkout deletes up to 100 of its expired
    ones. Nothing the shopper types is kept until the order has it.
  * **The page is the core's**, rendered as customers' links' pages are: HTML without scripts,
    in English and Urdu, with a strict Content-Security-Policy, never cached, indexed or framed.
    It shows the cart's lines at the catalog's prices now, with the properties shoppers see, and
    what delivery costs: exact once a city is typed or when every city costs the same, otherwise
    the shop's charges by city. Its form asks for a name, a mobile number, a city (the cities
    suggested as the shopper types), the house and street, an area or landmark, and a province
    only when the city does not give it. Cash on delivery is the only way to pay yet.
  * **Storefronts serve it on the shop's address**, `/checkouts/{secret}`: they fetch it from the
    core (`GET` and `POST /storefront/shops/{shop}/checkouts/{secret}`, JSON with its status,
    headers and HTML), for their own shop's checkouts only, and send it. The core serves the same
    page at its own address too. The shopper stays on the shop's address from cart to thank-you
    page, and the storefront, which keeps the cart's cookies, sets the count to 0 once the order
    is placed.
  * **The order is placed as the page showed it**, in one transaction: the form carries a digest
    of what the page showed (the lines with their prices, the note, the delivery charges). The
    core locks the checkout and the cart, prices the cart again, and places nothing if the digest
    differs: the page shows the cart as it is now, what the shopper typed kept. Then it checks the
    address as orders do, refuses lines that cannot be bought now, and places the order through
    the orders module: source `online_store`, cash on delivery, at the prices shown, with the
    delivery charge for the address's city (`deliveryCharge`), stock committed, the customer found
    or created by number, and the blocklist and risk score applied as for any order. Lines'
    properties go in the order's note. The checkout records the order, and the cart is emptied.
  * **Placing twice places one order**: the lock makes a second post, as from a double tap, find
    the order and show it, and another checkout of the same cart find it empty. A post that
    places the order redirects (303) to the page, so reloading it posts nothing.
  * **The shop confirms it as any other** cash-on-delivery order; the thank-you page says the
    shop will call or message to confirm it.
* **Consequences:**
  * Checkout works on any phone, without scripts, on the shop's address. The storefront relays
    one more route, and the edge (04 §2) passes `/checkout` and `/checkouts/` through uncached.
  * Shops cannot brand the page yet (CHK-14), and its links back to the shop go to its
    platform subdomain.
  * Until the page has scripts, a shop with zones shows its charges by city until the shopper
    types a city (05 §1, principle 3, in part).
  * Not yet: the OTP (CHK-09), the COD fee (CHK-08), COD rules (CHK-07), discounts (CHK-06),
    online payment (PAY-01), stock held during checkout, and capturing abandoned checkouts
    (CHK-12). Each has its place in the flow (05 §2).
* **Alternatives:**
  * A Liquid template in the shop's theme, as Shopify's `checkout.liquid` was: a theme could break
    the page that matters most, and Shopify retired it.
  * The page on the core's address alone: shoppers would leave the shop's address to order, and
    the storefront could not reset the cart's count once they had.
  * A copy of the cart's lines in the checkout, as Shopify's checkout object keeps: a second copy
    to keep in step, where the digest already makes the order what the page showed.
  * Reserving stock when checkout starts: fairer during drops, but reservations need expiry.
    Committing when the order is placed never sells a unit twice, and the page says what sold
    out.

## ADR-045 · A shop's pages keep HTML cleaned of anything that runs when saved; the storefront shows it as it is

* **Context:** every shop needs pages of its own: About us, Contact, and how it delivers and
  takes returns, which shoppers here read before paying cash to a shop they do not know (OS-07).
  Shopify keeps a page's body as HTML, which its editor writes, apps send and shops moving from
  Shopify bring, and themes print `page.content` as it is. Until now a shop could put nothing on
  its storefront that runs: its theme's files are JSON over the platform theme's
  ([ADR-039](#adr-039--a-shops-theme-is-a-platform-theme-with-the-shops-own-json-files-over-it)),
  and product descriptions are text. Checkout is served on the same address
  ([ADR-044](#adr-044--checkout-is-one-page-the-core-renders-and-storefronts-serve-on-the-shops-address-placing-a-cash-on-delivery-order-as-the-page-showed-it)).
* **Decision:**
  * **The online store module keeps a shop's pages** (`online_store.pages`): a title, a handle
    unique in the shop that names it at `/pages/{handle}`, made from the title as the catalog
    makes handles when none is given, a body of HTML up to 512 KB, when it was published (or null
    while it is hidden), and the theme's page template it asks for, as `page.contact.json`.
  * **A body is cleaned when it is saved**, with `sanitize-html` and a list of what may stay:
    text and its formatting, headings, lists, links to web, mail and phone addresses and to the
    storefront, images over http(s), tables, and where text sits and its colour. Scripts, style
    sheets, frames, forms, event handlers, `id`, `name` and `class`, and every other address go;
    the text of what goes stays. The API gives back the body as kept, so a shop sees what its
    storefront will show.
  * **The storefront shows it as it is**: the publisher writes each published page as a document
    found by its handle, as products are, and Hatti Base's `page` template prints `page.content`,
    as Shopify's themes do. Liquid has `page` and `pages['about-us']`, and settings of type `page`.
  * **The Admin API follows Shopify's**: `pages`, `page`, `pageCreate`, `pageUpdate` and
    `pageDelete`, under `read_online_store_pages` and `write_online_store_pages`, which owners,
    managers and marketers have: pages are the content marketers edit
    ([design 02 §6](../design/02-information-architecture.md#6-permissions--navigation-matrix-presets)). `page.created`, `page.updated` (naming what changed) and `page.deleted` tell the
    storefront's publisher.
  * **Menus link to pages by ID** (`PAGE`), as to collections and products
    ([ADR-040](#adr-040--a-shops-menus-are-kept-whole-linking-to-collections-and-products-by-id)):
    a link follows the page's handle, and leaves the storefront while the page is hidden or gone.
* **Consequences:**
  * A page can show nothing that runs, even for staff or apps that can write pages, so the
    storefront and the checkout on its address stay as safe as the platform theme makes them.
    What may stay is a decision on security: a tag or attribute added to the list is reviewed as
    one.
  * Shops cannot embed maps, videos or forms in pages yet: those come as sections or blocks of
    the theme, whose markup is the platform's.
  * A page is shown or hidden now: publishing at a time set in advance waits for scheduled
    publishing (OS-03). Pages are in one language until translations come.
* **Alternatives:**
  * Bodies as text, as product descriptions are: no headings, lists, links or tables, which
    policies and contact pages need.
  * Keeping the body as sent and cleaning it on the storefront: every render would clean, and
    the API would show what the storefront does not.
  * A rich-text JSON document, as Shopify's rich text metafields: safe by construction, but
    nothing that writes pages today, Shopify's API included, sends it.

## ADR-046 · Storefront search asks the core, which finds products in Postgres as the admin's search does, until Typesense

* **Context:** every storefront needs search (SRC-01). Shoppers here type what they want, often
  in Roman Urdu spelled many ways ("kameez", "qameez", "kamiz"), rather than browse collections.
  Search is planned on Typesense, with typo tolerance, facets and synonyms
  ([ADR-013](#adr-013--typesense-for-search-with-app-level-urduroman-urdu-normalisation)), from
  V1. Until then, the only search index for products is the catalog's own `search_text`: title,
  vendor, type and tags, folded by `searchKey` (Roman Urdu spellings, Urdu script), which the
  admin's product search already matches. Storefronts read products as documents from Valkey
  ([ADR-036](#adr-036--one-publisher-per-shop-rebuilds-storefront-documents-from-the-database-its-writes-fenced-by-its-lock)),
  and ask the core, with a key of their own, for carts and checkouts
  ([ADR-042](#adr-042--carts-are-kept-by-the-core-and-priced-whenever-they-are-read-storefronts-change-them-with-a-key-of-their-own)).
* **Decision:**
  * **Storefronts ask the core** at `GET /storefront/shops/{shop}/search?q=`, with the storefront
    key. The core answers with the IDs of up to 250 of the shop's active products that have every
    word typed, best first. It finds them in `search_text` as the admin's search does, folding the
    words the same way, and reads the first 200 characters and 10 words. The answer is never
    cached (`no-store`).
  * **Best first is simple:** first the products whose search text has the first word earliest,
    which puts matches in titles before vendors, types and tags, then the newest.
  * **The storefront renders the search page from the IDs.** `/search?q=` (and `/ur/search`)
    renders the theme's `search` template with Shopify's `search` object: `performed`, `terms`,
    `results_count`, `results` (products, each with `object_type` `product`) and `types`.
    `{% paginate search.results by 24 %}` pages it, and its links keep `q`. The storefront reads
    only the page shown from the product documents, as it does for collections
    ([ADR-035](#adr-035--the-storefront-renders-liquid-with-limits-of-its-own-fetching-lists-a-chunk-at-a-time)).
  * **When Typesense comes, it answers the same request in the core.** Storefronts, themes and
    the API between them stay as they are.
* **Consequences:**
  * Every shop has search now, with Roman Urdu spellings and Urdu script, without another service
    to run.
  * Search has no typo tolerance beyond what folding gives, no filters or facets (SRC-03) and no
    synonyms, and finds products only: pages and articles join the results with Typesense.
    Predictive suggestions as a shopper types come next.
  * `LIKE '%word%'` can use no index, so every search reads all of a shop's products. Measured on
    a development machine with a warm cache, that took about 3 ms for a shop of 10,000 products
    and 25 to 30 ms for 100,000. A trigram index (`pg_trgm`) is the step to take before Typesense
    if shops outgrow that.
  * Every search is a request to the core, as a cart change is. When the core cannot answer, the
    search page says so with a 503, and the rest of the storefront works as before.
* **Alternatives:**
  * **Typesense now:** another service to run and keep in step with the catalog, before shops need
    what it adds.
  * **An index in the storefront, built from the documents in Valkey:** every storefront process
    would hold every shop's index, or Valkey would need a search module that managed Valkey may not
    offer.
  * **Postgres full-text search (`tsvector`):** it stems English words, and Roman Urdu is not
    English. The folded key already matches what the admin's search matches.

## ADR-047 · The edge keeps storefront pages by the handles they name before they stream, and forgets those whose documents change

* **Context:** storefront pages are the same for every shopper: the cart's count comes from a
  cookie and the drawer asks for its own section, so the edge can keep pages
  ([04 §2.2](./04-storefront-and-themes.md#22-cache-key-and-cacheability)), in front of an origin
  that may be 100 ms away from Pakistan. Pages stream: their head is written before their sections
  render ([ADR-035](#adr-035--the-storefront-renders-liquid-with-limits-of-its-own-fetching-lists-a-chunk-at-a-time)),
  so their headers go before the page knows every document it reads. The publisher rebuilds
  documents as events come
  ([ADR-036](#adr-036--one-publisher-per-shop-rebuilds-storefront-documents-from-the-database-its-writes-fenced-by-its-lock)),
  often to what was stored already: a sale rebuilds a product whose availability did not change,
  and most product edits rebuild the menus.
* **Decision:**
  * **Pages are kept five minutes**: `public, max-age=0, s-maxage=300`, then shown while fetched
    again for a day (`stale-while-revalidate`), and for a week while the storefront cannot answer
    (`stale-if-error`). Search results and suggestions are kept a minute. The cart, checkout, the
    Ajax cart and sections rendered with a shopper's cart are `private, no-store`, and so are
    refusals and errors. Theme assets, whose address names the theme's version, are kept a year.
  * **Pages are tagged** (`Cache-Tag`) with their shop's tag, and with the handles of the
    products, collections and pages they name before they render: the route's, found or not, and
    those the theme's, sections' and blocks' settings choose. Tagged by handle, a page at a handle
    nothing has yet is forgotten once something takes it.
  * **The publisher purges what changed**: it compares each document it writes with the one stored
    and purges the tags of those written differently or taken off, by their handles before and
    after. A product that changes also purges the collections that hold it and
    `/collections/all`, whose pages show its card. A changed shop document (settings, delivery,
    theme) or menus purge the shop's tag, which every page has. It purges after writing, outside
    the database transaction; a purge that fails is logged, not retried.
  * **The edge is Cloudflare** ([ADR-007](#adr-007--cloudflare-as-the-edge)),
    purged by tag through its API with the worker's `CLOUDFLARE_ZONE_ID` and
    `CLOUDFLARE_API_TOKEN`; without them nothing is purged, as in development.
* **Consequences:**
  * A page costs the origin nothing while what it shows stays as it was, and a sale that leaves a
    product for sale purges nothing.
  * What a page shows without naming it before it renders is kept up to five minutes: a
    product's card on a search page, or in a section that finds products some other way.
  * A render that read a document just before the publisher replaced it can put the old page back
    after the purge, for up to five minutes. A second purge a few seconds later closes that if it
    matters.
  * In a drop, stock running out purges the product's page and listings each time a product sells
    out; if purges reach Cloudflare's rate limits, gathering them for a second or two comes next.
* **Alternatives:**
  * **Tagging every document a page reads:** only known once the page is rendered, so its
    headers would wait for its last section, giving up the head first.
  * **Purging the whole shop on any change:** a busy shop's sales would empty its pages every few
    seconds.
  * **Short lives without purges:** a new price would show late on the product page itself.
  * **Purging by address:** needs a record of the addresses each document is shown at.

## ADR-048 · A shop's own domains are the online store's, one shop's each, served once DNS points them at the platform, the primary one where pages send shoppers

* **Context:** every shop answers at its handle's subdomain
  ([ADR-037](#adr-037--every-shop-has-a-handle-naming-its-storefront-on-the-platforms-domain-storefronts-find-shops-through-a-directory-in-valkey)).
  Shops want their own domains too (ONB-07): www.zarifashions.pk, where shoppers and links go. The
  architecture puts Cloudflare for SaaS custom hostnames at the edge, with certificates issued
  as domains are added, and a lookup of each host's shop and primary domain
  ([04 §2.1](./04-storefront-and-themes.md#21-hostname-routing)). The control plane is to own
  what spans shops; until it exists, the application database stands in for it.
* **Decision:**
  * **The online store keeps a shop's domains** (`online_store.domains`): each host as DNS has it,
    lowercase with internationalised names in their `xn--` form, one shop's across the platform
    by an index that sees every shop's rows; when DNS last pointed it at the platform; and
    whether it is primary. A shop connects ten at most, and never the platform's domain, its
    subdomains or the DNS target. `read_domains` and `write_domains` are owners' and managers',
    as the online store is ([design 02 §6](../design/02-information-architecture.md#6-permissions--navigation-matrix-presets)).
  * **A domain is pointed at the platform, and checked when the shop asks.** `domainCreate`
    connects it and names the DNS target, `STOREFRONT_DNS_TARGET` or shops.{storefront domain}:
    a CNAME record naming it, or at an apex, one the DNS provider flattens to its addresses.
    `domainVerify` asks DNS then, outside the database transaction: a CNAME naming the target, or
    addresses all among the target's, verifies it; otherwise `NOT_POINTED` says what DNS
    answered. A verified domain stays verified.
  * **One domain is primary**, and must be verified to be: making another primary makes the one
    before stop being. The storefront sends shoppers there, and the Admin API's `shop.url` names
    it; without one, the handle's subdomain is.
  * **The storefront answers at verified domains**: `domain.*` events rebuild the shop, whose
    document names its verified domains and its primary one, and the directory maps each of them
    to the shop, beside its handle. A page asked for at another of the shop's addresses is sent on
    to the same path at the primary domain, with a 301. Forms, scripts, cart changes and
    checkouts answer where they are asked, so a shopper's cart stays on the host it began on.
* **Consequences:**
  * A shop can use its own domain now, wherever it points at the storefront directly;
    certificates and the edge's routing come with Cloudflare for SaaS and the infrastructure.
  * Nothing checks a domain again: one that stops pointing at the platform stays connected until
    it is let go.
  * Carts are kept per host: a cart begun at the handle's subdomain before a domain became
    primary stays there.
  * A request naming a shop's domain in its `Host` reaches the shop wherever it is sent from, as
    with any host-routed service; the edge will answer only for hosts it has certificates for.
* **Alternatives:**
  * **Domains in the control plane:** where they belong at scale, with the edge's copy of the
    directory; the online store keeps them until that service exists.
  * **Verifying by a TXT record:** proves control of the domain's DNS, but the storefront needs
    the CNAME to be reached anyway; checking the CNAME proves both.
  * **Checking domains in the background, over and over:** a job to run and states to show; asked
    when the shop asks is enough to begin with.

## ADR-049 · A theme is previewed through a link the core seals, which storefronts keep in a cookie and render from the core's files, never kept

* **Context:** a shop prepares a theme before publishing it
  ([ADR-039](#adr-039--a-shops-theme-is-a-platform-theme-with-the-shops-own-json-files-over-it)),
  an Eid look, say, and wants to see it on its storefront before shoppers do, and to send it to
  a partner or a designer for a second opinion. The editor (OS-02) shows its preview the same
  way, in a frame of the storefront ([04 §3.4](./04-storefront-and-themes.md#34-theme-editor-no-code)).
  Storefronts have only main themes, which the worker publishes to Valkey.
* **Decision:**
  * **A theme's preview is a link:** `OnlineStoreTheme.previewUrl` (`read_themes`) is the shop's
    storefront at its handle's subdomain with `?preview=` and a token naming the theme and when
    the link ends, 14 days on, as Shopify's do. The token is sealed with the core's secret box,
    bound to the shop, so nothing is stored, and the keys rotate as the box's do.
  * **The storefront keeps it in a cookie**, `hatti_preview`, `HttpOnly` and `SameSite=Lax`, until
    the link ends, so every page, section, search and cart page shown on that host after it shows
    the theme, whatever links, forms or scripts lead there. A bar at the foot of each page, in its
    language, names the theme and ends the preview; `?preview=` with nothing ends it too.
  * **The storefront hands the token back to the core** for the theme, on each previewed request
    (`GET /storefront/shops/{shop}/theme-preview`, the token in `x-hatti-preview`, with the
    storefront key). The core opens it for the shop the host names, and gives the theme's files
    as saved at that moment, so a change shows on the next page, before the worker would publish
    it. The storefront lays them over the platform theme once per version, beside main themes.
    A token of another shop's, an ended link or a deleted theme gives nothing, and its cookie goes.
  * **Previewed answers are the shopper's own:** `private, no-store`, without cache tags, and
    `noindex`; they are not sent on to the shop's primary domain; and the edge is to pass requests
    with the cookie or the parameter to the storefront. Any answer that sets a cookie is kept by
    no one, whatever its route says.
* **Consequences:**
  * A previewed page costs a round trip to the core; pages without a preview cost nothing more.
  * A preview shows the files as saved. Settings the editor has not saved are the next step: the
    editor's protocol.
  * A link cannot be taken back short of deleting its theme or rotating the keys: anyone who has
    it sees the theme until it ends, which shows no more than a look.
  * A preview is per host: one opened at the shop's subdomain does not follow to its own domain.
  * Someone who opened a preview sees it on that host until it ends or they end it, as on
    Shopify, with the bar saying so.
* **Alternatives:**
  * **Every theme published to Valkey:** no round trip to the core, but a save would show only once
    the worker had published it, while the editor needs the save it just made.
  * **Tokens kept in the database:** they could be taken back one at a time, but it takes a table
    and a lookup for a link that shows only a look.
  * **The token in every link rather than a cookie:** forms, scripts and the cart's answers lose it,
    so a preview would fall back to the main theme a click later.

## ADR-050 · The theme editor talks to its preview through postMessage: a framed preview is in design mode, and renders sections with the editor's unsaved files

* **Context:** the editor (OS-02) is to show the theme it edits in a frame of the storefront, as
  Shopify's does ([04 §3.4](./04-storefront-and-themes.md#34-theme-editor-no-code)): the merchant
  chooses a section or block, in the editor or by tapping it in the page, changes its settings,
  and sees them before saving; and themes' scripts need to know when their sections are chosen or
  rendered again. Previews exist ([ADR-049](#adr-049--a-theme-is-previewed-through-a-link-the-core-seals-which-storefronts-keep-in-a-cookie-and-render-from-the-cores-files-never-kept)); the admin app the editor will be part of does not yet.
* **Decision:**
  * **A preview the editor frames is in design mode.** A previewed request the browser says is
    for a frame (`Sec-Fetch-Dest: iframe`), with the editor's origins configured
    (`STOREFRONT_EDITOR_ORIGINS`), renders with Liquid's `request.design_mode` true; each
    section's wrapper names its ID, type and where its settings are kept, the page's template, a
    section group, or `config/settings_data.json` for a static section; and blocks'
    `shopify_attributes` give their ID and type, as Shopify's do. The page carries the editor's
    script in place of the preview's bar. Previewed answers may be framed by those origins alone
    (`Content-Security-Policy: frame-ancestors`). Design mode follows the frame through links and
    forms, since every page opened in it is framed; there the preview's cookie is the frame's own
    (`SameSite=None; Secure; Partitioned`), so it holds even when the editor is another site.
  * **The script and the editor talk through `postMessage`**, the script hearing the editor's
    origins alone: the editor says hello each time the frame loads and learns the page's path,
    locale and template and its sections with their blocks; it chooses a section or block, which
    the script scrolls to and tells the theme's scripts of; a tap in the page, other than on a link
    or control, chooses too and tells the editor; and the editor asks for sections to be rendered
    again with the theme's files it has not saved.
  * **Unsaved files render through `POST /editor/sections`**, for the script alone (a preview, its
    header, from the page itself): the page's sections in design mode, with the unsaved files over
    the previewed theme as saved. What the storefront cannot use of them is said, and the saved
    file stands; nothing is kept. The script swaps the sections in and keeps them chosen.
  * **Themes hear Shopify's theme editor events**, `shopify:section:load`, `unload`, `select`
    and `deselect`, and `shopify:block:select` and `deselect`, with Shopify's `detail`, and see
    `Shopify.designMode`, so a theme written for Shopify's editor works in Hatti's. Hatti Base's
    cart drawer opens while chosen, and lets go of the page's listeners when rendered again.
* **Consequences:**
  * The editor needs only the Admin API and the storefront: a theme's `previewUrl` in a frame,
    these messages, and `themeFilesUpsert` to save.
  * Design mode needs Fetch Metadata, which browsers send over HTTPS and to `localhost`: in
    development, the editor and storefronts are tried on `*.localhost` hosts.
  * Sections render again one at a time: adding, removing or moving sections, and settings the
    layout reads, such as colours, show once saved and the frame reloaded. Themes' own requests,
    such as the drawer's, are not in design mode.
  * Each render of unsaved files asks the core for the preview once, and renders the sections.
* **Alternatives:**
  * **Design mode in the page's address**, kept by the script through links and forms: it works
    over plain HTTP, but forms that post, and redirects, lose it, and the script would rewrite the
    page's links.
  * **Unsaved files kept as drafts in the core**, which the preview reads: they would show after a
    link too, but each change would be a write and a round trip before it showed, and drafts would
    need storing and merging with saves.
  * **Events of Hatti's own**: nothing written for Shopify's editor would hear them.

## ADR-051 · Search engines and link previews are told each page's address at the shop's own, in each language, and find pages through sitemaps of the storefront's documents

* **Context:** a shop's pages answer at its handle's subdomain and at its own domains, the primary
  one where pages send shoppers ([ADR-048](#adr-048--a-shops-own-domains-are-the-online-stores-one-shops-each-served-once-dns-points-them-at-the-platform-the-primary-one-where-pages-send-shoppers)), and in English and Urdu. Search engines should rank one
  address for each page, and find every product; link previews, WhatsApp's above all, need a
  title, a description and an image at an address they can fetch (OS-09,
  [04 §6](./04-storefront-and-themes.md#6-seo--discoverability)).
* **Decision:**
  * **Every page has one address, at the shop's own:** Liquid's `shop.url` is the shop's primary
    domain, else its handle's subdomain, with the platform's scheme and port, and `canonical_url`
    is the page's path there, in its language (`/ur/…` in Urdu), keeping only `page` past the
    first. Hatti Base links it as canonical, and its link-preview tags use it, with the image at
    the shop's address.
  * **The storefront adds the page's address in each of the theme's languages** to the head, as
    Shopify does, `x-default` the default language's: for pages that are found, and not previews
    or the editor's.
  * **Sitemaps come from the storefront's documents:** `/sitemap.xml` indexes
    `/sitemaps/{products|collections|pages}-{n}.xml`, 5,000 addresses each, from the handles the
    storefront shows, each with its address in every language, the home page first among the
    pages'. `robots.txt` keeps crawlers from carts, checkouts, searches, the editor's routes,
    previews, other sort orders and sections alone, and names the sitemap at the shop's address.
    Both are kept at the edge for an hour, and forgotten with the shop's document ([ADR-047](#adr-047--the-edge-keeps-storefront-pages-by-the-handles-they-name-before-they-stream-and-forgets-those-whose-documents-change)).
  * **Products carry structured data**: Shopify's `structured_data` filter gives schema.org's
    `Product`, with an `Offer` for each variant in rupees and whether it can be bought, and its
    images, at the shop's address. Liquid's `json` escapes `<`, `>` and `&`, as the structured
    data does, so what a shop writes cannot end a script.
* **Consequences:**
  * A shop that makes a domain primary is ranked there: its pages' canonical addresses move with
    it, and the handle's subdomain sends its pages on.
  * A new product is in the sitemap within an hour; sitemaps have no `lastmod` and no images, and
    robots.txt cannot be edited yet.
  * Sitemaps answer at each of the shop's hosts, and list the canonical addresses.
* **Alternatives:**
  * **Sitemaps from the core's database:** always current, but a round trip to the core for each
    crawl, where the documents already hold what the storefront shows.
  * **Shopify's sitemap names** (`sitemap_products_1.xml?from=…`): only the index is ever submitted,
    and a fixed prefix routes apart from pages.
  * **The address asked for as canonical:** a page answering at a subdomain and a domain would
    split its ranking between them.
