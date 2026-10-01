# 13 · Architecture Decision Log

> **Status:** Living document · **Last updated:** 2026-10-01 (ADR-033 to ADR-117 added)
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
| 021 | PgBouncer transaction pooling with no session state | Accepted (named prepared statements: see ADR-108) |
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
| 052 | A shop's URL redirects are the online store's, and the storefront follows one only where it has no page | Accepted |
| 053 | A handle change asks for its redirect, as Shopify's redirectNewHandle does, and the redirect leads to where the page is now | Accepted |
| 054 | A shop's storefront can be closed behind a password, which the storefront checks against a verifier in the shop's document | Accepted |
| 055 | A shop adds rules to its robots.txt as lines crawlers read, checked when saved, never Liquid | Accepted |
| 056 | A shop's policies are kept as Shopify keeps them, shown in Shopify's markup, and drafted from what the shop has set, never saved by themselves | Accepted |
| 057 | What a shopper agrees to in placing an order is kept with it: the versions of the shop's policies its checkout linked, and where it was placed from | Accepted |
| 058 | No order collects more cash on delivery than the law allows, whoever places it: the rest is paid in advance, or the order is not placed | Accepted |
| 059 | A Shopify product export is imported product by product, as productCreate makes them, keeping their handles; the core sets the stock | Accepted |
| 060 | COD health follows a period's cash-on-delivery orders, worked out from them when asked, its rates of those that turned out | Accepted |
| 061 | Sales are reported in Shopify's terms, from the orders when asked: an order counts on the day it was placed, cancelled ones aside, and so do its items that came back | Accepted |
| 062 | Discount codes are the pricing module's: a percentage or an amount off an order's items, or free delivery, matched in any letter case | Accepted |
| 063 | A shopper's discount code is kept with their cart and counted with the order placed with it, in the order's transaction | Accepted |
| 064 | Discount links keep their code with the shopper's cart, one begun for it if need be, and a cart says of a code only whether it applies | Accepted |
| 065 | A cart permalink begins a cart of its own and goes to its checkout, leaving the shopper's cart as it is | Accepted |
| 066 | What couriers owe is worked out from the orders when asked: delivered cash-on-delivery orders not yet paid, by courier and by days since delivery | Accepted |
| 067 | Couriers' remittance statements are imported whole into a logistics module, each line's cash received on its parcel's order, at most what the order owes, and a parcel's cash once | Accepted |
| 068 | A cash-on-delivery customer may cancel through the order's link until it is packed, though they confirmed it, unless the shop keeps that to before confirming | Accepted |
| 069 | The checkout's page takes the shop's accent colour from its published theme, on its buttons, and on its links where they stay readable | Accepted |
| 070 | An address keeps its area in its second line and its landmark in a field of its own; checkout and customers' links ask for each, suggesting the areas of the larger cities | Accepted |
| 071 | A parcel coming back is checked in by the tracking number on its label, matched as couriers' statements are; those on their way back are listed the longest first | Accepted |
| 072 | A parcel the courier lost is written off, and an order with nothing delivered or back ends at a stage of its own; lost before reaching the customer, it is never their refusal | Accepted |
| 073 | The Confirmation Desk deals orders waiting for their customers to agents one at a time, the most urgent due first, and keeps the calls that did not settle them | Accepted |
| 074 | A shop that gives its bank account offers bank transfer: the order waits for the money at a stage of its own, and keeps the account its customer was told to pay into | Accepted |
| 075 | A shop keeps cash on delivery to the orders it trusts: up to a total of its own, outside cities it names, and not for customers who refused parcels before; checkout offers transfer instead | Accepted |
| 076 | A shop's fee for cash on delivery is the order's own amount, apart from delivery: in its total and the cash collected, said beside the option where the shopper chooses | Accepted |
| 077 | Something off for paying by transfer is part of the order's discount, kept apart from the codes': off the items after any code, to the rupee, said where the shopper chooses | Accepted |
| 078 | A shop keeps cash on delivery from products by their tags: a cart holding one is offered bank transfer alone, the page naming the product | Accepted |
| 079 | Files are kept in object storage under each shop's prefix, uploaded straight there through URLs the Admin API signs, and shown only through short-lived signed URLs; a directory stands in for R2 in development | Accepted |
| 080 | A customer sends the receipt of their transfer through their order's page, in a form the core reads and keeps in storage by order; the shop sees it with the order | Accepted |
| 081 | A shop's logo is one of its files, chosen as its brand's; the checkout's page shows it in place of the shop's name, through a URL signed for an hour that the page's policy allows alone | Accepted |
| 082 | A shop's account takes its Raast ID beside its IBAN, kept with each order as the account is, and shown on its customers' pages to copy; a Raast QR waits for the partner's | Accepted |
| 083 | A cash-on-delivery order may ask for an advance, paid by transfer before it ships: it waits for it as a transfer waits for its money, and staff record it when it is in | Accepted |
| 084 | Checkout asks for the advance the shop's rules name: an amount, a share of the items or the delivery charge, on every order or above a total, said beside cash on delivery | Accepted |
| 085 | A draft may ask for an advance as an order does; once its customer confirms it, the draft's link shows where to pay and takes the receipt | Accepted |
| 086 | A shop chooses trust badges for its checkout from the platform's set, worded in English and Urdu and shown under the button where they hold | Accepted |
| 087 | Checkout takes at most three orders a day from one mobile number and twenty an hour from one internet address, counting the orders it placed, one at a time | Accepted |
| 088 | A parcel keeps what couriers' statements charged for it, which COD health adds up for those that came back; a statement with the lines of one imported before is refused | Accepted |
| 089 | A shop's advance may be asked only to cities it names and of customers who refused parcels before: checkout names every city and says of whom, and placing applies them to the city and number typed | Accepted |
| 090 | Agents' performance is worked out when asked from the calls the desk keeps and the confirmations and cancellations on orders' timelines, by who made them, with how the orders each agent confirmed turned out | Accepted |
| 091 | A shop's Confirmation Desk keeps calling hours, outside which it deals out no order and after which an unanswered one falls due; an order waiting longer for its first call than the shop's target, counting those hours, is overdue | Accepted |
| 092 | An order whose customer could not be reached is cancelled as many days after it was placed as the shop says, by a sweep in the worker, shop by shop and order by order | Accepted |
| 093 | A claim on the courier that lost a parcel is the parcel's, followed until the courier pays it or refuses it; a statement's cash for a lost parcel pays its claim, filed or not | Accepted |
| 094 | A shop's advance may be asked only of customers new to it, and of orders its risk rules score high: such an order is asked it instead of waiting for review | Accepted |
| 095 | The setup checklist is worked out when asked from what each module keeps, in one transaction: a step is done while what it asks for holds | Accepted |
| 096 | Sales tax is included in prices, at a rate the tax module keeps: each order keeps the tax in it as it was placed, line by line and in its delivery | Accepted |
| 097 | Tax categories are the shop's codes with rates of their own, which variants name by Shopify's tax code; every other variant it taxes is at the shop's rate | Accepted |
| 098 | A parcel that came back with items written off as damaged is claimed from its courier for their worth, as a lost parcel is for its own; every claim is listed, the oldest first, to follow up | Accepted |
| 099 | An order paid on delivery that the shop's risk rules score at its limit or above is not taken at checkout: placed, scored and undone, its page asks for a transfer instead | Accepted |
| 100 | Staff sign in with a passkey alone, which passes the second factor, or answer the second step after their password with one; once an account has a second factor, only a session that passed one adds another | Accepted |
| 101 | Owners and managers invite staff by a link they send themselves, accepted once by a signed-in account; the owner manages every role but its own, managers those below them, apps none | Accepted |
| 102 | A customer's own data is one JSON file of everything the shop keeps of them, which each module with their data adds to; the blocklist and risk scores stay out | Accepted |
| 103 | Sensitive actions need staff to have proved who they are in the last 15 minutes, by signing in or confirming with the strongest factor their account has; apps are not asked | Accepted |
| 104 | The owner hands the shop to one of its managers who has a second factor, and stays on as a manager; the shop has one owner throughout | Accepted |
| 105 | A refund keeps its share of its order's sales tax: the order's tax in all it has refunded, less what the refunds before it gave back; the sales report adds up the tax its sales include | Accepted |
| 106 | A draft says the sales tax its prices include: an open one's at the shop's rates now, as placing it would work it out; a completed one's as its order keeps it | Accepted |
| 107 | A tenant transaction begins with its shop and limits set, in one round trip: begin and set_config sent as one simple query, the values written in once checked | Accepted |
| 108 | Hot queries run as statements prepared by name, planned once per connection; every pooler in front of the application sets max_prepared_statements | Accepted |
| 109 | A customer's other numbers travel in a CSV column of their own: after the main number in exports, and in imports a new customer's or, on overwrite, in place of an existing one's | Accepted |
| 110 | A customer's erasure can be asked for ten days ahead, and cancelled until then; the worker's sweep carries it out as the system, naming who asked | Accepted |
| 111 | Orders and carts are read through prepared statements too, each checked by the benchmark against shops of every size; a prepared page writes its size into its text | Accepted |
| 112 | An order waiting to be confirmed is scored again when its customer's history changes, by the worker; a score that makes it risky holds it, and a held order stays held | Accepted |
| 113 | An erased customer's receipts leave storage too: the erasure records each order's receipt files in an event, and the worker removes them once it commits | Accepted |
| 114 | A draft its customer confirms through its link keeps what they agreed to, as checkout's orders do: the page names the shop's policies above its button, and the order keeps their versions and where it was confirmed from | Accepted |
| 115 | An order staff or an app placed keeps what its customer agreed to in confirming it through its link: the page names the shop's policies, and the order keeps their versions, where it was confirmed from and when | Accepted |
| 116 | The Admin API lists the erasures waiting, the soonest due first, with their customers; who asked stays in the audit log | Accepted |
| 117 | The sales report leaves out the sales tax its amounts include, as Shopify's does: worked out from the tax each order keeps, the tax said apart and added back in total sales | Accepted |

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

## ADR-052 · A shop's URL redirects are the online store's, and the storefront follows one only where it has no page

* **Context:** a shop moving to Hatti brings links to its old addresses with it: in search
  engines' results, WhatsApp chats, Instagram bios and ads. Shopify keeps a shop's URL redirects,
  and migration tools write them through its Admin API's `urlRedirect` mutations; a shop that
  moves without them loses its ranking and its customers' links (OS-09, ONB-05,
  [04 §6](./04-storefront-and-themes.md#6-seo--discoverability)).
* **Decision:**
  * **The online store keeps them, managed as Shopify's are:** `urlRedirects`, `urlRedirect`,
    `urlRedirectCreate`, `urlRedirectUpdate` and `urlRedirectDelete` in the Admin API, with the
    navigation scopes. Each change records `url_redirect.created`, `.updated` or `.deleted`. A
    shop keeps at most 20,000.
  * **A path is kept as the storefront compares addresses:** taken from a path or a whole address
    pasted in, without its query, fragment, trailing slash or `/ur`, decoded and lowercase; one
    redirect a path, and never the home page. A redirect sends both languages' pages on. Its
    target is a path on the shop, which may have a query, or an http(s) address; one that would
    send shoppers back to its own path is refused.
  * **The storefront follows one only where it would answer 404:** once it knows nothing is at a
    page's path, it looks the path up, in one round trip, and sends a 301 to the target: in the
    shopper's language when the target is on the shop, and with the query the page was asked
    with when the target has none, as a campaign's link has, but for a preview's token. A redirect never hides a page, so a
    product that takes an old address is shown there. A preview follows redirects, kept by no
    one; the theme editor's frame shows the 404 page, to change it.
  * **The publisher writes a shop's redirects to Valkey as a hash of targets by path**, from all
    of the shop's on any change, writing only what differs from the hash, 500 at a time: a
    migration's burst of changes is written once, a shop with thousands never holds Valkey up,
    and a hash that missed a change is put right by the next. The edge keeps 404 pages and
    redirects tagged with their path's tag, a hash of it: a change forgets what was answered at
    the paths it touched, or all the shop's pages past 25 paths, in one call
    ([ADR-047](#adr-047--the-edge-keeps-storefront-pages-by-the-handles-they-name-before-they-stream-and-forgets-those-whose-documents-change)).
* **Consequences:**
  * A shop moves its links with it: its old addresses can be written before its domain points at
    the platform.
  * A path with a query cannot be sent on apart from the path; a chain of redirects is followed a
    hop at a time, and a loop is the shop's to fix, as on Shopify.
  * A handle changed leaves no redirect behind yet.
  * Documents are version 7: each shop's are published whole once more.
* **Alternatives:**
  * **Looking the redirect up before rendering:** a round trip for every page, where only pages
    not found need it, and a redirect could hide a page.
  * **Writing each event's path and target alone:** less to write, but a changed path leaves its
    old one behind unless the event names both, and a missed event stays wrong until the shop is
    built again.
  * **The edge's own redirect rules** (Cloudflare's bulk redirects): answered before the
    storefront, but limited per account, and they would send on addresses that have pages.

## ADR-053 · A handle change asks for its redirect, as Shopify's redirectNewHandle does, and the redirect leads to where the page is now

* **Context:** a product renamed for a new season, `lawn-suit` to `lawn-suit-2026`, leaves its old
  address answering 404: in search results, WhatsApp chats and ads, where most of a shop's
  shoppers start. Shopify's admin offers a box, ticked, that redirects the old address, and its
  API takes `redirectNewHandle`; shops' URL redirects
  ([ADR-052](#adr-052--a-shops-url-redirects-are-the-online-stores-and-the-storefront-follows-one-only-where-it-has-no-page))
  can hold them.
* **Decision:**
  * **`productUpdate`, `collectionUpdate` and `pageUpdate` take `redirectNewHandle`**, false
    unless given, as Shopify's API does; the admin's screens will tick it by default, as Shopify's
    do. It needs only the change's own scope.
  * **A page's redirect is written with the change**, in its transaction. **A product's or
    collection's is written by the worker**: the catalog knows nothing of the online store, so
    `product.updated` and `collection.updated` name the old handle, and say whether the change
    asked. The worker writes the redirect to the handle the product or collection has when it
    runs, not the one the event names, so events handled late or out of order still send every
    old address to the current one; one deleted since gets none.
  * **A redirect written moves the others with it:** those that sent shoppers to the old address,
    with a query or a fragment or without, send them to the new one, so none goes the long way
    round; and a redirect from the new address goes, since the page is there now. A page back at
    an old address frees it.
  * **A shop with all the redirects it may keep gets none more**: the change stands, and the
    worker logs it.
* **Consequences:**
  * A renamed product's old links work again a moment after the change: the worker writes the
    redirect, then the publisher sends it to the storefront.
  * API clients must ask, as on Shopify: an importer that renames handles leaves no redirects.
  * Handles changed before this, or without asking, leave none, though the shop can add one.
* **Alternatives:**
  * **Always redirecting:** nothing to ask, but a client copying a catalog in would leave
    redirects nobody wanted, where Shopify's API leaves none.
  * **The catalog writing the redirect in its own transaction:** at once, but the catalog would
    write the online store's tables, or the two modules would depend on each other.
  * **The redirect to the new handle the event names:** two renames handled out of order could
    send the first address to the middle one, or drop the redirect a rename back needs.

## ADR-054 · A shop's storefront can be closed behind a password, which the storefront checks against a verifier in the shop's document

* **Context:** a new shop is built for days or weeks before it opens, its products, theme and
  delivery charges; meanwhile its storefront should show neither shoppers nor search engines half
  a shop, and a shop may close for a while, for a stock-take or before a drop. Shopify keeps a new
  store behind a password until it opens, on a password page from the theme's `password`
  template (OS-15).
* **Decision:**
  * **The online store keeps the password with the shop's preferences**
    ([ADR-041](#adr-041--what-a-shop-sets-for-its-storefront-as-a-whole-is-the-online-stores-starting-with-its-whatsapp-number)):
    whether the storefront is closed; the password, sealed with the platform's secret box so its
    staff can see it again, as Shopify shows it; a verifier of it; and what the password page
    tells shoppers. `onlineStorePreferencesUpdate` sets them, under the settings scopes. A
    password can be changed, never taken away, and closing needs one.
  * **The shop's document carries the verifier and the message, never the password:** scrypt
    with a salt of its own (`@hatti/crypto`), some 50 ms a check, and the message as HTML made
    from the text.
  * **The storefront sends shoppers without a pass to `/password`** (`/ur/password` in Urdu), the
    theme's `password` template, as Shopify's does; scripts and sections are told 401, and
    robots.txt disallows everything. The password page, theme assets and robots.txt stay open. The
    password is taken at `/password`, ten tries a minute from an address; the right one leaves a
    pass in a cookie (`storefront_digest`) for a month: an HMAC of the shop by the verifier, so a
    new password asks everyone again.
  * **Nothing of a closed shop is kept at the edge**, even for shoppers with the pass, since the
    edge keys on the address alone: every answer is `private, no-store` and `noindex`. Closing
    and opening change the shop's document, so the publisher purges its pages
    ([ADR-047](#adr-047--the-edge-keeps-storefront-pages-by-the-handles-they-name-before-they-stream-and-forgets-those-whose-documents-change)).
  * **Its staff see it as it will be through a preview**
    ([ADR-049](#adr-049--a-theme-is-previewed-through-a-link-the-core-seals-which-storefronts-keep-in-a-cookie-and-render-from-the-cores-files-never-kept)),
    the password page too, to design it.
* **Consequences:**
  * Every page of a closed shop is rendered for its visitor, as a preview is; closed shops have
    few visitors.
  * The password is shared, not a person's: whoever has it sees the shop, for a month or until it
    changes.
  * Nothing can be ordered from a closed shop but through its staff: carts and checkout are closed
    too.
  * New shops are open until their staff close them; the control plane will close them at sign-up.
* **Alternatives:**
  * **The core checking passwords for the storefront:** no verifier in Valkey, but a round trip
    to the core for each try, and passes signed with a key both would share.
  * **Keeping the password page at the edge, and the rest private:** the edge cannot tell a
    shopper with a pass from one without.
  * **A password for each person:** that is the admin's sign-in, not a storefront's; Shopify's is
    shared too.

## ADR-055 · A shop adds rules to its robots.txt as lines crawlers read, checked when saved, never Liquid

* **Context:** the storefront's robots.txt keeps crawlers from carts, checkouts, searches and
  the like ([ADR-051](#adr-051--search-engines-and-link-previews-are-told-each-pages-address-at-the-shops-own-in-each-language-and-find-pages-through-sitemaps-of-the-storefronts-documents)),
  but a shop may want more: a collection kept out of search results until it launches, an AI
  crawler shut out, a sitemap of its own. Shopify lets a theme's `robots.txt.liquid` change the
  file; Hatti's shops keep no Liquid of their own (OS-09).
* **Decision:**
  * **The rules are a preference of the shop's**
    ([ADR-041](#adr-041--what-a-shop-sets-for-its-storefront-as-a-whole-is-the-online-stores-starting-with-its-whatsapp-number)),
    `robotsTxtRules`, set through `onlineStorePreferencesUpdate`: lines of `User-agent`,
    `Allow`, `Disallow`, `Crawl-delay` or `Sitemap`, comments and blank lines, 200 at most.
  * **Each line is checked when saved**, as crawlers would read it: a directive they know, in its
    usual case, with a value of its kind, a crawler's name, a path pattern, a number or a web
    address. Lines that are not are said, by their number, and nothing is saved.
  * **The storefront serves them after the platform's rules:** those before any `User-agent` of
    the shop's own join the platform's `User-agent: *` group, so a shop can let crawlers into a
    path the platform keeps them from, or keep them from more; its groups come after; its
    sitemaps join the platform's at the end. A closed shop's robots.txt shuts everything out
    still ([ADR-054](#adr-054--a-shops-storefront-can-be-closed-behind-a-password-which-the-storefront-checks-against-a-verifier-in-the-shops-document)).
* **Consequences:**
  * A shop cannot remove the platform's rules, only add to them, or allow a path in its own group.
  * Rules reach the storefront with the shop's document, and the edge forgets robots.txt with it.
* **Alternatives:**
  * **A `robots.txt.liquid` of the shop's own**, as Shopify's: full control, but Liquid from shops
    is what Hatti keeps out ([ADR-039](#adr-039--a-shops-theme-is-a-platform-theme-with-the-shops-own-json-files-over-it)), and a mistake would
    shut crawlers out of the whole shop.
  * **Rules as data, a path and whether it is allowed:** simpler to check, but no groups for
    other crawlers, and not what SEO tools and guides write.

## ADR-056 · A shop's policies are kept as Shopify keeps them, shown in Shopify's markup, and drafted from what the shop has set, never saved by themselves

* **Context:** a shop needs a returns policy, a privacy policy, terms and a shipping policy before
  it sells: shoppers read them before paying cash to a courier, payment gateways ask for them,
  and most Pakistani shops have none written. Shopify keeps five, shows them at `/policies/…`
  and links them from themes' footers, and drafts them from templates; its API has
  `shop.shopPolicies` and `shopPolicyUpdate` (ONB-09).
* **Decision:**
  * **The online store keeps them as Shopify does:** refund, privacy, terms of service, shipping
    and contact information, one of each, HTML cleaned when saved as pages' bodies are
    ([ADR-045](#adr-045--a-shops-pages-keep-html-cleaned-of-anything-that-runs-when-saved-the-storefront-shows-it-as-it-is)); a
    blank body takes one away. `shop { shopPolicies }` and `shopPolicyUpdate` follow Shopify's,
    under new `read_legal_policies` and `write_legal_policies` scopes, owners' and managers'.
  * **Drafts are written from what the shop has set** (`shopPolicyDraft`): its name, address,
    WhatsApp number and delivery charges, in English or Urdu, for Pakistan: cash on delivery,
    refunds by bank transfer, Easypaisa or JazzCash, couriers, the law of Pakistan. A draft is
    returned, never saved: the shop reads it, changes it and saves it with `shopPolicyUpdate`.
    It is not legal advice, and says as much in the API.
  * **The storefront shows them in Shopify's markup** (`.shopify-policy__container`), inside the
    theme's layout, at `/policies/refund-policy` and the rest, and in Urdu at `/ur/policies/…`,
    as Shopify does: themes need no template for them. Liquid's `shop.policies`, and
    `shop.refund_policy` and the rest, give their titles and addresses in the page's language;
    Hatti Base's footer links them. The shop's document lists the policies it has; their bodies
    are kept apart, fetched for their own pages only, and a change forgets the shop's pages
    ([ADR-047](#adr-047--the-edge-keeps-storefront-pages-by-the-handles-they-name-before-they-stream-and-forgets-those-whose-documents-change)).
  * **Checkout links them**, as Shopify's does: the foot of its page, and of its thank-you page,
    lists those the shop has, in English and Urdu as the rest of the page, each opening in a new
    tab. Shopify shows them in a dialog over the checkout; the page runs no scripts
    ([ADR-044](#adr-044--checkout-is-one-page-the-core-renders-and-storefronts-serve-on-the-shops-address-placing-a-cash-on-delivery-order-as-the-page-showed-it)),
    and a shopper who left it could come back to an empty form.
* **Consequences:**
  * A new shop has no policies until it saves some, as on Shopify; the admin's onboarding will
    offer the drafts.
  * A draft's promises are the shop's to keep: 7 days to return, refunds within 7 working days,
    delivery times, until it changes them.
  * A policy is in one language, the one the shop wrote it in, whichever language the page is.
* **Alternatives:**
  * **Policies as pages:** no new table, but no fixed addresses for themes and checkouts to link,
    and no Shopify API to import them through.
  * **Saving drafts at sign-up:** every shop would publish promises it never read.
  * **Policies in the shop's document:** one fetch fewer on their pages, but every page would
    fetch every policy's body.

## ADR-057 · What a shopper agrees to in placing an order is kept with it: the versions of the shop's policies its checkout linked, and where it was placed from

* **Context:** Pakistan's Electronic Transactions Ordinance 2002 lets contracts made online stand,
  and the provinces' consumer protection laws hold shops to what they told shoppers. When a
  shopper disputes an order, a refused parcel's charges or a return after the window, the shop
  has to show what they agreed to, when, and from where: the clickwrap log that
  [11 §8](./11-security-and-compliance.md#8-compliance-map) lists, and TAX-06. Shopify keeps each order's client
  details, the browser's address and user agent, but not the terms it was placed under: a policy
  edited since shows its new words. Policies are the online store's
  ([ADR-056](#adr-056--a-shops-policies-are-kept-as-shopify-keeps-them-shown-in-shopifys-markup-and-drafted-from-what-the-shop-has-set-never-saved-by-themselves));
  orders are the orders module's, which checkout places them through
  ([ADR-044](#adr-044--checkout-is-one-page-the-core-renders-and-storefronts-serve-on-the-shops-address-placing-a-cash-on-delivery-order-as-the-page-showed-it)).
* **Decision:**
  * **Every body a policy is saved with is kept, as a version**, which request code can neither
    change nor delete (`online_store.policy_versions`); the policy names its current one, and
    one taken away leaves its versions.
  * **The checkout says what placing the order agrees to**, above its button, in English and
    Urdu: the shop's policies, each linked, but for its contact information, which promises
    nothing. Nothing when the shop has none.
  * **The order agrees only to what its page linked:** the page's digest covers the versions it
    linked, so a policy changed while the shopper was there shows the page again, as a changed
    price does.
  * **The order keeps it**, in the orders module: the versions agreed to, and the address and
    browser it was placed from, as Shopify's client details, which storefronts pass on with the
    form (`x-hatti-client-ip`, `x-hatti-client-user-agent`). When is when the order was placed.
    Only orders placed through checkout have one.
  * **The Admin API shows it as `Order.agreement`**: when, from where, and the policies as they
    were then, which the core joins from the online store. The address and browser are the
    customer's data: shown only to those who see customers' numbers whole
    ([ADR-027](#adr-027--customers-numbers-are-masked-by-role-and-reveals-go-to-an-append-only-audit-log)),
    and cleared when the customer is erased. The versions stay: they are the shop's words.
* **Consequences:**
  * An order shows what its customer read, whatever the policy says now; a shop that edits its
    policies keeps every version.
  * An order placed while a policy changes asks the shopper once more.
  * The address is the one the storefront sees: behind the edge, the edge's own, until the
    storefront trusts the address the edge forwards, as its rate limits need too.
  * Draft orders confirmed through their links, and orders from staff and apps, keep none yet
    (since [ADR-114](#adr-114--a-draft-its-customer-confirms-through-its-link-keeps-what-they-agreed-to-as-checkouts-orders-do-the-page-names-the-shops-policies-above-its-button-and-the-order-keeps-their-versions-and-where-it-was-confirmed-from), a draft's order
    keeps one, and since [ADR-115](#adr-115--an-order-staff-or-an-app-placed-keeps-what-its-customer-agreed-to-in-confirming-it-through-its-link-the-page-names-the-shops-policies-and-the-order-keeps-their-versions-where-it-was-confirmed-from-and-when) an order its customer confirms
    through its link).
* **Alternatives:**
  * **A box the shopper ticks:** stronger evidence of assent, but one more tap on a phone, at the
    step cash-on-delivery shoppers leave most; the sentence beside the button is how shops take
    assent already.
  * **The policies' text copied into each order:** no versions, but thousands of orders each
    carrying the same pages of text.
  * **The online store keeping the log:** it would have to know orders and take part in their
    customers' erasure, which the orders module does already.

## ADR-058 · No order collects more cash on delivery than the law allows, whoever places it: the rest is paid in advance, or the order is not placed

* **Context:** Income Tax Circular 02 of 2025-26 applies the Rs 200,000 cap on cash payments to
  cash-on-delivery orders
  ([research](../research/03-local-ecosystem.md#61-timeline), TAX-07), and a courier collecting
  more breaks it on the shop's behalf. [05 §4.4](./05-checkout-and-payments.md#44-method-rules-engine)
  puts the cap in the method rules engine, which comes with online payment (PAY-01); until then
  cash on delivery is how checkout's orders are paid, and staff, apps and drafts' links place
  cash-on-delivery orders too.
* **Decision:**
  * **The orders module refuses the order**, wherever it comes from: `placeIn` and saving a draft
    refuse a cash-on-delivery order whose cash at the door, its total less any advance, is more
    than the cap, with `COD_LIMIT` on its `advancePaid` and the advance it would need. An advance
    that brings the cash within the cap, or paying in full, places it.
  * **Checkout says so before the shopper types:** a cart whose items alone come to more shows
    the reason, without the form, and one taken past the cap by delivery shows it when placed.
    Nothing is placed either way.
  * **The cap is the law's, and binds orders in rupees:** `COD_CASH_LIMIT` in the orders module,
    changed with the law, not a setting a shop or the platform turns.
* **Consequences:**
  * A shopper whose cart comes to more than Rs 200,000 cannot check out until online payment
    exists; the page asks them to take items out, or to ask the shop about an advance, which
    staff take on a draft order.
  * Orders placed before a change of the cap keep what they collect.
* **Alternatives:**
  * **A warning, not a refusal:** leaves the shop and its courier to break the law.
  * **Splitting the order into parcels under the cap:** one sale split to avoid the cap is still
    over it.
  * **A platform setting:** the value belongs to the law, and a release carries a change to it
    with its tests.

## ADR-059 · A Shopify product export is imported product by product, as productCreate makes them, keeping their handles; the core sets the stock

* **Context:** the MVP half of ONB-05 is importing Shopify's CSV exports, and a shop's catalog is
  most of its move: Shopify's product CSV has a row for each variant and each image, grouped by
  handle, the first row of a product carrying its title, description, vendor, type, tags and
  status. A product's address, `/products/{handle}`, is what search engines and old links know
  ([F10](../design/03-key-user-flows.md#f10--migrate-from-shopify): no SEO lost). Customers'
  imports take Shopify's customer export already (CUS-07). Products are the catalog's; stock is
  the inventory module's, which depends on the catalog.
* **Decision:**
  * **`productsImport(csv, dryRun)` reads Shopify's product CSV as Shopify writes it:** rows
    grouped by handle; option values or a price make a row a variant; Title / Default Title is a
    product without options; Status, or Published, whether it is on sale; Body (HTML) becomes the
    plain text the catalog keeps, paragraphs and list items kept; SKU, barcode, grams,
    compare-at price and cost come with each variant, and images by position.
  * **Each product is made as `productCreate` makes it**, in a transaction of its own, with its
    checks and its events, then given its images. What the catalog would refuse is said by the
    row and column it came from, and the rest go in. A dry run makes the same checks and counts,
    writing nothing.
  * **Handles are kept**, so every product keeps its address. A handle the shop has already is
    left as it is: the same file can be imported again, and nothing is overwritten.
  * **The core sets the stock Shopify tracked**, on hand at the primary location, through the
    inventory module, a batch of 250 variants at a time, and keeps selling out-of-stock variants
    Shopify sold on; the catalog, which cannot reach inventory, returns what to set.
  * **Left out:** gift cards, images not at https addresses, SEO titles and descriptions,
    metafields, unit prices and tax codes; variants' own images are added to the product's.
* **Consequences:**
  * An import runs in its request: 300 products with 900 variants took six seconds on a laptop.
    The admin's import screen will run big files in the background, with progress, as F10 has it.
  * Images stay at Shopify's addresses until the media worker copies them; a shop that closes its
    Shopify store before then loses them.
  * Importing again after changes on Shopify leaves the products as they were imported.
  * A shop with several Shopify locations gets a variant's stock at its primary location: the
    product CSV has one quantity a variant.
* **Alternatives:**
  * **The whole file in one transaction,** as customers' imports go: one product's failure would
    stop the rest, and one long transaction would hold its locks while hundreds of products were
    made.
  * **Bulk inserts around `productCreate`:** faster, but a second way to make products, whose
    checks, events and handles would have to be kept in step with the first.
  * **Overwriting products with the same handle:** it would undo the shop's edits since, and
    replace variants whose IDs orders keep.

## ADR-060 · COD health follows a period's cash-on-delivery orders, worked out from them when asked, its rates of those that turned out

* **Context:** COD-12, the COD health dashboard, is in the MVP: confirmation, delivery and RTO
  rates by city, courier, product and source, as
  [06 §11](./06-orders-fulfillment-logistics.md#11-key-metrics-merchant-dashboard) defines
  them, and the beta's exit criteria measure each merchant's delivery success rate against their
  own baseline. Analytics are to be served from ClickHouse (ADR-014), which comes with V1. Until
  then the orders are in Postgres, each with its confirmation and each parcel with its outcome,
  and what a customer's orders add up to is worked out from them when read already (ADR-023).
* **Decision:**
  * **`codHealth(placedFrom, placedBefore, by)` follows the cash-on-delivery orders placed in a
    period** through confirmation and delivery: placed, confirmed (by the customer or staff,
    whatever came after), cancelled before anyone confirmed them, and awaiting; and their
    parcels: shipped, delivered, returned (on their way back, or back) and in transit. Prepaid
    orders are left out.
  * **Rates are of those that turned out:** confirmed of those confirmed or cancelled, and
    delivered and returned of the parcels delivered or returned, from 0 to 1, and null while
    there are none. What is still waiting is counted beside them, and counts once it turns out.
  * **It breaks down by city, product, source or courier**, most orders first: a city as orders
    keep it, in any letter case; a product by the lines sold, an order counting for each product
    in it and a parcel for each it carried, under the title it was last sold under; a source as
    `OrderSource` names it; and a courier as staff named it when shipping, for parcels alone.
  * **It is worked out from the orders and their parcels when asked**, by the orders module,
    whose they are, and stored nowhere. A period is a year at most. It needs `read_orders`.
* **Consequences:**
  * The numbers are always the orders' as they are now, with nothing to rebuild or keep in step.
    An order cancelled after it was confirmed counts as confirmed.
  * A year of 57,000 cash-on-delivery orders with 48,000 parcels took 0.1 to 0.45 seconds on a
    laptop, and a month of 4,700 of them 40 to 120 ms. No index covers when orders were placed;
    one halved a month's times and left a year's as they were.
  * Couriers are the names staff typed until courier booking (SHP-01) records them.
  * A recent period has many orders still waiting, and its rates settle as they turn out.
* **Alternatives:**
  * **ClickHouse now:** another store to run and keep in step, for a few hundred shops. It comes
    with V1, when the same report can read `orders_fact` and `shipments_fact`.
  * **Rates of everything placed or shipped**, as 06 §11's table writes them: a recent period
    would look worse than it is while its orders wait to turn out.
  * **Counters kept as orders change:** every change to an order or parcel would have to update
    them, and one missed would leave them wrong for good.

## ADR-061 · Sales are reported in Shopify's terms, from the orders when asked: an order counts on the day it was placed, cancelled ones aside, and so do its items that came back

* **Context:** ANL-02, sales analytics, is in the MVP: sales, orders, average order value and
  top products, with sessions, conversion and a live view, which need the storefront's events.
  Merchants moving from Shopify read its sales reports: gross sales, discounts, returns, net
  sales, shipping, taxes and total sales, and an average order value of gross sales less
  discounts over orders. Shopify books a return on the day it happens. A cash-on-delivery shop
  cancels many orders before anything moves, and 18 to 30% of its parcels come back unpaid
  ([market research](../research/01-market-research.md)). Analytics are to be served from
  ClickHouse with V1 (ADR-014); COD health is worked out from the orders when asked (ADR-060).
* **Decision:**
  * **`salesReport(placedFrom, placedBefore, interval, topProducts)` gives what a period's
    orders came to in Shopify's terms:** orders, gross sales (items at the prices sold),
    discounts, returns, net sales (gross less discounts and returns), shipping, total sales (net
    sales and shipping, with taxes when TAX-01 brings them) and average order value (since
    [ADR-117](#adr-117--the-sales-report-leaves-out-the-sales-tax-its-amounts-include-as-shopifys-does-worked-out-from-the-tax-each-order-keeps-the-tax-said-apart-and-added-back-in-total-sales), each without the tax prices include, but total sales); for the
    period, for every day, week from Monday or month of it in the shop's time zone, those
    without orders included, and for the products that sold most.
  * **An order counts on the day it was placed, and cancelled orders are left out:** most were
    never more than a phone call.
  * **Returns are the items in parcels that came back, refused or undeliverable, at the prices
    sold, counted on the day their order was placed**, not the day they came back. Refunds are
    money given back, which the finance reports will take; they are not taken off.
  * **It is worked out from the orders when asked**, by the orders module, and stored nowhere. A
    period is a year at most. It needs `read_orders`.
* **Consequences:**
  * A day's net sales fall as its parcels come back, and settle once they have all arrived
    somewhere: they say what that day really sold, where Shopify's would swing with the days
    returns arrive.
  * A year of 54,000 orders took 0.36 to 0.41 seconds on a laptop, and a month of them 73 to
    104 ms.
  * A product deleted since keeps its row, under the title it was last sold under.
* **Alternatives:**
  * **Returns on the day they came back, as Shopify books them:** a cash-on-delivery shop's
    days would swing with each batch of parcels a courier returns, and a day's sales would
    never show what came of them.
  * **Cancelled orders counted, then taken off as Shopify does when they are refunded:** for
    orders cancelled at confirmation, nothing was sold or paid.
  * **ClickHouse now:** as for COD health, it comes with V1, with the storefront's events for
    sessions and conversion.

## ADR-062 · Discount codes are the pricing module's: a percentage or an amount off an order's items, or free delivery, matched in any letter case

* **Context:** CHK-06's MVP half is codes for a percentage or an amount off, or free delivery;
  automatic discounts, buy X get Y, tiers, bundles and combining codes are V1's.
  [05 §3](./05-checkout-and-payments.md#3-cart--pricing-calculation-pipeline) prices a cart in
  steps, product, order and shipping discounts among them, and
  [01 §4](./01-system-overview.md) gives discounts to a Pricing & Promotions module. Shopify's
  admin has basic codes (a percentage or an amount, on everything or some products and
  collections, with a minimum, eligible customers, usage limits, combinations and dates) and
  free-shipping codes. Staff already give an order a discount of their own when they place it.
* **Decision:**
  * **`@hatti/pricing`, a new module, keeps discount codes**, as 01's Pricing & Promotions; price
    lists can join it later.
  * **A code gives one thing:** a percentage of the order's items (0.01 to 100, kept in
    hundredths of a percent), an amount off them, never more than they come to, or free
    delivery. It may need the items to come to a minimum, works between its dates, and may be
    limited to a number of orders in all and to one order a customer.
  * **Codes are letters, digits, hyphens and underscores, up to 64**, kept as the shop wrote them
    and matched in any letter case, so a shop cannot have both EID25 and eid25; 10,000 a shop.
  * **`discountOf` alone works out what a code takes off an order**, a percentage rounded half up
    to the paisa, so that every page and the order say the same.
  * **The Admin API** has `discountCodes`, `discountCode`, `discountCodeByCode`,
    `discountCodeCreate`, `discountCodeUpdate` and `discountCodeDelete`, under Shopify's
    `read_discounts` and `write_discounts`, which owners, managers and marketers have. One input
    makes or changes either kind: left out, a field stays as it is, and null clears it.
  * **Deleting a code stops it;** orders placed with it keep the code and what it took off.
* **Consequences:**
  * Codes apply to the whole order: none for some products or collections, and one code an order
    until codes combine in V1.
  * A code's status says only whether its dates have come and gone; its uses show beside it.
  * Shopify's API makes basic and free-shipping codes with mutations and inputs of their own; a
    Shopify app's discount calls need translating to Hatti's.
  * Shoppers cannot use codes until the cart and checkout take them, which comes next.
* **Alternatives:**
  * **Discounts in the checkout module:** draft orders and the admin's orders will take codes
    too, and price lists belong with them, not with carts.
  * **Shopify's input shapes,** `customerGets`, `customerSelection`, `minimumRequirement` and
    `combinesWith`: most of their fields would be for what is not built, refused when given.

## ADR-063 · A shopper's discount code is kept with their cart and counted with the order placed with it, in the order's transaction

* **Context:** codes are kept (ADR-062); shoppers need to use them, and shops need their limits
  kept. Checkout is one page the core renders, without scripts, that places a cash-on-delivery
  order as the page showed it (ADR-044). Shopify keeps codes on the cart, so that a `/discount/`
  link works before checkout, and counts a use when an order is placed. A customer is known only
  once the order is placed: placing finds or makes them by the number typed (ADR-023). Codes can
  be guessed, and the core's own checkout address has no rate limit of the storefront's.
* **Decision:**
  * **The cart keeps the code** (`discount_codes`, one for now), which checkout's page takes in
    a form of its own, above the address: a shopper applies a code before typing where it goes.
    A code that would take nothing off is refused with why, and not kept.
  * **The page shows what the code takes off**, worked out by `discountOf`: the items first,
    then delivery, whose free threshold the discounted items must reach, as Shopify's free
    shipping does; a free-delivery code makes delivery free wherever it goes. A code that
    stops applying while kept, as when the cart drops under its minimum, is shown with why, and
    the order is placed without it. The page's digest takes in the code, so the order is placed
    with the code only as the page showed it.
  * **A use is counted with the order, in its transaction:** once `placeIn` has placed it, the
    code's row is locked and its uses counted under the limit, and a redemption kept with the
    order, its customer and what the code took off. A code used up since, or one a customer may
    use once that the order's customer has used, undoes the order, and the page says why.
  * **Orders keep their codes** (`discountCodes`, as Shopify's orders do), with what they took
    off in `discount` and `shipping`. Uses are not given back when orders are cancelled.
  * **A checkout's page takes ten codes that take nothing off, then no more**, so that codes
    cannot be guessed through it.
  * **Merging customers moves their uses**, so a code they could use once stays used.
* **Consequences:**
  * A once-a-customer code is refused only as the order is placed, after the shopper has typed
    their number; the page keeps what they typed.
  * A cancelled order's use stays counted, so a code limited to 100 orders may see fewer
    delivered.
  * Staff's orders and drafts take discounts as amounts, not codes, for now.
* **Alternatives:**
  * **The code kept on the checkout:** a new checkout of the same cart would lose it, and a
    `/discount/` link has no checkout to keep it on.
  * **Uses counted from the outbox after the order:** two orders could both take a code's last
    use.
  * **A customer's use found by number in the redemption:** a number may change hands and
    customers merge; the customer the order belongs to is the one to ask about.

## ADR-064 · Discount links keep their code with the shopper's cart, one begun for it if need be, and a cart says of a code only whether it applies

* **Context:** the cart keeps a shopper's code, and checkout's page takes one (ADR-063). Shops
  share codes as links: Shopify's `/discount/CODE?redirect=/collections/eid` applies the code
  and sends the shopper on, from Instagram, WhatsApp or a text message, before anything is in
  their cart. Themes' scripts set codes with Shopify's Ajax cart (`discount` on
  `/cart/update.js`, codes separated by commas) and read them back in `discount_codes`, with
  what they take off in `total_discount` and `cart_level_discount_applications`; Liquid's `cart`
  has the same totals and applications. Carts change only from the shop's own pages (ADR-042), at most 120 times a
  minute from an address. Checkout counts the codes tried on its page so that they cannot be
  guessed there, and says why a code does not apply.
* **Decision:**
  * **`/discount/CODE` keeps the code with the shopper's cart**, beginning one that holds only
    the code when they have none, and sends them on with a 302 to `redirect`, else the home page,
    in the link's language. Links come from other sites, so unlike the cart's forms they are not
    refused for it: a link changes nothing but the code. Past the limit of cart changes, or with
    the core away, the shopper is still sent on, without the code; a HEAD request changes
    nothing.
  * **`redirect`, and a form's `return_to`, go only to paths on the shop, as a browser reads
    them** (`localPath`): parsed as a URL, so that `/%09/elsewhere.example`, which a browser
    reads as `//elsewhere.example` once it drops the tab, is refused like it.
  * **The cart takes Shopify's `discount`**: the first of the codes given that a shop could
    have, an empty one taking the code off. One code for now.
  * **A cart says of a code only whether it applies, as Shopify's does:** `discount_codes` has
    the code and `applicable`. One that applies is written as the shop wrote it, with what it
    takes off the items; one that does not is written as typed, with nothing else, whether or
    not the shop has it. Checkout's page says why.
  * **What it takes off is the cart's, not its lines'**: `total_price` and Liquid's
    `checkout_charge_amount` are the items after it, `total_discount` what it takes, and one
    cart-level discount application of type `discount_code` says so. A free-delivery code takes
    nothing off the cart: Liquid's `discount_applications` has it aimed at the shipping line
    checkout adds, and themes' lists of what is taken off do not.
  * **Hatti Base's cart page and drawer show the subtotal, the code and what it takes off, and
    the total**, free delivery by code, or a code that does not apply yet, in English and Urdu;
    the shop's free-delivery threshold is for the items after their discount, as at checkout.
* **Consequences:**
  * Every followed link that brings no cart begins one, link previews' fetches included; such
    carts hold nothing but the code, and expire as others do.
  * Codes put on carts by links or scripts are not among checkout's ten; the limit on cart
    changes bounds those, and a cart tells a guesser only of codes that apply to it.
  * A shopper sent on without the code, past the limit or with the core away, is not told; the
    cart and checkout show no code.
  * A closed shop's links lead to its password page, without the code.
* **Alternatives:**
  * **The code in a cookie of its own until something is added:** no cart for link previews,
    but every cart change would have to carry the cookie, and a script's `/cart.js` could not
    say what the code takes off.
  * **Saying why a code does not apply in the cart**, for themes to show: it would tell anyone
    which codes a shop has, with no count of the codes tried.
  * **Refusing links from other sites, as the cart's forms are:** the links are for sharing
    elsewhere.

## ADR-065 · A cart permalink begins a cart of its own and goes to its checkout, leaving the shopper's cart as it is

* **Context:** shops in Pakistan sell in chats: a shopper asks on WhatsApp or Instagram, and the
  shop sends a link to pay on delivery. Shopify's cart permalinks,
  `/cart/{variant}:{quantity},…`, are such links, with `discount`, `note` and `attributes` in
  their query; they take the shopper straight to checkout. Carts belong to shoppers, through a
  cookie (ADR-042), and checkout is a cart's (ADR-044). Drafts (ADR-031) are for orders agreed
  one by one, at prices of their own.
* **Decision:**
  * **A permalink begins a cart of its own**, of the items it names, with its `discount`,
    `note` and `attributes`, and sends the shopper to that cart's checkout. The shopper's own
    cart, in their cookie, stays as it was, so a link sent in a chat never empties or changes
    what they were choosing on the shop.
  * **Variants are named by their IDs**, as themes see them; quantities are whole numbers.
    Items that cannot be had, sold out or no longer for sale, show the shopper's own cart with
    why, as a refused cart form does. What the link adds to its items is not needed to go on:
    if the core refuses it, the items go to checkout without it.
  * **Links come from anywhere**, so one followed from another site is taken, as discount links
    are (ADR-064); each counts as a change to carts, under the same limit, past which the
    shopper is asked to wait a moment. A HEAD request changes nothing.
  * **Placing an order sets the cart count from the shopper's own cart**, which the order
    emptied if it was the cart ordered, rather than to 0.
* **Consequences:**
  * Every followed link begins a cart and a checkout, link previews' fetches included; they
    expire as others do.
  * The checkout's page does not take the shopper's name or address from the link, as
    Shopify's `checkout[shipping_address]` would; a shop that knows them sends a draft's link.
  * A link's items are priced and held to stock when it is followed, not when it was made.
* **Alternatives:**
  * **The link's items added to the shopper's cart:** a shopper would check out what they had
    chosen before as well, or lose it.
  * **A page that asks before beginning the cart:** a tap more on every link, for link previews'
    sake.

## ADR-066 · What couriers owe is worked out from the orders when asked: delivered cash-on-delivery orders not yet paid, by courier and by days since delivery

* **Context:** couriers collect cash on delivery and pay it over days or weeks later, less their
  charges, and a shop needs to know who owes what, and since when (COD-10, 06 §7). The home
  gives the cash still to come as one figure (ANL-01). Orders keep what was paid,
  `amount_paid`; parcels keep the courier staff named and when they were delivered. Couriers'
  remittance statements come next.
* **Decision:**
  * **Owed is `total - amount_paid` on cash-on-delivery orders at `delivered`**: what the order
    still owes, whatever was paid ahead or since, which marking the order paid, or a
    remittance, settles.
  * **Its age runs from the order's last delivered parcel**, in whole days, in four bands: up to
    a week, a fortnight, a month, and longer. **Its courier is that parcel's**, as staff named
    it, in any letter case, the spelling used most standing for the rest.
  * **On its way** is the same on orders `in_transit` or `partially_fulfilled`; with what is
    owed, it is the home's cash still to come.
  * **Worked out from the orders when asked**, as COD health is (ADR-060): orders waiting for
    their cash are few, and the stage index finds them.
* **Consequences:**
  * An order delivered in parcels by two couriers counts under the last; one paid in part shows
    what is left until the rest is paid.
  * Couriers are as staff typed them: "TCS" and "T.C.S." are two until parcels are booked
    through Hatti (SHP-01).
* **Alternatives:**
  * **A table of receivables kept as parcels are delivered and orders paid:** a second record of
    what the orders already say, to keep in step.
  * **Ages from when the order was placed:** a courier owes from delivery, and an order slow to
    confirm or ship would look overdue.

## ADR-067 · Couriers' remittance statements are imported whole into a logistics module, each line's cash received on its parcel's order, at most what the order owes, and a parcel's cash once

* **Context:** couriers pay a shop the cash they collected days or weeks later, less their
  charges and the tax they withhold, with a statement, usually a spreadsheet, of the parcels it
  is for (COD-10, 06 §7). Shops reconcile them by hand today: which parcels were paid, which
  short, which never. Each courier names its columns its own way. Parcels keep the tracking
  number staff typed, and orders what was paid (ADR-066). The architecture gives remittances to
  Fulfillment & Logistics, a module that did not exist; parcels are still the orders module's.
* **Decision:**
  * **A logistics module (`@hatti/logistics`) keeps statements** (`cod_remittances`) and their
    lines (`cod_remittance_lines`), each with the parcel and order it matched. It reaches orders
    only through functions of the orders module that take its transaction: parcels by tracking
    number, what their orders owe, locked, and cash received on an order.
  * **A statement is the CSV the courier sends**, its columns found by the names couriers use
    ("CN #", "Tracking Number", "COD Amount", "Delivery Charges", "WHT", "Net Payable" and their
    like), its amounts as they write them, a totals row passed over. Rows that cannot be read are
    reported; the rest are taken.
  * **Lines match parcels by tracking number without spaces, in capitals**, the courier's own
    parcel first when two share a number. Each line's cash is received on its parcel's order, at
    most what the order still owes: `received`, `short` or `over`. Lines that match no parcel
    (`unmatched`), name one whose cash a line has collected before (`repeated`), or an order
    that owes nothing (`not_owed`), receive nothing and are kept to look into; a line with no
    cash on a parcel sent back is the courier's charges (`charged`).
  * **A statement is taken whole, in one transaction**, its parcels' orders locked in turn, so
    that two statements naming a parcel at once receive its cash once. Orders take the cash as a
    payment, in full or in part, with a line on their timeline; the order's own events follow.
    A statement's reference from the same courier is taken once. A dry run says what would
    happen and writes nothing.
  * **Owners, managers and accountants reconcile**, and apps with `write_orders`: receiving cash
    marks orders paid.
* **Consequences:**
  * A parcel the courier pays for but staff never marked delivered is paid, and stays on its
    way until it is marked.
  * A shortfall paid in a later statement is `repeated`, not received: staff mark the rest paid,
    as a statement imported twice must not pay twice.
  * Charges and tax are kept with each line and statement, for the ledger and tax credits to
    come; they are not taken off what the order received.
  * Excel writes long tracking numbers as `1.23E+11` unless they are kept as text; such lines
    match nothing.
* **Alternatives:**
  * **Remittances in the orders module, beside parcels:** quicker, but courier bookings and
    tracking come next and belong together, and the orders module is already the largest.
  * **Each courier's format known by name:** exact, but every courier's file to learn and
    follow; column names cover them, and a format can be added where they do not.
  * **Lines received one by one, in transactions of their own:** a failure halfway would leave a
    statement half taken.

## ADR-068 · A cash-on-delivery customer may cancel through the order's link until it is packed, though they confirmed it, unless the shop keeps that to before confirming

* **Context:** a customer cancels through their order's link while it waits for them to confirm
  it (ADR-032), and corrects its address until it is packed (ADR-033). A customer who changes
  their mind after confirming has had to message the shop, which often learns too late: the
  parcel ships and comes back refused, costing the shop both ways (RTO). The order status page
  (05 §8) is to allow "cancellation within the merchant's window". Shops differ: some would
  rather call a customer who wavers.
* **Decision:**
  * **A shop's order settings** (`orders.order_settings`, `orderSettings`) **say how long its
    customers may cancel**: `until_packed`, the default, or `until_confirmed`, as before.
    Owners and managers change them (`write_settings`); the change is audited, and an
    `order_settings.updated` event.
  * **Until it is packed, a confirmed cash-on-delivery order can be cancelled through its
    link**, while nothing has been paid or shipped, the same cutoff as correcting its address.
    The page offers it below the order, and asks first (`?cancel`), as before confirming.
  * **The cancellation is the customer's**, its reason `customer`, its stock released; the
    order stays confirmed, and the timeline says they cancelled after confirming it, so the
    shop sees a customer who changed their mind, not one who declined.
* **Consequences:**
  * Fewer parcels refused at the door; a shop whose customers cancel often learns it from the
    timeline and the cancellations' reason.
  * A shop that prints slips before marking orders packed may pack an order its customer has
    cancelled; marking orders packed as slips print closes the gap, as for addresses.
  * Whoever holds a forwarded link can cancel the order until it is packed, as they could
    correct its address; the timeline says it happened through the link.
* **Alternatives:**
  * **A window of hours from placing:** easier to say, but an order may wait days to be packed,
    or be packed within the hour; packed is when cancelling starts to cost.
  * **Cancelling until shipped:** a packed parcel may already be labelled and booked.
  * **A cancellation request for staff to accept:** the shop would act on every one anyway, and
    a request the shop misses still ships.

## ADR-069 · The checkout's page takes the shop's accent colour from its published theme, on its buttons, and on its links where they stay readable

* **Context:** the checkout's page is the core's, not the theme's (ADR-044), and was in the
  platform's teal for every shop. A shopper who comes from a storefront in the shop's colours to
  a page in another's may wonder whether they are still with the shop, at the moment they give
  their name, number and address. CHK-14 asks for the shop's logo, colours and trust badges on
  it. Shops set their colours in their theme already: Hatti Base's `color_accent` is its buttons'
  and links' colour. The page allows no style but its own, by its hash, and no `style`
  attributes.
* **Decision:**
  * **The page takes the accent colour of the shop's published theme**, in its current settings
    or the preset they name, as its storefront pages have it (`shopAccentOf`): one colour, set in
    one place, not a checkout setting to keep in step with the theme.
  * **Hex colours alone** (`#rgb` or `#rrggbb`): the page works out from them what reads on them.
    A colour given in `rgb()` or with transparency, or none, leaves the platform's.
  * **Buttons take the colour, with white or dark text, whichever contrasts more with it; links
    and focus rings take it where it reads on white at 4.5 to 1**, as WCAG asks of text, and the
    platform's colour otherwise. On the few mid tones where neither white nor the dark text
    reads at 4.5 to 1, buttons' text is black, which always does then: no colour leaves a button
    hard to read. Colours that say what happened stay: a mistake's red, an order placed's green.
    Dark mode keeps the platform's colours, made for it.
  * **The colour comes as a style element of its own**, setting the page's variables and nothing
    else, its hash added to the page's content security policy: nothing the shop saved reaches
    the page but a hex colour.
  * A page with no shop to show, such as a checkout not found, keeps the platform's colours.
* **Consequences:**
  * The shopper sees the shop's colour from its storefront to its thank-you page, and a shop that
    changes its theme's colour changes its checkout with it, when the page is next shown: one
    more small read of the theme's settings each time.
  * A light colour gives buttons dark text, and links the platform's colour: readable rather
    than exactly the shop's.
  * `renderPage` takes an accent for any page; the orders' links' pages keep the platform's
    colours until they take the shop's too.
  * Not yet: the shop's logo, which Hatti Base does not have (its header shows the shop's name),
    and comes with images the shop uploads; trust badges the shop chooses, since what it
    promises is in its policies, which the page links and placing the order agrees to (ADR-057),
    and cash on delivery, which the page says; and custom fields (V1).
* **Alternatives:**
  * **A checkout colour of its own**, as Shopify's checkout branding has: another place to set
    the same colour. It can come later, over the theme's.
  * **The theme styling the page**, as Shopify's `checkout.liquid` did: refused in ADR-044.
  * **A colour for dark mode worked out from the shop's**: a shade guessed from it may clash with
    the shop's own, where the platform's dark colours were chosen for dark mode.
  * **`style` attributes**: the policy would need `'unsafe-inline'`, or `'unsafe-hashes'` with a
    hash for each.

## ADR-070 · An address keeps its area in its second line and its landmark in a field of its own; checkout and customers' links ask for each, suggesting the areas of the larger cities

* **Context:** a house in Pakistan is found by its area and a landmark near it more than by its
  number, and postcodes are rarely used: the pattern is a city, an area, a landmark and perhaps
  a map pin (research 03 §3.4). Couriers sort parcels by area; riders ask for the landmark.
  Checkout asked for both in one box, "Area or landmark", which orders kept as `address2`, and
  customers' links called it a landmark: given one box, a shopper gives one or the other.
  Shopify's addresses have no landmark: apps built for them read `address1`, `address2` and
  `formatted`. Daraz asks for the area, the address and a landmark apart.
* **Decision:**
  * **An address's second line is its area** (`address2`), as addresses are written here: the
    house and street, the area, then the city. Apps built for Shopify's addresses find it where
    they look.
  * **The landmark is a field of its own**, Hatti's (`landmark`), optional, up to 255
    characters: on orders and drafts, and on the Admin API's `MailingAddress` and
    `MailingAddressInput`. `formatted` gives it a line after the area, so that labels printed
    from it carry it; packing slips, invoices, exports and the pages customers see show it.
  * **Checkout and customers' links ask for each in a box of its own**, the landmark's saying
    what it is for. The area's box suggests well-known areas of the ten larger cities
    (`PK_CITY_AREAS` in `@hatti/pk`): the city's, once the form has one; while it has none, every
    listed city's, each by its city, since a page without scripts cannot change its suggestions
    as the city is typed. Suggestions only: any area may be typed, and none is required.
  * **Addresses kept before** are given no landmark (migration 0040): their second line stays as
    it was typed, often a landmark where the area now goes.
* **Consequences:**
  * Couriers' bookings (spike 2) can send the area and the landmark as each courier takes them;
    reports and risk can use areas once they are named alike.
  * An app built for Shopify misses the landmark unless it prints `formatted`.
  * While no city is typed, the checkout's page carries some 200 areas to suggest: about 11 KB,
    under 2 KB compressed.
  * The lists are the platform's, of well-known names, and far from whole; couriers' own lists
    (Call Courier books by area) will check and widen them.
* **Alternatives:**
  * **The landmark in `address2` and the area in a field of Hatti's:** apps built for Shopify
    would lose the area, which couriers sort by.
  * **Both in `address2`, joined:** neither could be suggested, printed or searched apart.
  * **The area picked from a required list,** as on Daraz: it needs every area of every town,
    which couriers' lists will give; a box with suggestions never turns away an address the list
    lacks.
  * **A map pin:** it needs scripts and the phone's location; it comes later, as an addition to
    the page.

## ADR-071 · A parcel coming back is checked in by the tracking number on its label, matched as couriers' statements are; those on their way back are listed the longest first

* **Context:** refused and undeliverable parcels (return to origin) are cash-on-delivery's
  largest loss. A parcel that comes back is checked in at the shop with each item restocked or
  written off (`fulfillmentReceiveReturn`), found by its ID, which no one at a packing table
  has: they hold a parcel with a courier's label, and often a scanner that types its tracking
  number. Couriers bring parcels back late, or not at all, and a shop learns which only by
  counting the days. Staff type tracking numbers as they see them ("LE 7001 234"); scanners
  read them without spaces; couriers' statements are already matched with spaces and letter
  case ignored (ADR-067).
* **Decision:**
  * **`fulfillmentReceiveReturn` takes the parcel's tracking number in place of its ID**,
    matched as statements are: spaces and letter case ignored, on the same index. It must name
    one parcel still out (in transit or coming back); a number on two still out names their
    orders and checks neither in, to be checked in from its order. A parcel already checked in,
    or delivered, says so as by its ID, at the tracking number's box. Everything is restocked
    unless `restock` says otherwise, as before.
  * **A parcel brought back before anyone marked it coming back is checked in all the same**:
    the parcel in hand is what counts.
  * **`returningParcels` lists the parcels on their way back, the longest on its way first**,
    with the days since each started back, its courier, tracking number, order and items, and
    one courier's alone if asked: those a courier is slow to bring back come to the top, to
    chase. A partial index keeps it to the parcels coming back (migration 0041).
  * **The orders list finds an order by its parcel's tracking number matched the same way.**
* **Consequences:**
  * A returns desk scans a parcel and is done; one with damaged items looks the order up by the
    same scan and says what goes back on the shelf.
  * A number staff typed twice by mistake stops a scan until one is checked in from its order;
    the message names both orders.
  * Not yet: parcels the courier lost, written off with their order closed and a claim on the
    courier; what a return cost the shop (06 §6, RTO cost); returns couriers report through
    their APIs (spike 2).
* **Alternatives:**
  * **A query to find the parcel, then the mutation by its ID:** two calls for the commonest
    case, an intact parcel; the query is there anyway, as the orders list.
  * **The latest parcel with the number when several are out:** a scan would check in a parcel
    still on its way, its items counted twice.
  * **Exact tracking numbers only:** scans of numbers typed with spaces would find nothing.

## ADR-072 · A parcel the courier lost is written off, and an order with nothing delivered or back ends at a stage of its own; lost before reaching the customer, it is never their refusal

* **Context:** couriers lose parcels: on their way out, before the customer ever sees them, and
  on their way back after a refusal ("RTO lost"), and shops claim the parcels' worth from them.
  A lost parcel could only be left in transit or coming back for good, its order never done and
  counted among those on their way, or be checked back in as if it had come, its items counted
  on a shelf they never reached. Whose doing it was matters: risk scores, the Confirmation Desk
  and COD health count customers' refusals, and a parcel lost before reaching a customer is
  none.
* **Decision:**
  * **`fulfillmentMarkLost` writes a parcel off**, in transit or coming back: it is `lost`, with
    `lostAt`, nothing of it restocked, and the timeline says so ("Lost by TCS 7790: 3 items
    written off", "on its way back" when it was coming back). Lost twice is still lost.
  * **An order whose parcels were neither delivered nor brought back ends at a stage of its
    own, `lost`**: done and closed as one returned is, an unpaid cash-on-delivery order voided;
    a prepaid one stays paid, for the shop to settle with its customer. One parcel of several
    lost leaves the order to the others: delivered and unpaid in part until it is paid.
  * **A lost parcel takes no more news from its courier** (delivered, coming back). If it turns
    up, it is checked back in as any parcel, by its ID or its tracking number, its items back on
    the shelf, and it stays counted as lost: the order stays `lost`.
  * **Lost before reaching the customer, it is never their refusal**: their delivery history
    counts it as lost, risk scores leave it out, and COD health counts it as lost, the courier's,
    in neither rate. **Refused first, it stays a refusal** everywhere, though the courier lost it
    on its way back. `returningAt` tells the two apart.
  * **Its items count as returns in sales reports**, as a refused parcel's do: neither was sold.
  * The customer's page says the courier lost the parcel, and that the shop will be in touch.
* **Consequences:**
  * Couriers' losses show beside their returns, courier by courier, and stop inflating the
    parcels on their way.
  * No claim on the courier is kept yet: what a courier pays for a lost parcel comes in its
    statement as a line to look into (`not_owed`, ADR-067).
  * A lost parcel found and delivered cannot be recorded: the order is done, and closed orders
    take no payments.
* **Alternatives:**
  * **Lost as returned:** stock counted that never came back, and a refusal held against a
    customer who never saw the parcel.
  * **A flag on parcels left in transit:** their orders would never be done.
  * **Claims now:** each courier has its own process for them, which their APIs (spike 2) will
    show.

## ADR-073 · The Confirmation Desk deals orders waiting for their customers to agents one at a time, the most urgent due first, and keeps the calls that did not settle them

* **Context:** most cash-on-delivery orders are confirmed by a call before they ship; shops with
  more than a handful a day have agents who call all day (06 §3.2, COD-04). Two agents working
  from one list call the same customer; an unanswered customer is forgotten or called every few
  minutes; a promise to call back after her shift lives on a scrap of paper. The order list
  shows what waits, not what to call next.
* **Decision:**
  * **The queue is the orders waiting for their customers to confirm them**
    (`needs_confirmation`), due for a call from when they are placed. Held orders are the shop's
    to decide, on their own tab: whoever reviews one may call and record it too, but it is not
    dealt out.
  * **The most urgent first:** orders of high value, as the shop's risk policy sets it, then
    those due longest, then the riskier. `confirmationQueue` lists them, with how many are due
    and how many wait for later.
  * **`confirmationQueueNext` deals an agent one order**, the most urgent no one else has taken,
    theirs for 15 minutes, so that no two agents call the same customer; asked again, they get
    the one they have. Taking an order is the queue's, not the order's: no version, timeline
    entry or event.
  * **`orderConfirmationCall` keeps a call that did not settle the order** and lets it go: no
    answer, due again in two hours or when the agent says, and after three the customer could
    not be reached (`no_response`), still called; asked to call back, due then, within a week;
    a wrong number, held for review. Confirming and cancelling stay `orderConfirm` and
    `orderCancel`. Each call is kept with its outcome and the agent's note, which erasure
    clears and the timeline leaves out.
* **Consequences:**
  * Agents work through orders without stepping on each other, and a shop sees what is due now
    and what waits for later; the calls are there for agents' performance (COD-11).
  * A claim runs out after 15 minutes: an agent on a long call takes the order again by asking
    for the next.
  * Not yet: SLA timers and the shop's confirmation policy (COD-05: channels, quiet hours,
    giving up), WhatsApp and IVR attempts (COD-01, COD-03), and the queue in the admin app.
* **Alternatives:**
  * **Held orders first, in the agents' queue** (06 §3.2): a held order waits for a decision
    agents may not take, such as a blocked number, and a wrong number would come straight back.
  * **Orders assigned to agents ahead of time:** a shop's agents come and go during the day; a
    queue each asks of keeps them all busy.
  * **By total, the largest first:** a small order would wait behind every larger one, however
    long; the shop's own line for high value is enough.

## ADR-074 · A shop that gives its bank account offers bank transfer: the order waits for the money at a stage of its own, and keeps the account its customer was told to pay into

* **Context:** most shops here without a gateway take bank transfers: the customer pays into
  the shop's account from their banking app, by IBAN, and sends the receipt in a chat (05 §6,
  PAY-02). Above Rs 200,000, the law's cap on cash at the door (ADR-058), it is how most
  shoppers can pay at all, and checkout turned them away. A transfer is not cash on delivery: no
  one need call to confirm an order its customer has paid for, and nothing should ship before the
  money is in.
* **Decision:**
  * **A shop gives one account** (`bankTransferSettingsUpdate`, `write_settings`): its title,
    its bank and a Pakistani IBAN, spaced or not, kept unspaced, its check digits checked; and
    what customers are told besides, such as where to send the receipt. Checkout offers bank
    transfer while the shop has it on; staff may place bank-transfer orders either way. A change
    is audited with the account before and after: diverting customers' money to another account
    is what a stolen staff login would do.
  * **A bank-transfer order is placed unpaid and waits at `awaiting_payment`** until staff see
    the money and mark it paid (`orderMarkAsPaid`), which moves it to To pack: it can't be packed
    or shipped before. It needs no confirming, as paying is the customer's say-so, and is not
    scored for risk, which is of cash refused at the door; a blocked number's is still held for
    review first. Nothing is collected at the door, and it takes no advance. Its customer may
    cancel it through its link until they pay.
  * **The order keeps the account its customer was told to pay into**, as it was when placed:
    an account changed later is for later orders.
  * **Checkout offers a choice**, cash on delivery unless the shopper picks transfer, and
    transfer alone for a cart above what cash on delivery may collect. The page names the bank;
    the thank-you page and the order's link show the account, its IBAN in groups of four and
    selected whole with a tap, the amount, and the order's number to give as the transfer's
    reference. Drafts may be paid by transfer too: their order waits the same way, and a draft's
    link stays for cash on delivery.
  * The admin's home counts the orders awaiting payment, and their packing slips say not to pack
    them.
* **Consequences:**
  * Shops take orders paid in advance without a gateway, and orders above the cash cap through
    checkout.
  * Staff match transfers to orders by hand, in their bank's app, by the reference and amount.
  * Not yet: the customer sending the receipt through the page (with file storage), the shop's
    Raast QR, reminders and cancelling orders never paid, more than one account, and reading
    receipts with AI (Growth).
* **Alternatives:**
  * **`prepaid`, marked paid later:** a prepaid order is paid when placed, and would say so of
    one that is not.
  * **Confirming transfers as cash-on-delivery orders are confirmed:** a customer who pays has
    confirmed; a call would only hold the order up.
  * **Showing the shop's account as it is now:** a customer who paid into the old account would
    see one they never used, and a stolen login changing it would reach orders placed before.
  * **The account in a payments module of its own:** there is none until online payment
    (PAY-01), and both orders' pages and checkout read it; the orders module keeps it, beside the
    shop's other order settings, until then.

## ADR-075 · A shop keeps cash on delivery to the orders it trusts: up to a total of its own, outside cities it names, and not for customers who refused parcels before; checkout offers transfer instead

* **Context:** every parcel refused at the door costs a shop a return (06, COD-06). Shops keep
  cash on delivery from the orders they don't trust: large ones, cities their couriers serve
  badly, customers who refused before (05 §4.4, CHK-07). Until bank transfer
  ([ADR-074](#adr-074--a-shop-that-gives-its-bank-account-offers-bank-transfer-the-order-waits-for-the-money-at-a-stage-of-its-own-and-keeps-the-account-its-customer-was-told-to-pay-into)),
  checkout had no other way to pay to offer them.
* **Decision:**
  * **A shop sets its rules** (`cashOnDeliverySettingsUpdate`, `write_settings`): a total above
    which it takes no cash on delivery, cities where it doesn't, as addresses name them, and how
    many refused parcels a customer may have had before, as their delivery history counts them.
    None applies until the shop sets it.
  * **Checkout keeps to them, and only checkout:** orders staff and apps place, and drafts their
    customers confirm, are the shop's own call, and keep to the law's cap alone (ADR-058).
  * **The page says what it can before the shopper types:** the total and the cities, with the
    cash-on-delivery option; a cart whose items alone come to more is offered transfer alone,
    or, without it, nothing to fill in. **Placing checks the rest:** the total with delivery, the
    city typed, and the history of the customer with the number typed, any number of theirs.
    Kept from cash on delivery, the page says why, keeping what the shopper typed, with transfer
    chosen for them where the shop takes it; a customer kept from it for their refusals is not
    told so.
  * The page's digest covers the rules it states, so a change while it is open shows it again.
* **Consequences:**
  * Shops that take transfers keep cash on delivery to the orders worth it; shops that don't
    lose online the orders their rules keep from it, whose shoppers the page sends to the shop.
  * Not yet: rules for products, such as pre-orders or stitching, which need settings of their
    own on products; a risk score's outcome at checkout; partial advances; and the fee for cash
    on delivery (CHK-08).
* **Alternatives:**
  * **Rules for every order, staff's too:** staff agree how a customer pays in the chat; a rule
    would only stand in their way.
  * **Holding refused customers' orders for review, as risky ones are:** the order would be
    placed for a shop that already said it won't take their cash.
  * **Telling a customer why:** the number typed may not be theirs; the shop can tell them in
    the chat.

## ADR-076 · A shop's fee for cash on delivery is the order's own amount, apart from delivery: in its total and the cash collected, said beside the option where the shopper chooses

* **Context:** many shops here charge for cash on delivery, Rs 50 to 150 an order, as their
  couriers charge them for collecting it (CHK-08; the pricing pipeline in 05 §3 puts payment
  adjustments, such as a COD fee, after delivery). Folded into delivery charges, a fee would show
  on a free-delivery order as a delivery charge, and no report could say what a shop charged for
  which.
* **Decision:**
  * **The shop sets its fee with its rules for cash on delivery** (`fee`, through
    `cashOnDeliverySettingsUpdate`); checkout adds it to orders paid on delivery, and none to
    transfers.
  * **The order keeps it as an amount of its own, `codFee`:** total = subtotal − discount +
    shipping + codFee, which a database check holds. It is cash collected at the door, so the
    law's cap counts it. Invoices, the thank-you page and the customer's link show it on a line
    of its own; exports have a column for it; sales reports count it as additional fees, in
    total sales, as Shopify's reports do.
  * **The page says it where the shopper chooses:** beside transfer, the option says it ("with a
    Rs 100 fee") and the summary's total, either way's, leaves it out; alone, the summary adds a
    line for it to what is paid at the door. The page's digest covers it.
  * Orders staff and apps place have none: a fee agreed in a chat goes in the delivery charge or
    the price.
* **Consequences:**
  * Shops recover what collecting cash costs them, and shoppers see the fee before they choose.
  * Not yet: something off for paying by transfer (the prepaid incentive), fees on staff's
    orders and drafts, and fees that depend on the total or the city.
* **Alternatives:**
  * **Adding it to the delivery charge:** a free-delivery code would leave the fee as a delivery
    charge, and neither the shop nor its reports could tell the two apart.
  * **A line item for the fee, as some of Shopify's apps add:** sales reports would count it as a
    product sold, and packing slips would list it.

## ADR-077 · Something off for paying by transfer is part of the order's discount, kept apart from the codes': off the items after any code, to the rupee, said where the shopper chooses

* **Context:** cash on delivery costs shops twice: the courier's fee for collecting it, and the
  parcels refused at the door. Shops here nudge shoppers to pay first with something off for it,
  5% or Rs 150 or so (CHK-08's prepaid incentive; the pricing pipeline in 05 §3 puts payment
  adjustments after delivery). Bank transfer is the way to pay first that checkout offers
  (ADR-074).
* **Decision:**
  * **The shop sets it with its bank account** (`discount`, through
    `bankTransferSettingsUpdate`): a percentage, 0.01 to 50, up to a cap if it sets one, or an
    amount. Checkout offers it while it offers bank transfer; a shop may set it before. A change
    is audited with the account, before and after.
  * **Off the items after any discount code, to the rupee:** a percentage of what the items come
    to once the code took its share, rounded half up to a whole rupee, so that what the shopper
    transfers stays whole; an amount, no more than they come to. Delivery is what it was: free
    delivery's threshold is reached, or not, before it, so paying by transfer never costs
    delivery.
  * **The order keeps it in its discount, and apart as `transferDiscount`:** total = subtotal −
    discount + shipping + codFee as before, and a database check keeps it within the discount,
    on transfers alone. Invoices, the thank-you page and the customer's link show the codes'
    discount and it on lines of their own; exports have a column for it; sales reports count it
    in discounts, as it is one. A code's use counts what the code took off, not it.
  * **The page says it where the shopper chooses:** beside cash on delivery, the transfer's
    option says what it takes off this cart ("Bank transfer, Rs 250 off") and the summary's
    total, either way's, leaves it out; alone, the summary takes it off. The page's digest
    covers it.
  * Orders staff and apps place have none: what staff agree in a chat goes in their discount.
* **Consequences:**
  * Shops can steer shoppers to pay first, and shoppers see what they save before they choose.
  * Not yet: something off for other ways to pay first (wallets and cards, with PAY-01),
    incentives that depend on the cart or the customer, and on staff's orders and drafts.
* **Alternatives:**
  * **A discount code for transfers:** shoppers would have to know it and type it, and nothing
    would keep it off orders paid on delivery.
  * **Folding it into the discount alone:** the thank-you page and the invoice could not say
    what the code took off and what paying by transfer did, and no report could say what the
    incentive cost the shop.
  * **To the paisa, as codes take theirs:** 5% of Rs 4,990 is Rs 249.50, and Rs 4,740.50 is not
    what anyone types into a banking app here.

## ADR-078 · A shop keeps cash on delivery from products by their tags: a cart holding one is offered bank transfer alone, the page naming the product

* **Context:** pre-orders, custom stitching and made-to-measure pieces cost a shop the most when
  they are refused at the door, as no one else wants them (CHK-07; availability by product, in
  05 §4.4). Shops mark such products already, with tags such as "pre-order", as on Shopify,
  whose cash-on-delivery apps go by tags.
* **Decision:**
  * **The shop names tags with its rules for cash on delivery** (`unavailableProductTags`,
    through `cashOnDeliverySettingsUpdate`), up to 50, each once in any letter case; a product
    with any of them, in any letter case, is paid another way.
  * **The page knows before the shopper types:** a cart holding such a product is offered bank
    transfer alone, where the shop takes it, the page naming the product; otherwise there is
    nothing to fill in, and the page says to remove it or ask the shop. Checkout reads the
    products' tags with the cart's variants, and only when the shop names any.
  * The catalog knows nothing of the rule: tags are the shop's, and checkout reads them through
    the variants' snapshots, as orders read titles and prices.
  * Orders staff and apps place are the shop's own call, as for its other rules.
* **Consequences:**
  * Shops keep cash on delivery from what they can't sell again, without a setting on each
    product.
  * Not yet: an advance for such products rather than the whole (partial advance), rules by
    collection, and the product's page saying so before the cart.
* **Alternatives:**
  * **A setting on each product:** the catalog would carry a rule for payments, and a shop would
    set it product by product rather than tag them, as it does for its collections.
  * **Collections:** a smart collection of pre-orders goes by tags anyway, and a rule by
    collection would have checkout read memberships for every cart.

## ADR-079 · Files are kept in object storage under each shop's prefix, uploaded straight there through URLs the Admin API signs, and shown only through short-lived signed URLs; a directory stands in for R2 in development

* **Context:** the platform kept no files until now: product images are URLs elsewhere. Shops
  need to upload their own, for their pages and the logo on their checkout (CHK-14), and their
  customers to send the receipts of their transfers (PAY-02). R2 is the platform's object storage
  (ADR-007, 02 §tech stack), and 03 §7 keeps each shop's objects under its own prefix, private,
  shown only through short-lived signed URLs.
* **Decision:**
  * **`@hatti/storage` keeps files by key:** R2 through the S3 API, its requests and URLs signed
    with Signature Version 4, written in the package and checked against AWS's own examples;
    and, for development and tests, a directory the core serves at /storage, signing its URLs
    with HMAC, so the whole flow runs without a cloud account. Production must use the bucket.
  * **Keys are `shops/{shopId}/files/{fileId}/{name}`**, the name cut to letters, digits,
    hyphens and underscores with its type's extension. Nothing is public: a file is shown through
    a URL signed for an hour, by its name.
  * **Uploads go straight to storage, as Shopify's staged uploads do:** `stagedUploadsCreate`
    signs a PUT for each file's exact size and type, for an hour; the client sends the bytes;
    `fileCreate` makes a file of each upload once it is in, of that size, its first bytes those
    of its type, or removes it. Uploads staged a day ago and never made files are swept as the
    shop stages more.
  * **The files module keeps the records** (`files.files`, staged then ready), with
    `file.created` and `file.deleted` events: JPEG, PNG, WebP, GIF and PDF, up to 20 MiB, ten at a
    time, under Shopify's `read_files` and `write_files`, which owners, managers and marketers
    hold.
* **Consequences:**
  * In production, files' bytes never pass through the core, and none of a shop's files is
    readable without a URL the platform signed.
  * Not yet: products' media from files, the checkout's logo, receipts sent through the order's
    page, which has no scripts and so sends its form through the core; images resized at the
    edge; an external URL as a file's source; quotas per shop; scanning PDFs.
* **Alternatives:**
  * **The AWS SDK:** dozens of packages, for four calls and two signed URLs.
  * **Uploads through the core:** every byte through the API's servers and its 2 MB requests,
    for no check that storage can't do with the size and type it signed for.
  * **Forms posted straight to storage, with a signed policy:** R2 takes no POST uploads.
  * **A public bucket:** receipts and images not yet published would be anyone's to read.

## ADR-080 · A customer sends the receipt of their transfer through their order's page, in a form the core reads and keeps in storage by order; the shop sees it with the order

* **Context:** a customer who pays by transfer sends the receipt in a chat, a screenshot from
  their bank's app, and staff match it to an order by hand ([ADR-074](#adr-074--a-shop-that-gives-its-bank-account-offers-bank-transfer-the-order-waits-for-the-money-at-a-stage-of-its-own-and-keeps-the-account-its-customer-was-told-to-pay-into)). Their order's page shows
  where to pay; it should take the receipt too, so the shop sees it with the order. The page runs
  no scripts, so it can't upload straight to storage as the Admin API's clients do
  ([ADR-079](#adr-079--files-are-kept-in-object-storage-under-each-shops-prefix-uploaded-straight-there-through-urls-the-admin-api-signs-and-shown-only-through-short-lived-signed-urls-a-directory-stands-in-for-r2-in-development)): a form posts the file, and R2 takes no posted forms.
* **Decision:**
  * **While the order waits for its transfer, its page has a form** for a photo, a screenshot or
    the PDF of the receipt (`multipart/form-data`, `action=receipt`), posted to the page itself.
    The page then says the shop has it, and how many the customer sent.
  * **The core reads forms with a file on orders' pages alone** (`/o/`): one file of up to
    10 MiB, in memory, and a few short fields. Past 10 MiB the rest is read and dropped, so the
    page can say the file is too large; a form with a file anywhere else is refused (415).
  * **A receipt is told by its first bytes**, not by what the browser says: JPEG, PNG, WebP or
    PDF. Storage keeps it at `shops/{shopId}/receipts/{orderId}/{receiptId}.{ext}` before any
    transaction, so none waits on storage; then the order, locked, takes it while it is open and
    waits for the transfer, five at most. A receipt the order does not take is removed.
  * **The orders module keeps them** (`orders.transfer_receipts`): its timeline says the customer
    sent one, through the system, and `order.updated` names `transferReceipt` as changed; the
    order's version stays, as nothing of the order changed. The Admin API shows them on the order
    (`Order.transferReceipts`, under `read_orders`), oldest first, each through a URL signed for
    an hour and named for the order: "Receipt #1023-1.jpg".
  * **Erasing the customer deletes their receipts' records**, which show their name and account:
    the order keeps what it was paid. Nothing signs a URL for their files after.
* **Consequences:**
  * Staff see the receipt beside the order they mark paid, rather than in a chat from a number
    that may not be the order's.
  * A receipt's bytes pass through the core, up to 10 MiB each, held in memory while storage
    takes them.
  * Not yet: a list of orders with receipts to check, telling staff when one comes, removing
    erased receipts' files from storage, and reading receipts with AI (Growth).
* **Alternatives:**
  * **A script on the page uploading straight to storage:** the page runs none, and works on
    any phone without.
  * **Receipts as the shop's files** (`files.files`): those are the shop's library, of its own
    uploads; a receipt is its customer's, found and erased by order.
  * **Trusting the browser's type:** a page renamed `.jpg` would be kept as one.
  * **Streaming the file to storage as it comes:** R2 needs its length before it takes it, and a
    receipt is small enough to hold.

## ADR-081 · A shop's logo is one of its files, chosen as its brand's; the checkout's page shows it in place of the shop's name, through a URL signed for an hour that the page's policy allows alone

* **Context:** CHK-14 asks for the shop's logo on its checkout's page, which shows the shop's
  name instead, in its colour since [ADR-069](#adr-069--the-checkouts-page-takes-the-shops-accent-colour-from-its-published-theme-on-its-buttons-and-on-its-links-where-they-stay-readable). Hatti Base has no logo either: its header shows the
  shop's name. Shops upload files now ([ADR-079](#adr-079--files-are-kept-in-object-storage-under-each-shops-prefix-uploaded-straight-there-through-urls-the-admin-api-signs-and-shown-only-through-short-lived-signed-urls-a-directory-stands-in-for-r2-in-development)), none of them public, each shown through a URL
  signed for an hour. The page runs no scripts, and its policy allows nothing it does not name.
* **Decision:**
  * **The shop's brand keeps its logo, one of its files**, as Shopify's `shop.brand.logo` is one
    of its images: `shopBrandUpdate` sets it, or takes it away, and `Shop.brand` shows it, under
    the files' scopes. A logo is an image the shop uploaded, JPEG, PNG, WebP or GIF, never a PDF.
    Deleting the file takes the logo with it. The files module keeps it (`files.brands`), beside
    the files themselves, and records `shop_brand.updated`.
  * **The checkout's page shows it in place of the shop's name**, its thank-you page and its other
    pages too, named by the shop's name for those who can't see it, at most 200 by 64 pixels. On a
    dark page it sits on a white ground: logos are made for light ones.
  * **Through a URL signed for an hour**, made with the page, straight to storage, as the shop's
    other files are shown.
  * **The page's policy allows that image alone**, by its address without the signature: the
    page names the images it shows (`renderPage`'s `images`), each https, or http on localhost.
* **Consequences:**
  * Shoppers see the shop's own mark from the cart to the thank-you page. Each page fetches the
    logo again, as its signed URL is new each time: a small image, from storage straight.
  * Not yet: the logo on orders' links' pages, which keep the platform's colours too, and on
    invoices and packing slips; `shop.brand.logo` for themes, and a logo in Hatti Base's header,
    once images are served from the edge at addresses that last; a square logo, a slogan and
    brand colours, which Shopify's brand has; trust badges.
* **Alternatives:**
  * **A logo setting in the theme**, as its colour is: the storefront could not show it yet, with
    no images served from the edge, while the checkout did.
  * **The page fetching the logo through the storefront, on the shop's address:** a route for the
    shop's images that the edge keeps, which is the work of serving images from the edge.
  * **A public bucket, or the logo inlined in the page:** every file of the shop's public, or each
    page carrying the image's bytes.
  * **Allowing any image from storage in the page's policy:** a page could then show anything of
    the platform's storage that it was given a URL to.

## ADR-082 · A shop's account takes its Raast ID beside its IBAN, kept with each order as the account is, and shown on its customers' pages to copy; a Raast QR waits for the partner's

* **Context:** PAY-02 asks for the merchant's Raast QR beside the bank transfer of
  [ADR-074](#adr-074--a-shop-that-gives-its-bank-account-offers-bank-transfer-the-order-waits-for-the-money-at-a-stage-of-its-own-and-keeps-the-account-its-customer-was-told-to-pay-into). Raast, the State Bank's instant payment system, is how most transfers between
  Pakistani banks now move: free, and to a Raast ID, the mobile number a bank registered for an
  account, as well as to an IBAN. Customers read their order's page on the phone they pay from,
  where a code on the screen can't be scanned; typing or pasting a number is what they do. A QR
  for merchants (P2M) carries the State Bank's payload, which a partner bank issues.
* **Decision:**
  * **The shop's account takes its Raast ID**, a Pakistani mobile number in any format, kept in
    E.164, or none: `raastId` on `bankTransferSettingsUpdate`'s account. It is where the money
    goes, so a change is audited as the account's is, before and after.
  * **An order keeps it with the account its customer was told**, as the IBAN; orders placed
    before have none.
  * **The thank-you page and the order's page show it under the IBAN**, as people write mobile
    numbers, "0300 1234567", selected whole with a tap, to copy into a banking app.
* **Consequences:**
  * A customer pays by IBAN or by Raast ID, whichever their app asks for, to the same account.
  * Not yet: a QR, which comes with the partner's Raast (PAY-03): dynamic, for the order's amount,
    on a page read on a computer; and checking that the ID is the account's, which only the bank
    can do.
* **Alternatives:**
  * **A QR image the shop uploads:** a code from its bank's app shows on a page read on the same
    phone that would scan it, and carries no amount.
  * **Writing the Raast QR's payload ourselves:** the State Bank's specification is for its
    participants, and a code no app reads would cost a sale.
  * **The Raast ID in the shop's instructions:** free text, not checked, and not kept as the
    account is.

## ADR-083 · A cash-on-delivery order may ask for an advance, paid by transfer before it ships: it waits for it as a transfer waits for its money, and staff record it when it is in

* **Context:** shops here often ask for part of a cash-on-delivery order before they send it,
  the delivery charge or a share of a costly or made-to-order piece, paid by transfer, to cut the
  parcels refused at the door (CHK-07). An order kept an advance only once paid (`advancePaid`,
  which staff record as they place it); one that asks for an advance and waits for it had no
  place, and staff tracked it by hand. A bank transfer already waits for its money, keeps the
  account its customer was told, shows it on the customer's pages and takes the receipt
  ([ADR-074](#adr-074--a-shop-that-gives-its-bank-account-offers-bank-transfer-the-order-waits-for-the-money-at-a-stage-of-its-own-and-keeps-the-account-its-customer-was-told-to-pay-into), [ADR-080](#adr-080--a-customer-sends-the-receipt-of-their-transfer-through-their-orders-page-in-a-form-the-core-reads-and-keeps-in-storage-by-order-the-shop-sees-it-with-the-order)).
* **Decision:**
  * **A cash-on-delivery order may ask for an advance** (`advanceDue`): staff ask for it as they
    place the order, and checkout will by the shop's rules. Not beside an advance paid already,
    never more than the total, and only from a shop with a bank account, which the order keeps
    as a transfer's to tell its customer where to pay.
  * **It waits for the advance at `awaiting_payment`**, as a transfer waits for its money: it
    can't be packed or shipped before. It needs no call to confirm and is not scored, as paying
    is the customer's say-so; a blocked number's is still held for review. Its customer may
    cancel it through its link until they pay.
  * **Its customer's pages say what to pay ahead and what at the door**: the account with the
    advance as the amount to transfer, and the rest, which the courier collects (`codAmount`);
    the receipt is taken as a transfer's. The law's cap on cash at the door ([ADR-058](#adr-058--no-order-collects-more-cash-on-delivery-than-the-law-allows-whoever-places-it-the-rest-is-paid-in-advance-or-the-order-is-not-placed)) counts
    only what the advance leaves.
  * **Staff record the advance by hand, as any payment:** `orderCreateManualPayment`, as
    Shopify's records a manual payment, takes an amount, or what the order waits for by transfer,
    else the rest; one that makes up the total marks the order paid. It needs an idempotency key,
    as recording twice would count twice.
* **Consequences:**
  * The home counts orders waiting for their advance among those awaiting payment, and those
    with receipts among the transfers to check; the order list finds them by stage.
  * Not yet: checkout asking for an advance by the shop's rules (next), drafts asking for one, an
    advance as a share of the total, and reminders or cancelling for advances never paid.
* **Alternatives:**
  * **A stage of its own, `awaiting_advance`:** the same wait, page and check of the money as a
    transfer's; one stage keeps the counts, filters and pages one.
  * **A call to confirm first, then the advance:** two steps where paying is one.
  * **Recording the advance with `orderMarkAsPaid`:** it marks the order paid in full, which the
    courier's cash would then contradict.

## ADR-084 · Checkout asks for the advance the shop's rules name: an amount, a share of the items or the delivery charge, on every order or above a total, said beside cash on delivery

* **Context:** an order may ask for an advance on cash on delivery, which staff set as they
  place it ([ADR-083](#adr-083--a-cash-on-delivery-order-may-ask-for-an-advance-paid-by-transfer-before-it-ships-it-waits-for-it-as-a-transfer-waits-for-its-money-and-staff-record-it-when-it-is-in)). Shops ask for one by
  rule: most often the delivery charge, which a refused parcel costs them twice; a share of a
  costly order; or a token amount, often only above a total (CHK-10's "delivery charge or a %
  upfront"). Checkout's page has no scripts, and with zones it knows the delivery charge only
  once a city is typed.
* **Decision:**
  * **The shop's rules for cash on delivery name one advance** (`advance` on
    `cashOnDeliverySettingsUpdate`): an amount, never more than the items; a percentage of the
    items after any code, to the rupee, half up, as what paying by transfer takes off is
    ([ADR-077](#adr-077--something-off-for-paying-by-transfer-is-part-of-the-orders-discount-kept-apart-from-the-codes-off-the-items-after-any-code-to-the-rupee-said-where-the-shopper-chooses)); or the order's delivery
    charge, nothing where delivery is free. On every order, or only on those whose items come to
    more than a total of its own (`above`).
  * **It is paid into the shop's bank account**, which the shop must give before it sets one,
    offering bank transfer at checkout or not. Without the account, checkout asks for none: an
    account taken away leaves the rule, asking for nothing, and the shop's other rules still
    change.
  * **Checkout says it beside cash on delivery:** "you pay Rs 500 in advance by bank transfer,
    and the rest when your order arrives", or "the delivery charge" where that is the advance,
    whose amount the summary gives once it is known. Where cash on delivery is the only way to
    pay, the summary shows the total, the advance by transfer and what the door collects. The
    page's digest holds the advance, so a page shown before it changed shows itself again.
  * **The order it places asks for it** (`advanceDue`), worked out once the city is known, and
    keeps the account: it waits at `awaiting_payment` without a call to confirm or a score, and
    its thank-you page says where to pay it and what the door collects. Once staff record it,
    the page says the shop will be in touch. A shopper paying by transfer pays it all, and is
    asked for no advance.
* **Consequences:**
  * Shops cover what refused parcels cost them without turning cash on delivery away, as the
    rules of [ADR-075](#adr-075--a-shop-keeps-cash-on-delivery-to-the-orders-it-trusts-up-to-a-total-of-its-own-outside-cities-it-names-and-not-for-customers-who-refused-parcels-before-checkout-offers-transfer-instead) do.
  * Not yet: an advance by city or by customer, as for those who refused parcels before, instead
    of turning cash on delivery away; something off an advance paid by transfer; drafts asking
    for one; reminders for advances never paid, with messaging.
* **Alternatives:**
  * **An amount and a total alone:** the simplest, but shops ask most for the delivery charge,
    which differs by city, and for a share of costly orders.
  * **A share of the order's total, delivery included:** with zones, unknown until the city is
    typed; the items are known from the start, and are what paying by transfer takes its
    percentage of.
  * **Asking for it only where bank transfer is offered:** a shop may take transfers for advances
    alone; the account is what the customer pays into.
  * **An amount capped at the order's total:** unknown before the city with zones; capped at the
    items, the page states what the order asks for.

## ADR-085 · A draft may ask for an advance as an order does; once its customer confirms it, the draft's link shows where to pay and takes the receipt

* **Context:** drafts are orders taken in chats ([ADR-031](#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link)),
  where shops most often agree an advance with their customer, for a costly or made-to-order
  piece; a draft kept one only once paid (`advancePaid`). An order may ask for one
  ([ADR-083](#adr-083--a-cash-on-delivery-order-may-ask-for-an-advance-paid-by-transfer-before-it-ships-it-waits-for-it-as-a-transfer-waits-for-its-money-and-staff-record-it-when-it-is-in)), and checkout does by the shop's
  rules ([ADR-084](#adr-084--checkout-asks-for-the-advance-the-shops-rules-name-an-amount-a-share-of-the-items-or-the-delivery-charge-on-every-order-or-above-a-total-said-beside-cash-on-delivery)). A draft's customer confirms it through its link (`/d/`), which then
  shows the order; receipts were taken on orders' links alone
  ([ADR-080](#adr-080--a-customer-sends-the-receipt-of-their-transfer-through-their-orders-page-in-a-form-the-core-reads-and-keeps-in-storage-by-order-the-shop-sees-it-with-the-order)), whose forms with a file were read on `/o/` only.
* **Decision:**
  * **A cash-on-delivery draft may ask for an advance** (`advanceDue` on `draftOrderCreate` and
    `draftOrderUpdate`), checked as an order's is: not beside one paid already, never more than
    the total, the law's cap on what it leaves, and asked for only by a shop with a bank account.
  * **Its link's page says it before the customer confirms:** the summary's advance by transfer
    and what the door collects, and above the button, that they pay it by transfer to the account
    the next page shows.
  * **Confirmed by its customer, or completed by staff, its order asks for it** and waits at
    `awaiting_payment`. The draft's link, which shows the order from then on, says where to pay
    and **takes the receipt**, as the order's own link does: forms with a file are read on `/d/`
    too, and a draft not yet an order takes none.
* **Consequences:**
  * A customer goes from the chat to the advance paid on one link; the shop sees the receipt with
    the order, among the transfers to check.
  * An advance's receipts show where a transfer's do, on its order's link and through the Admin
    API's `transferReceipts`, which counted and listed them as none.
  * Not yet: the draft link's WhatsApp message says nothing of the advance, and its customer
    can't cancel through it, as through an order's link.
* **Alternatives:**
  * **The order's own link, sent once the draft is confirmed:** a second link for one order, and
    the draft's would still show the order without taking the receipt.
  * **Sending the draft's link on to a new order link:** a link the shop never sent, whose secret
    it never sees.

## ADR-086 · A shop chooses trust badges for its checkout from the platform's set, worded in English and Urdu and shown under the button where they hold

* **Context:** CHK-14 asks for trust badges on the checkout's page, the last of its MVP half; the
  checkout flow's design shows them under the button ("✓ Verified store · 7-day exchange"). A
  badge is a promise, and what a shop promises is in its policies, which the page links and
  placing the order agrees to ([ADR-057](#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)), which is
  why [ADR-069](#adr-069--the-checkouts-page-takes-the-shops-accent-colour-from-its-published-theme-on-its-buttons-and-on-its-links-where-they-stay-readable)
  left them out. The page has no scripts and allows no image but the shop's logo, and says
  everything in English and Urdu.
* **Decision:**
  * **The platform words a fixed set of badges in English and Urdu:** cash on delivery; open your
    parcel before you pay; an exchange or returns within the shop's days, 1 to 90; 100% original
    products; and help on WhatsApp. The shop picks up to four, each once, in its order
    (`checkoutTrustBadgesUpdate`, `write_settings`); nothing it types reaches the page.
  * **Each shows only where it holds:** cash on delivery and opening the parcel where the page
    offers cash on delivery for the cart; help on WhatsApp with the shop's number, which the shop
    can't choose it without, as a link to a chat; an exchange or returns linked to the refund
    policy where the shop has one, so the promise leads to its terms.
  * **Under the button that places the order**, a tick before each and the Urdu under the
    English, aligned as the payment choices are: text and a tick in the page's own style, so its
    policy stays as it is.
  * **The order keeps none of them:** what its customer agreed to is the policies, whose versions
    it keeps.
* **Consequences:**
  * Shoppers see what the shop promises where they decide, each promise leading to its terms or
    to the shop on WhatsApp.
  * Not yet: "verified store", which waits for the platform to verify shops; badges on the
    storefront, which are its theme's to show; badges of the shop's own words or images.
* **Alternatives:**
  * **Images the shop uploads, as Shopify's apps add them:** promises in one language, unchecked,
    each image another address for the page's policy to allow.
  * **The shop's own text:** its words in one language, and anything a shop types on the page.
  * **Badges worked out from the settings,** such as an exchange from the refund policy: a
    policy's terms can't be read reliably; the shop chooses what it promises.

## ADR-087 · Checkout takes at most three orders a day from one mobile number and twenty an hour from one internet address, counting the orders it placed, one at a time

* **Context:** fake cash-on-delivery orders cost shops most: each holds its stock, takes a call to
  confirm and, once booked, two journeys of a parcel. Checkout's page has no scripts, so a bot,
  or a prankster with made-up names, can post its form again and again; the blocklist and the
  risk rules hold such orders for review, but they are placed, and hold their stock. CHK-18 asks
  for limits on how fast orders come, and for Turnstile, which is the edge's, with the
  infrastructure. An order placed through checkout keeps the number it goes to and the internet
  address it came from ([ADR-057](#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)).
  Mobile networks in Pakistan put many phones behind one public address.
* **Decision:**
  * **Checkout takes at most three orders a day from one mobile number**, however it is written,
    counting the orders it placed for the shop in the last 24 hours, cancelled ones too.
  * **And at most twenty an hour from one internet address**, many more than from a number, as a
    mobile network's phones share addresses; orders from an address not known, or not an address,
    are counted by their number alone.
  * **They are counted in the placement's transaction, under a lock** on the number, then on the
    address, held until it ends: orders from one number placed at once are counted one at a time.
    The lock is the transaction's (`pg_advisory_xact_lock`), as PgBouncer's transaction mode
    allows, and nothing else waits on it.
  * **Past a limit, the page places nothing and says why**, answering 429: a number's limit tells
    the shopper to message the shop in their chat to order more; an address's, to try again later.
  * **The limits are the platform's**, the same for every shop. Orders staff, apps and drafts
    place are the shop's own call, and aren't limited.
* **Consequences:**
  * A flood from one number stops at three orders, and one from one address at twenty an hour,
    their stock left for real shoppers. An index on the orders' addresses keeps the count to a few
    rows (migration 0057).
  * A bot that changes both its numbers and its addresses still gets through, to the blocklist and
    the risk rules: Turnstile at the edge and the OTP (CHK-09) come with the infrastructure and
    messaging.
  * Not yet: limits a shop sets, such as more for a wholesale customer's number.
* **Alternatives:**
  * **Counters in Redis, as sign-in's are:** they count attempts rather than orders, apart from
    the transaction that places them, so a burst slips past; orders keep the number and the
    address already.
  * **A limit by browser, through a cookie:** bots drop cookies, and the page has no scripts.
  * **Refusing addresses outright:** one address is many shoppers on a mobile network.

## ADR-088 · A parcel keeps what couriers' statements charged for it, which COD health adds up for those that came back; a statement with the lines of one imported before is refused

* **Context:** a parcel sent back costs the shop the courier's charges both ways, its packaging
  and, now and then, the stock (06 §6, the RTO cost). Couriers' statements carry their charges
  line by line and are imported whole ([ADR-067](#adr-067--couriers-remittance-statements-are-imported-whole-into-a-logistics-module-each-lines-cash-received-on-its-parcels-order-at-most-what-the-order-owes-and-a-parcels-cash-once)): a
  delivered parcel's line has its cash and the charges taken off it; a parcel sent back has its
  charges alone, out and back, on one statement or two. The charges were kept with the
  statements' lines, so no one could say what a parcel, or a city's returns, had cost; COD health
  counts the parcels that came back ([ADR-060](#adr-060--cod-health-follows-a-periods-cash-on-delivery-orders-worked-out-from-them-when-asked-its-rates-of-those-that-turned-out)),
  not what they cost. And a statement imported again without its reference was taken again: its
  cash `repeated`, received once, but its charges alone would count twice once parcels add them
  up.
* **Decision:**
  * **A parcel keeps what its courier's statements charged for it** (`courier_charges`,
    migration 0058), added to as each statement is imported, through a function of the orders
    module that takes the import's transaction: every line's charges but those of a line for
    cash collected before, whose charges came with the cash. It is null until a statement
    charges the parcel; each charge is a line on its order's timeline and changes the parcel and
    its order, with their events. Statements imported before charge their parcels in the
    migration, by the same rule.
  * **COD health adds up what returns cost**: `returnCharges`, what statements charged for the
    parcels that came back, both ways, for the shop and by city, product, source and courier, a
    parcel once however many of its lines hold the product; and `returnsCharged`, how many of
    those parcels statements have charged, so that a figure with statements still to come reads
    as such.
  * **A statement is imported once.** As well as its reference from the same courier, one with
    the same lines as one imported before is refused, its lines known by a SHA-256 of them as
    read: tracking numbers without spaces, in capitals, and amounts in paisa, in any order. A
    statement saved again, sorted, or with its columns named otherwise is the same one. A
    parcel's cash is collected once, so the same lines with cash are a statement imported
    before; charges alone can come twice alike, a parcel charged out and back on statements of
    its own, and two such with references that differ are both taken.
  * **A shop's statements are imported one at a time**, under a lock the transaction holds
    (`pg_advisory_xact_lock`), so that the same statement imported twice at once is refused the
    second time. A dry run takes no lock.
  * **What a return cost is the courier's charges**: the tax a statement withholds stays with its
    line, for tax credits, and is not counted.
* **Consequences:**
  * A shop sees what its returns cost, by city, product and courier, as far as statements have
    come: the cost to weigh a city's or a product's cash on delivery by, and ask for an advance
    there (CHK-10). It starts the shipping cost per order (SHP-07) from what couriers charged
    rather than their rate cards.
  * Packaging and the stock written off are not in it: they are the shop's own costs, for the
    true profit report (ANL-03, V1).
  * A statement of charges alone with the lines of one imported without a reference is refused,
    though it might be another: one parcel charged alike out and back, each time on a statement
    of its own with no reference, loses the second charge.
  * Statements imported before migration 0058 have no digest: imported again, they are taken,
    their cash `repeated` as before, and their charges counted again.
  * Not yet: claims on couriers for lost parcels; returns couriers report through their APIs
    (spike 2).
* **Alternatives:**
  * **What a return cost worked out from statements' lines when asked**, as COD health is from
    orders: the orders module would read the logistics module's tables, or COD health move to
    logistics, away from the orders it counts.
  * **A cost per return the shop sets:** quick, but couriers charge by weight, distance and their
    own rate cards, and statements say what they charged.
  * **A statement known by its file's bytes:** saved again, or sorted, it would be taken twice.
  * **Each line refused if a statement before had it:** a parcel's line for charges back can be
    the same as its line out.

## ADR-089 · A shop's advance may be asked only to cities it names and of customers who refused parcels before: checkout names every city and says of whom, and placing applies them to the city and number typed

* **Context:** checkout asks for the shop's advance on every order paid on delivery, or on those
  above a total ([ADR-084](#adr-084--checkout-asks-for-the-advance-the-shops-rules-name-an-amount-a-share-of-the-items-or-the-delivery-charge-on-every-order-or-above-a-total-said-beside-cash-on-delivery)).
  Shops ask it where returns cost them most: in cities their couriers serve badly or slowly, and
  of customers who refused parcels before (CHK-10, 05 §4.4: the delivery charge up front in
  high-RTO cities). COD health now says what returns cost by city
  ([ADR-088](#adr-088--a-parcel-keeps-what-couriers-statements-charged-for-it-which-cod-health-adds-up-for-those-that-came-back-a-statement-with-the-lines-of-one-imported-before-is-refused)).
  The rules that keep cash on delivery from a city or a customer
  ([ADR-075](#adr-075--a-shop-keeps-cash-on-delivery-to-the-orders-it-trusts-up-to-a-total-of-its-own-outside-cities-it-names-and-not-for-customers-who-refused-parcels-before-checkout-offers-transfer-instead))
  turn the shopper away where an advance would keep the order. Checkout's page has no scripts:
  it knows the city and the number once they are posted, and that post places the order.
* **Decision:**
  * **The advance may name cities and refusals**, each a condition that the orders it asks must
    meet, as its total is: only to the cities named, as addresses name them, fifty at most; only
    of customers who refused that many parcels before, or more, as their delivery history counts
    them, as the rule that keeps cash on delivery from them does. Without either, it asks every
    order, as before.
  * **The page names every city, and says of whom**, beside cash on delivery, before anything is
    typed: "On orders to Quetta or Gilgit, if you refused a delivery from this shop before, you
    pay Rs 500 in advance by bank transfer." A shopper knows before placing whether it asks
    them. Once the city typed is one of them, and the advance asks nothing of the customer, the
    summary takes it off what the door collects.
  * **Placing applies it to the city and the number typed**, as it does the delivery charge: the
    order asks for the advance, or for nothing, and waits for it as before. The refusals of the
    number typed, any number of the customer's, are counted as the order is placed, and only
    where the shop's rules ask; the page looks nobody up.
  * The page's digest covers the cities and the refusals, so a change while it is open shows it
    again.
* **Consequences:**
  * A shop keeps cash on delivery in a city it doubts, with the delivery charge or a share of the
    items ahead, rather than turning shoppers away; and asks it of a customer who refused before
    without refusing them.
  * A customer whose number refused before learns that the advance asks them once the order is
    placed, as a refused customer learns that cash on delivery isn't available (ADR-075); the page
    says only the rule.
  * One rule: an advance in some cities for everyone, and another of refusers everywhere, cannot
    both be had.
  * Not yet: an advance of customers new to the shop, or by a risk score's outcome (COD-06).
* **Alternatives:**
  * **Looking the number up as it is typed, to say the amount:** the page has no scripts, and
    saying it would tell anyone who types a number whether its owner refused parcels.
  * **Showing the page again for the shopper to accept the advance once the city is typed:** a
    second post on every order the advance asks, for what the page already said.
  * **Cities or refusals, either one:** a shop could not ask refusers in one city alone; a rule of
    "only … only …" reads as each.
  * **Some cities named and the rest counted, as the cities without cash on delivery are:** a
    shopper could not tell whether the advance asks them; hence fifty at most, every one named.

## ADR-090 · Agents' performance is worked out when asked from the calls the desk keeps and the confirmations and cancellations on orders' timelines, by who made them, with how the orders each agent confirmed turned out

* **Context:** a shop with a Confirmation Desk wants to know how each agent does: how many
  orders they confirm an hour, how many customers they reach, and whether the orders they
  confirm are delivered or come back, which stops an agent confirming everything (06 §3.2,
  COD-11). The desk keeps each call that did not settle an order, with who made it
  ([ADR-073](#adr-073--the-confirmation-desk-deals-orders-waiting-for-their-customers-to-agents-one-at-a-time-the-most-urgent-due-first-and-keeps-the-calls-that-did-not-settle-them)); orders'
  timelines keep each confirmation and cancellation with who made it; COD health counts parcels
  delivered and returned ([ADR-060](#adr-060--cod-health-follows-a-periods-cash-on-delivery-orders-worked-out-from-them-when-asked-its-rates-of-those-that-turned-out)).
  Staff names are the identity module's.
* **Decision:**
  * **`confirmationAgents` says, for each agent over a period of work**, a year at most: the
    orders they confirmed; those they cancelled while they waited to be confirmed, as when the
    customer declined; their calls that settled nothing, by how they went; the hours of the
    shop's day in which they did any of it, their hours on the desk as their work shows them;
    and how the parcels of the orders they confirmed went, as they stand now, counted as COD
    health counts them, so that its return rate is the RTO rate of the orders they confirmed.
    The API adds the confirmation rate and confirmations an active hour. Those who settled most
    orders come first.
  * **An agent is whoever did the work**: a staff member, or an app by its access token, as an
    app confirming by WhatsApp would. Customers confirming through their links are no one's
    work. Agents are named by their IDs, which the admin app names from the shop's staff.
  * **Worked out when asked**, from the calls and the timelines, as COD health is from the
    orders; partial indexes find the confirmations and cancellations, and the calls, by when
    they happened (migration 0060).
  * **Owners and managers see it**, and apps with `read_orders`; agents see their queue, not
    how each of them did.
* **Consequences:**
  * A manager sees who confirms most an hour and whose confirmed orders come back, and coaches
    them; an agent who confirms everything shows a high return rate.
  * Hours on the desk are the hours in which an agent did something: a short break inside an
    hour is not seen, and nor is time on a call that settled nothing until it is recorded.
  * Not yet: the time an order waited before its first call, against the shop's SLA (COD-05);
    calls made from the admin app, timed; agents' names from the staff list in the report.
* **Alternatives:**
  * **Counters kept as agents work:** a second record of what the timelines and calls already
    say, to keep in step through cancellations and corrections.
  * **Agents' hours from sign-ins:** staff stay signed in all day; their work shows when they
    were on the desk.
  * **The outcomes of every order an agent called:** an agent who called once and another who
    confirmed would share an order's outcome; the confirmation is what an agent answers for.

## ADR-091 · A shop's Confirmation Desk keeps calling hours, outside which it deals out no order and after which an unanswered one falls due; an order waiting longer for its first call than the shop's target, counting those hours, is overdue

* **Context:** the Confirmation Desk deals out the orders waiting for their customers, the most
  urgent first, at any hour, and an unanswered one falls due again two hours on
  ([ADR-073](#adr-073--the-confirmation-desk-deals-orders-waiting-for-their-customers-to-agents-one-at-a-time-the-most-urgent-due-first-and-keeps-the-calls-that-did-not-settle-them)):
  at 20:30 that is 22:30, when no shop calls a customer, and an app that calls for the shop would.
  A shop also wants every order called soon after it is placed, as a customer who ordered a
  minute ago answers and one who ordered yesterday may have bought elsewhere: COD-05 asks for
  timers on that, the shop's confirmation policy, and its quiet hours. Shops keep their times in
  their own time zone.
* **Decision:**
  * **A shop may keep calling hours** (`orderSettingsUpdate`: `callingHours`), the same day's
    clocks in its time zone, an hour apart at least: "10:00" to "21:00". Outside them
    `confirmationQueueNext` deals out no order, and says when they open; the queue lists what
    waits all the same, and says whether it is calling time.
  * **An unanswered order falls due again in two hours, or when calling hours next open** if
    that is outside them. A time the customer asked to be called back at stands, whatever the
    hours.
  * **A first-call target** (`firstCallMinutes`, 5 to 1440): an order not yet called that has
    waited longer, counting calling hours alone, is `overdue`, and the queue counts them. An
    order placed at night starts waiting when calling hours open.
  * **Worked out when asked**: each day's hours as instants, from the shop's time zone, by
    Postgres; how long an order has waited, counted back through them from now. Nothing is
    stored but the settings.
* **Consequences:**
  * Agents and apps calling for the shop call within its hours, and unanswered orders come back
    in the morning rather than at night; a manager sees how many orders waited too long for a
    first call.
  * Calling hours are the same every day: no hours of their own on Fridays or holidays, and no
    window across midnight.
  * Not yet: giving up on customers who can't be reached, cancelling their orders after some
    days (COD-05); alerts when orders go overdue, with messaging; WhatsApp and IVR attempts in
    the shop's sequence (COD-01, COD-03).
* **Alternatives:**
  * **Due times moved into calling hours when an order is placed:** an order placed at night
    would be due at opening as stored, but changing the hours would leave the old times behind.
  * **The target counted by the clock:** an order placed at 23:00 would be overdue before the
    desk opens.
  * **Hours for each day of the week:** most shops call the same hours daily; a week of hours
    can come when a shop asks for it.

## ADR-092 · An order whose customer could not be reached is cancelled as many days after it was placed as the shop says, by a sweep in the worker, shop by shop and order by order

* **Context:** after three unanswered calls an order's customer could not be reached
  (`no_response`), and the desk keeps calling
  ([ADR-073](#adr-073--the-confirmation-desk-deals-orders-waiting-for-their-customers-to-agents-one-at-a-time-the-most-urgent-due-first-and-keeps-the-calls-that-did-not-settle-them)).
  Most such orders were never meant, or were bought elsewhere; while they wait they hold their
  stock and fill the queue. COD-05 asks for the shop's rule to give up on them. Nothing in Hatti
  ran on a timer: work followed requests or events.
* **Decision:**
  * **A shop may say after how many days to give up** (`cancelUnreachableAfterDays`, 1 to 30):
    an order still waiting for a customer who could not be reached that long after it was
    placed is cancelled, as could not be reached (`no_response`), by the system, its stock let
    go, with a line on its timeline and the order's events. None is given up on until the shop
    says.
  * **A sweep in the worker does it**, every ten minutes by default (`SWEEP_INTERVAL_MS`), under
    a role of its own (`sweeps`), so that it can run in one process however many handle events.
    It finds the shops that give up with the system login, which sees every shop, then cancels
    each shop's orders, the oldest first and a hundred at most a sweep, each in the shop's own
    transaction, checking again under its lock that the customer is still unreachable and the
    order still waiting.
  * **Sweeps in two workers at once do no harm**: an order cancelled by one is passed over by the
    other, under the order's lock.
* **Consequences:**
  * Orders nobody will take go back to stock on their own, and the queue keeps to customers who
    may answer.
  * An order the desk never called is never given up on: the rule is about customers who did not
    answer.
  * The worker now runs jobs on a timer; the next ones, such as alerts for overdue orders, join
    the sweeps.
  * Not yet: a message to the customer before their order is cancelled, with messaging.
* **Alternatives:**
  * **Cancelling as the desk deals orders out:** a shop that stopped using the desk would keep its
    stock held for ever.
  * **BullMQ's repeating jobs:** a timer is enough for a sweep that is safe to run twice; a queue
    can come when sweeps need spreading across processes.
  * **One transaction for a shop's sweep:** a hundred orders' stock locked at once, and one
    failure undoing every cancellation.

## ADR-093 · A claim on the courier that lost a parcel is the parcel's, followed until the courier pays it or refuses it; a statement's cash for a lost parcel pays its claim, filed or not

* **Context:** couriers lose parcels, and shops claim their worth from them, each courier its own
  way: a complaint number, weeks of waiting, then a payment, often in the next remittance
  statement, sometimes by cheque or transfer, or a refusal. A lost parcel is written off
  ([ADR-072](#adr-072--a-parcel-the-courier-lost-is-written-off-and-an-order-with-nothing-delivered-or-back-ends-at-a-stage-of-its-own-lost-before-reaching-the-customer-it-is-never-their-refusal)),
  but no claim was kept: what a courier paid for one came in its statement as cash on an order
  that owed nothing (`not_owed`), a line to look into
  ([ADR-067](#adr-067--couriers-remittance-statements-are-imported-whole-into-a-logistics-module-each-lines-cash-received-on-its-parcels-order-at-most-what-the-order-owes-and-a-parcels-cash-once)),
  and nobody could say which lost parcels were still unpaid for. Claims were left for couriers'
  APIs (spike 2), but the shop's side of them, what it claimed and what came of it, needs none.
* **Decision:**
  * **A claim is its parcel's**: a parcel the courier lost has one at most, kept with the parcel
    in the orders module, beside its loss (migration 0063): what is claimed, what was paid, a
    note, and when it was filed and settled. `fulfillmentClaimCreate` files it, at the parcel's
    worth, its items at their prices on the order, unless the shop says otherwise, up to the
    order's total. It is `open` until the courier pays or refuses it, or the shop withdraws it;
    a claim refused may still be paid or withdrawn; one paid or withdrawn is done with, though
    one withdrawn may be filed again.
  * **A statement's cash for a lost parcel pays its claim** (`compensated`), filed or not: one
    the shop had not filed is filed at the parcel's worth, or what was paid if more, and paid at
    once. The cash is the claim's, not the order's: a lost parcel's order owes nothing, and closed
    orders take no payments. A claim paid otherwise, or withdrawn, leaves the line to look into
    (`not_owed`). The import reads the parcels again once their orders are locked, as claims
    change only under their orders' locks, so that a claim settled by hand meanwhile is not paid
    twice. A statement keeps what of its cash paid claims (`compensated`), as it keeps what was
    received on orders; statements imported before pay their claims in the migration, as an
    import now would.
  * **`fulfillmentClaimSettle` records the rest**: paid otherwise than in a statement, with the
    amount, refused, with why, or withdrawn. A lost parcel that turns up and is checked back in
    has its claim withdrawn, unless it was paid.
  * **Each step is a line on the order's timeline**, and the parcel's events follow, as for any
    change to a parcel.
  * **`lostParcels` lists the lost parcels**, the longest lost first, with their worth and their
    claims, by claim (none yet, open, paid, refused, withdrawn) and by courier; the home counts
    those not claimed yet, at their worth, and the claims still open.
  * **Owners, managers and accountants claim**, as they reconcile couriers' cash; apps need
    `write_orders`.
* **Consequences:**
  * A shop sees which lost parcels it has not claimed, which claims its couriers still owe, and
    what they paid; statements' cash for lost parcels is no longer to look into.
  * What a courier pays is the claim's alone: what lost parcels cost, less what was recovered, is
    for the true profit report (ANL-03).
  * Not yet: claims for parcels that came back damaged, couriers' own claim processes through
    their APIs (spike 2), and the time couriers allow for claiming.
* **Alternatives:**
  * **Claims in the logistics module, beside statements:** a claim is about one parcel and
    changes with it, lost or turned up, and listing the lost parcels with their claims would read
    across modules.
  * **A claim filed for every parcel marked lost:** shops that do not claim, or settle with their
    couriers otherwise, would see claims open for ever.
  * **A statement's cash for a lost parcel received on its order:** the order is closed and
    voided; paid, it would read as sold.

## ADR-094 · A shop's advance may be asked only of customers new to it, and of orders its risk rules score high: such an order is asked it instead of waiting for review

* **Context:** a shop's advance may be asked above a total, in cities it names and of customers
  who refused parcels before
  ([ADR-089](#adr-089--a-shops-advance-may-be-asked-only-to-cities-it-names-and-of-customers-who-refused-parcels-before-checkout-names-every-city-and-says-of-whom-and-placing-applies-them-to-the-city-and-number-typed)).
  Shops ask the delivery charge up front of first-time customers above all (05 §4.4), and the
  risk decision's middle outcome is a partial advance (05 §5); but an order its risk rules
  score high could only wait for review, for staff to call
  ([ADR-025](#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)),
  and nothing asked an advance of a customer the shop had never delivered to. An order is scored
  as it is placed, in the orders module, from the customer's history and the address; checkout
  works out the advance before placing it, and an order asking one isn't scored, as the advance
  is the customer's say-so.
* **Decision:**
  * **Two more conditions on the advance**, each one more that the orders it asks must meet:
    only of customers new to the shop (`newCustomers`), none of whose orders it delivered
    before, by any of their numbers, as their delivery history counts them; only of orders the
    shop's risk rules score at least `riskScore` (0.01 to 1, kept as points from 1 to 100).
  * **An order scored that high is asked the advance instead of waiting for review**: checkout
    hands the orders module the advance with the score it needs (`riskAdvance`) rather than
    asking it outright; placing scores the order as any order paid on delivery, and if the score
    reaches it, the order asks the advance, waits for it, needs no call, and keeps its score and
    reasons, with a line on its timeline saying why ("Asks for Rs 500 in advance for its risk
    0.35 (medium). …"). Scored lower, it asks nothing, and the shop's hold for review applies as
    before; a blocked number is held whatever it asks.
  * **The page says of whom before anything is typed**, as it says the cities and refusals:
    "If no order from this shop has reached you before", "If the shop's checks on your order
    call for it", in English and Urdu. It looks nobody up and never takes such an advance off
    what the door collects before the order is placed. Placing counts the deliveries of the
    number typed with its refusals, in one look, only where the shop's rules ask.
  * The page's digest covers both conditions, so a change while it is open shows it again.
* **Consequences:**
  * Cash on delivery stays open to first-time and risky customers, with the delivery charge or a
    share ahead, rather than an order that waits for a call or is turned away; the score says
    why on the order.
  * An order asked an advance for its risk is not held for review: the advance is the check.
  * One advance still: of new customers in some cities and of risky orders everywhere cannot
    both be had, and drafts ask the advance staff set
    ([ADR-084](#adr-084--checkout-asks-for-the-advance-the-shops-rules-name-an-amount-a-share-of-the-items-or-the-delivery-charge-on-every-order-or-above-a-total-said-beside-cash-on-delivery)).
  * Not yet: prepaid alone above a higher score, and the OTP in the middle (05 §5), with
    messaging.
* **Alternatives:**
  * **Scoring the order in checkout, before placing it:** the customer may not exist yet, and the
    score would be worked out twice, once to decide and once to keep.
  * **The shop's hold threshold as the advance's:** a shop could not hold the riskiest orders
    for review and ask an advance of those a little less risky.
  * **"First order" as no order at all:** a customer whose earlier orders were cancelled or
    refused never received one; delivered is what trust follows.

## ADR-095 · The setup checklist is worked out when asked from what each module keeps, in one transaction: a step is done while what it asks for holds

* **Context:** a new shop's first half hour decides whether it sells (F1 in
  docs/design/03-key-user-flows.md: "Your store is 4/6 ready"). ONB-02 asks for a guided
  checklist: products, delivery, payments, going live. What each step asks for is already kept,
  module by module: products and their status, delivery settings, the bank account, policies, the
  brand's logo, the WhatsApp number and the storefront's password. Nothing records that a step
  was done, and a step done can be undone: the last product drafted, the store closed.
* **Decision:**
  * **The checklist is worked out when asked** (`setupChecklist`), in one transaction, from each
    module's own reads that take the caller's transaction: products on sale (`activeProductsIn`,
    new in the catalog), delivery settings saved, the bank account given (transfers, Raast and
    advances need it; cash on delivery needs nothing), the refund, privacy and shipping policies
    and terms of service written, a logo, a WhatsApp number, and the storefront open. Nothing is
    stored: a step is done while what it asks for holds, and undone when it no longer does.
  * **Steps are keys, in the order a shop is asked them**, each with whether it is done and, for
    a step of many things, how far along it is: products on sale, policies of the four written.
    The admin app words each in English and Urdu; the API says none.
  * **It lives in the core's API, beside the home**, as the home does
    ([ADR-060](#adr-060--cod-health-follows-a-periods-cash-on-delivery-orders-worked-out-from-them-when-asked-its-rates-of-those-that-turned-out)'s way of working things out when asked): it reads five modules and belongs
    to none. Owners and managers see it, and apps with `read_settings`.
* **Consequences:**
  * A shop sees what is left at a glance, and the checklist can never disagree with the shop.
  * A new step is a key and a read of its module's, through that module's public surface.
  * Not yet: connecting a courier and sharing the store (F1), with courier integrations and the
    admin app; and the admin app's words and the home's banner for new stores.
* **Alternatives:**
  * **Steps recorded as done by events:** a second account of state each module keeps, which a
    missed event or an undone step would put out of step.
  * **A checklist in each module:** no one place to ask, and the order of steps is the product's,
    not any module's.

## ADR-096 · Sales tax is included in prices, at a rate the tax module keeps: each order keeps the tax in it as it was placed, line by line and in its delivery

* **Context:** TAX-01 and CHK-17 ask for prices that include tax, and tax lines on receipts and
  invoices. Pakistan's consumer laws ask prices to be shown with their taxes, so the shelf price
  is what the customer pays ([03 §5](./03-multi-tenancy-and-data.md)). Sales tax on goods is 18%
  at the standard rate, less or none on some goods, and a registered seller's invoice says what
  of each price was tax. Shops on Hatti range from sellers not registered, who charge none, to
  registered ones. Nothing kept a rate, and orders said nothing of tax. The module map has a Tax &
  Compliance module for tax rules, FBR's invoicing and withholding
  ([01 §4](./01-system-overview.md)).
* **Decision:**
  * **A tax module keeps the shop's sales tax** (`@hatti/tax`, schema `tax`): a rate in
    hundredths of a percent, from 0.01% to 50%, or none, every shop's until it sets one; and
    whether its delivery charges and its fee for paying on delivery include it, as Shopify's
    `taxShipping`. `taxSettings` and `taxSettingsUpdate` need `read_settings` and
    `write_settings`; each change is an event and goes in the audit log. It is the start of the
    module map's Tax & Compliance: tax profiles, invoice series and FBR's digital invoicing join
    it.
  * **Prices include it, always.** A total is never more for the tax: the tax is what of it was
    tax. Shopify's `taxesIncluded` is always true, on the shop and on orders, and Liquid's
    `shop.taxes_included` and `cart.taxes_included` say so to themes. A variant is taxed unless
    the shop says otherwise, Shopify's `taxable` ("Charge tax on this variant"), which the product
    import reads from Shopify's "Variant Taxable".
  * **Each order keeps the tax in it as it was placed**, worked out in its transaction at the rate
    then (`orderTaxOf`): on each taxable line, what was paid for it after its share of the order's
    discount (a code's, staff's and paying by transfer's, shared by the largest remainder), amount
    × rate ÷ (100% + rate), rounded half up to the paisa line by line, as Shopify rounds; and on its
    delivery charge and fee where the shop's include them. Lines keep whether they were taxable,
    their rate and their tax; the order keeps the rate, the tax in all of it and the tax in its
    charges (migration 0065, whose checks keep them consistent). A new rate is for orders from
    then on.
  * **It is said where the total is.** Checkout's page says what of its total is tax once the
    total is known, worked out as placing will, and the placed page what the order kept; invoices
    and customers' order pages give a line per rate under the total, "Sales tax 18% (included)",
    in English and Urdu; the API gives Shopify's `taxLines` on orders and their lines, and
    `totalTax`; the export, Shopify's "Taxes", and each line's tax.
* **Consequences:**
  * A registered shop's receipts and invoices say the tax in them, and its totals stay what its
    prices say; a shop that charges none sees nothing of it.
  * Cash on delivery's cap, advances, fees and refunds keep their arithmetic: no total depends on
    the tax.
  * Not yet: rates by product beyond taxed or not (tax categories, the rest of TAX-01); prices
    that leave the tax out; drafts that show their tax before they are placed; refunds that say
    what of them was tax; reports that set it apart; and what FBR asks of registered sellers'
    invoices: their NTN and STRN, a series of numbers, and digital invoicing (TAX-02, TAX-04,
    TAX-05).
* **Alternatives:**
  * **Prices before tax, the tax added at checkout**, as Shopify does in the US: against the
    consumer laws' display rule, and a total that changes with the tax.
  * **The tax worked out when shown**, at the rate then: an invoice printed after a change of rate
    would disagree with the order agreed.
  * **The rate kept with the orders module's settings:** the tax rules, profiles and FBR's
    invoicing to come belong together, apart from orders.

## ADR-097 · Tax categories are the shop's codes with rates of their own, which variants name by Shopify's tax code; every other variant it taxes is at the shop's rate

* **Context:** TAX-01 asks for tax categories as well as prices that include tax
  ([ADR-096](#adr-096--sales-tax-is-included-in-prices-at-a-rate-the-tax-module-keeps-each-order-keeps-the-tax-in-it-as-it-was-placed-line-by-line-and-in-its-delivery)).
  Pakistan taxes some goods at reduced rates (the Sales Tax Act's Eighth Schedule) and some at
  none, so a shop that sells both needs each line at its own rate. Shopify sets other rates by
  overrides on collections, which its API doesn't expose, and keeps a tax code on each variant
  (`taxCode`, "Variant Tax Code" in its product CSV) for tax services to read.
* **Decision:**
  * **A category is a code, a name and a rate**, up to 20 a shop, kept with its tax settings and
    replaced whole through `taxSettingsUpdate` (migration 0066): codes of letters, digits, dots,
    dashes and underscores, each once in any letter case, and rates checked as the shop's is.
  * **Variants name categories by Shopify's tax code** (`ProductVariant.taxCode`, which the
    catalog keeps and the product import reads from "Variant Tax Code"). A taxable variant whose
    code is a category's is taxed at its rate, and any other at the shop's, as is a code that
    names no category. Categories apply only while the shop charges tax at all; delivery and the
    fee for paying on delivery stay at the shop's rate.
  * **Orders keep each line's rate** as they were placed, as they keep its tax: receipts,
    invoices and checkout's page give a line a rate, and the API's `taxLines` one a rate on the
    order and the line's own on each line.
* **Consequences:**
  * A shop that sells goods at two rates says so once, and every order and invoice follows.
  * The catalog doesn't know the tax module: a code is text to it, which the tax module reads as
    an order is placed. A category taken away leaves its code on variants, which are taxed at the
    shop's rate until it comes back.
  * Not yet: categories chosen on the admin's product screen, with the admin app; a rate of its
    own for delivery; exempt goods are variants not taxed, not a category at 0%.
* **Alternatives:**
  * **Rates by collection**, as Shopify's overrides: smart collections' members are worked out
    by rules, which placing every order would evaluate, and a product in two collections would
    have two rates.
  * **A category's ID on the product, kept by the catalog:** the catalog would depend on the tax
    module, and Shopify's exports bring codes, not IDs.

## ADR-098 · A parcel that came back with items written off as damaged is claimed from its courier for their worth, as a lost parcel is for its own; every claim is listed, the oldest first, to follow up

* **Context:** a parcel that comes back is checked in with each item restocked or written off as
  damaged ([ADR-071](#adr-071--a-parcel-coming-back-is-checked-in-by-the-tracking-number-on-its-label-matched-as-couriers-statements-are-those-on-their-way-back-are-listed-the-longest-first)):
  a torn seam, a wet box, a bottle broken on the way. Couriers pay for some of that damage, on
  their terms, as they pay for the parcels they lose, and shops claim it the same way: a
  complaint number, weeks of waiting, then a payment or a refusal. Claims were kept for lost
  parcels alone
  ([ADR-093](#adr-093--a-claim-on-the-courier-that-lost-a-parcel-is-the-parcels-followed-until-the-courier-pays-it-or-refuses-it-a-statements-cash-for-a-lost-parcel-pays-its-claim-filed-or-not)),
  and listed only with them (`lostParcels`): a damaged return had nowhere to keep its claim, and
  following claims up meant looking through the lost parcels.
* **Decision:**
  * **A parcel that came back with items written off is claimed as a lost parcel is**:
    `fulfillmentClaimCreate` takes it, at the worth of what was written off (its items not
    restocked, at their prices on the order) unless the shop says otherwise, up to the order's
    total. One that came back whole is refused: nothing of it was written off. The claim is the
    same as a lost parcel's, kept with the parcel and settled the same way
    (`fulfillmentClaimSettle`), each step on the order's timeline ("Claimed Rs 3,400 from PostEx
    for the damaged items of the returned parcel PX10293847"). A lost parcel that turned up, its
    claim withdrawn as it was checked in, may be claimed again for what of it was written off.
  * **Only a lost parcel, or one that came back, has a claim**, which the database checks
    (migration 0067): neither changes again, so a claim never has to follow its parcel anywhere.
  * **Couriers' statements pay lost parcels' claims alone.** Cash on a lost parcel is for its loss
    and nothing else; cash on a parcel that came back may be the courier's mistake, a charge
    given back or the claim, so it stays a line to look into (`not_owed`), and the shop records
    it on the claim once it knows (`fulfillmentClaimSettle`, PAID).
  * **`parcelClaims` lists every claim, the oldest first**, lost or come back damaged, by status
    and by courier: those still open, or refused, are the ones to follow up. Its cursor keeps when
    a claim was made to the microsecond, as the database does, and the parcel's ID: at the
    millisecond a JavaScript date keeps, claims made within one would come again on the next page.
    A partial index keeps it to the parcels with claims. The home's open claims count both kinds;
    lost parcels not claimed yet stay a count of their own.
* **Consequences:**
  * A shop claims what couriers damaged as it claims what they lost, and follows every claim up in
    one list, the oldest first.
  * The home doesn't count parcels that came back damaged as ones to claim, as it counts lost
    parcels: whether damage is the courier's to pay is the shop's call, parcel by parcel, by how
    it was packed and by the courier's terms, and the count would stand for work often not there.
  * Not yet: photos of the damage kept with its claim, couriers' own claim processes through their
    APIs (spike 2), and the time couriers allow for claiming.
* **Alternatives:**
  * **A claim for each damaged line, in a table of its own:** couriers take a claim a parcel,
    whatever was in it, and a second table would be a second way to settle the same thing.
  * **Statements paying claims on parcels that came back:** such cash is rare and may be for
    anything; paid to the claim, it would read as settled when it was not.
  * **`lostParcels` widened to the damaged returns:** it lists lost parcels with their worth,
    claimed or not; a parcel that came back belongs in a list only once claimed, and following
    claims up is a list of claims.

## ADR-099 · An order paid on delivery that the shop's risk rules score at its limit or above is not taken at checkout: placed, scored and undone, its page asks for a transfer instead

* **Context:** the risk decision's last outcome before blocking is prepaid alone (05 §5): above a
  high score, a shop takes an order only paid ahead. A shop may ask an advance of orders its risk
  rules score high
  ([ADR-094](#adr-094--a-shops-advance-may-be-asked-only-of-customers-new-to-it-and-of-orders-its-risk-rules-score-high-such-an-order-is-asked-it-instead-of-waiting-for-review)),
  but nothing kept cash on delivery from the riskiest, whose advance a refusal at the door would
  still cost. An order is scored as it is placed, in the orders module, from the customer's
  history, the address and the order itself
  ([ADR-025](#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)):
  checkout cannot know the score before placing, and placing writes the order, its customer and
  its stock before the score is known.
* **Decision:**
  * **A limit for risk in the shop's rules for cash on delivery** (`riskScoreLimit`, 0.01 to 1,
    kept as points from 1 to 100; migration 0068): orders scored at it or above are paid another
    way, as orders above the shop's total or from customers who refused parcels are
    ([ADR-075](#adr-075--a-shop-keeps-cash-on-delivery-to-the-orders-it-trusts-up-to-a-total-of-its-own-outside-cities-it-names-and-not-for-customers-who-refused-parcels-before-checkout-offers-transfer-instead)).
    Where the shop asks an advance by risk, the limit is above its score, which the database
    checks too: from the advance's score up, an order is asked the advance; from the limit up, it
    pays ahead.
  * **Checkout places the order, reads its score and undoes it**: an order paid on delivery
    scored at the limit throws in the order's transaction, as a refused discount code does
    ([ADR-063](#adr-063--a-shoppers-discount-code-is-kept-with-their-cart-and-counted-with-the-order-placed-with-it-in-the-orders-transaction)),
    and nothing of it is left, its number and its customer included. The page comes back with
    a transfer chosen where the shop takes one, saying "The shop asks for this order to be paid in
    advance. Pay by bank transfer to place it."; without one, that cash on delivery isn't
    available for the order. The shopper is not told what the shop's checks found, as a customer
    who refused parcels is not told why.
  * **The page says nothing of it before the order is placed**, as of the limit on refused
    parcels: it costs no one anything until it applies, and the score is not known before.
  * An order asked an advance whatever its risk is not scored, as before
    ([ADR-094](#adr-094--a-shops-advance-may-be-asked-only-of-customers-new-to-it-and-of-orders-its-risk-rules-score-high-such-an-order-is-asked-it-instead-of-waiting-for-review)):
    the advance is its customer's say-so, and the limit never applies to it.
* **Consequences:**
  * A shop takes its riskiest orders paid ahead and the rest as before: none of them waits for a
    call that a transfer would have settled.
  * The scoring runs for an order that is then undone, its stock committed and rolled back with
    it: a cost of the rare order, not of every one.
  * The shop sees nothing of the orders turned to a transfer, nor of those never placed after;
    the order paid by transfer is not scored. Not yet: telling the shop of them, and how many
    shoppers left at that point, with the admin app's analytics.
* **Alternatives:**
  * **Scoring the order before placing it**, in checkout: the customer and the order may not
    exist yet, and the score would be worked out twice, as ADR-094 found for the advance.
  * **Placing the order as a transfer at once**: its total changes without the shopper seeing
    it, losing the fee for paying on delivery and gaining what the shop takes off for paying by
    transfer, and the page they agreed to would not be the order placed.
  * **An advance of the whole order, kept as cash on delivery:** an order paid on delivery with
    nothing to collect at the door, charged a fee for paying there.

## ADR-100 · Staff sign in with a passkey alone, which passes the second factor, or answer the second step after their password with one; once an account has a second factor, only a session that passed one adds another

* **Context:** staff sign in with a password and, for owners, managers and accountants, an
  authenticator app's code ([ADR-020](#adr-020--staff-identity-built-in-house-on-audited-primitives)),
  which planned passkeys through `@simplewebauthn/server`. Passwords are phished and reused, and
  six digits are phished too: a passkey is bound to the site that made it, signs a fresh
  challenge, and verifies its user with a fingerprint, a face or the device's PIN. Shops' staff
  sign in on phones that keep passkeys already, synced by Google's or Apple's password managers.
* **Decision:**
  * **A passkey signs in alone** (`POST /auth/sign-in/passkey/options`, then
    `POST /auth/sign-in/passkey`): any passkey the browser holds for the site, discoverable, its
    user verified. Its user handle is the account's UUID, nothing personal, and must match the
    passkey's owner. The session has passed the second factor, as one with an app's code has:
    the passkey is something the user holds, and its verification something they are or know.
  * **After a password, a passkey answers the second step** as a code or a recovery code does:
    an account with a passkey or an authenticator app is asked for one (`mfa_required`, with
    `methods` and `passkeyOptions` naming the account's passkeys), and the passkey must be that
    account's.
  * **Adding a passkey** (`POST /auth/passkeys/options`, then `POST /auth/passkeys`) takes a
    session that passed a second factor once the account has one, as replacing an app does, and
    adding an app beside a passkey does too; at most 10. The account's first second factor comes
    with recovery codes, shown once. Removing one takes such a session as well, so that a stolen
    session cannot take its owner's way in away.
  * **Each challenge answers once, within 5 minutes**: kept in the identity schema (migration
    0069) and spent as it is answered, wrongly or not; expired ones go as new ones come. A
    passkey's counter must move on where its authenticator keeps one, as a copied passkey's
    wouldn't; synced passkeys keep none.
  * **Where passkeys belong** is configuration: the relying party (`PASSKEY_RP_ID`) and the
    origins staff sign in from (`PASSKEY_ORIGINS`), each on the relying party or under it,
    `PUBLIC_URL`'s host and origin unless set; attestation is not asked for.
* **Consequences:**
  * Staff can sign in with no password at all, phishing-resistant, and owners pass their second
    factor in the same step.
  * A lost passkey is replaced with a recovery code, or another passkey or app, as a lost phone
    with an authenticator app is.
  * Not yet: passkeys in the merchant app, which needs its Android and iOS origins in
    `PASSKEY_ORIGINS`; renaming a passkey; alerts when one is added; re-authentication for
    sensitive actions; which authenticator made a passkey (its AAGUID).
* **Alternatives:**
  * **Passkeys as a second factor alone, after the password:** the password would still be the
    way in that gets phished, and staff would type it on every phone.
  * **Asking for attestation:** it says which make of authenticator made a passkey, which
    synced passkeys mostly don't, and no rule here depends on it.
  * **Challenges in Valkey, expiring by themselves:** sign-in would then depend on Valkey, where
    rate limits are allowed to fail open; the identity schema keeps them beside what they guard.

## ADR-101 · Owners and managers invite staff by a link they send themselves, accepted once by a signed-in account; the owner manages every role but its own, managers those below them, apps none

* **Context:** staff belong to shops through memberships, with a role each
  ([ADR-020](#adr-020--staff-identity-built-in-house-on-audited-primitives)),
  but only the seed made any: a shop could not take on a packer, change what an agent does or
  let anyone go. Shopify invites staff by email; there is no email delivery yet, and shops here
  hire through WhatsApp, where a link travels best. Roles carry very different powers: managers
  and accountants see the money, owners everything.
* **Decision:**
  * **An invitation is a link with a role**: `staffInvitationCreate` returns its secret once
    (`hsi_…`, kept as a SHA-256 digest, migration 0070), with a note of whom it is for, good for
    7 days, 50 waiting at most a shop. The inviter sends the link themselves. Before anyone signs
    in, `POST /auth/invitations/preview` says the shop, the role and who invited them; signed in,
    `POST /auth/invitations/accept` makes the account a member in that role, once. The secret
    goes in the body, never in an address a log keeps. An account that works there already keeps
    its role, and the invitation stays unspent.
  * **The owner manages every role but its own; managers, those below them; others none**:
    inviting, taking an invitation back (`staffInvitationRevoke`), changing a role
    (`staffMemberRoleUpdate`) and removing someone (`staffMemberRemove`) each need the acting
    member to manage both the role they have and the one given. Nobody is made the owner this
    way, nobody changes their own role or removes themselves, and each change reads the acting
    member's role again under a lock. Apps manage no staff, whatever their scopes.
  * **A change takes effect at the member's next request**: access is resolved per request
    (`identity.resolve_staff_access()`), so a removed member is turned away at once, with no
    session to end.
  * **Each change goes on the shop's audit log** (`staff.invited`, `staff.invitation_revoked`,
    `staff.role_changed`, `staff.removed`), once it stands in the identity schema, and on the
    acting account's own record; accepting goes on the joining account's.
  * `staffMembers` and `staffInvitations` list them for the owner and managers.
* **Consequences:**
  * A shop takes on staff and lets them go by itself; the role presets
    ([ADR-100](#adr-100--staff-sign-in-with-a-passkey-alone-which-passes-the-second-factor-or-answer-the-second-step-after-their-password-with-one-once-an-account-has-a-second-factor-only-a-session-that-passed-one-adds-another) for how they sign in)
    say what each may do from their first request.
  * A link forwarded to someone else lets them join: it is the inviter's to send to the right
    person, as a WhatsApp group invitation is, and to take back if it went astray.
  * Not yet: invitations by email, a page of the core's at the link for those without the admin
    app, handing ownership over, suspending a member without removing them, custom roles.
* **Alternatives:**
  * **Inviting by email address, joinable only by that account:** no email delivery yet, and
    staff here often sign up with numbers or new addresses the owner doesn't know.
  * **Managers managing other managers:** two managers could remove each other; the owner is the
    one who decides who manages.
  * **The changes in GraphQL resolved inside the identity module:** it serves `/auth` alone and
    keeps no tenant context; the core's resolver authorises by the shop's role and writes the
    audit log, the identity module keeps memberships.

## ADR-102 · A customer's own data is one JSON file of everything the shop keeps of them, which each module with their data adds to; the blocklist and risk scores stay out

* **Context:** a customer may ask a shop what it keeps of them, as they may ask it to erase it
  ([11 · Security §7](./11-security-and-compliance.md#7-privacy)). The feature catalog's CUS-05
  has both, and erasure came first
  ([ADR-026](#adr-026--a-customer-can-have-several-numbers-modules-with-customer-data-join-merges-and-erasure)).
  What a shop keeps of a customer is spread over modules: the customers module keeps the profile,
  numbers and consent ledger; orders keep orders, drafts, parcels, refunds, calls to confirm and
  receipts; discount codes keep their uses. Some of it is the shop's defence against fraud, the
  blocklist and orders' risk scores, which a ring placing fake orders would learn to get past if
  it were handed them.
* **Decision:**
  * **`customerDataExport(id)` returns the file**, `customer-cus_….json`, JSON indented to be
    read, in one response, for an owner or manager to give the customer. Its `format`,
    `hatti.customer-data/1`, says how to read it. It takes `write_customers`, which only owners,
    managers and apps hold, and `read_orders`, since it holds orders.
  * **Each module with customer data adds its sections**, through the `CustomerDataHandler`
    merges and erasure already use: the customers module writes the profile (name, main and
    other numbers, email, note, tags, marketing consent per channel) and the consent history;
    orders add `orders` (items, amounts in major units, contact details, address, note, tags,
    what the customer agreed to and from where, parcels, refunds, calls to confirm, and the
    receipts they sent) and `draftOrders`, found as erasure finds them; discount codes add
    `discountCodeUses`. A section two modules give is a programming error, and nothing is given
    out.
  * **What goes in:** everything erasure would take from the customer, and the records it would
    keep while they still name them. It is read in one transaction that holds the customer's row
    shared, so a merge or erasure of theirs under way finishes first.
  * **What stays out:** the shop's defences against fraud, the blocklist (which holds numbers,
    not customers) and orders' risk scores and reasons; orders' timelines, which hold the reasons
    for holds and repeat the rest; and which of the staff did what, which is theirs, not the
    customer's.
  * **Each export goes on the shop's audit log** as `customer.data_exported`, without its
    contents.
* **Consequences:**
  * A shop answers a customer's request with one call. A module that keeps customer data later
    implements `export` beside `erase`: the interface lets neither be left out.
  * The file is the shop's to read before sending: its staff's notes and tags are in it.
  * A customer with thousands of orders makes a file of megabytes in one response; a file kept
    in storage behind a link comes when one outgrows that.
  * Not yet: customers asking for it themselves, with customer accounts (CUS-02); request intake
    for those who ask Hatti; the files they uploaded, which are listed, not attached; the text of
    the policies they agreed to, whose versions are named by ID; and apps' data, which Shopify
    asks apps for with the `customers/data_request` webhook.
* **Alternatives:**
  * **Everything, the risk scores and blocklist included:** most privacy laws let a business keep
    back what would help someone get past its fraud checks, and a score's reasons do exactly that.
  * **CSV, as customer exports are:** a customer's data is nested, orders with lines, parcels and
    refunds, which CSV would flatten into several files or repeated rows.
  * **The core gathering the sections from each module's services:** the customers module would
    know nothing of a new module's data, and a new module could be left out without anyone
    noticing, as with merges and erasure before handlers.

## ADR-103 · Sensitive actions need staff to have proved who they are in the last 15 minutes, by signing in or confirming with the strongest factor their account has; apps are not asked

* **Context:** a staff session lasts up to 30 days, its access tokens refreshed all along
  ([ADR-020](#adr-020--staff-identity-built-in-house-on-audited-primitives)).
  Whoever holds one, at a phone left unlocked by the counter, a laptop left signed in or through
  malware that copied its tokens, can do all its role may, including what would hurt most and is
  hardest to undo: taking staff on or letting them go, changing the account customers pay into,
  carrying customers' data off, erasing a customer. GitHub's "sudo mode" and Shopify ask for
  proof again before such things.
* **Decision:**
  * **A session keeps when its user last proved who they are** (`authenticated_at`, migration
    0071): when they signed in, or re-authenticated since. Refreshing tokens leaves it. The Admin
    API gets it from `identity.resolve_staff_access()` as the staff actor's `authenticatedAt`,
    and `/auth/me` and every token response show it.
  * **Sensitive actions need it within 15 minutes** (`REAUTHENTICATION_WINDOW_MS`): the
    mutations marked `@RequireRecentAuthentication()` (`staffInvitationCreate`,
    `staffMemberRoleUpdate`, `staffMemberRemove`, `bankTransferSettingsUpdate`,
    `customersExport`, `ordersExport`, `customerDataExport`, `customerErase`) and, in `/auth`,
    setting up an authenticator app and adding or removing a passkey. Staff past it are refused
    with `REAUTHENTICATION_REQUIRED` (403): the whole request, before it runs and before its
    Idempotency-Key is spent, so the same request goes through with the same key once they have
    confirmed ([ADR-030](#adr-030--idempotency-keys-are-kept-in-postgres-per-caller-for-a-day)).
    The resolvers' guard refuses such mutations too, after scopes. Apps are not asked: there is
    no one at an app to ask, and its scopes are the shop's grant.
  * **Staff confirm with the strongest factor their account has**: `POST
    /auth/reauthenticate/options` says which, a passkey (with what `navigator.credentials.get()`
    takes, for their own), a code from their authenticator app, or the password of an account
    with neither, and `POST /auth/reauthenticate` takes one. A password is refused where the
    account has a second factor, and recovery codes are for a lost phone, not this. Confirming
    with a second factor marks the session as having passed one. Attempts are limited to 10 a
    user in 15 minutes, and each is on the account's activity (`reauthenticated`,
    `reauthentication_failed`).
* **Consequences:**
  * A session stolen or left open no longer takes a shop's staff, money or customers' data
    without its user's factor, and everyday work (orders, products, the Confirmation Desk) never
    asks.
  * The admin app reads `authenticatedAt` to ask before it sends, and meets
    `REAUTHENTICATION_REQUIRED` by asking and sending the same request again.
  * Staff whose role is refused an action outright, such as a marketer exporting orders, may be
    asked to confirm first and refused after.
  * Not yet: more actions on the list as their risks are weighed, such as domains; a window the
    shop sets; a second person's approval for the riskiest, such as payouts once money moves
    through the platform.
* **Alternatives:**
  * **The password every time:** safe, and tiresome for an owner doing several things in a row,
    who would stop using the features or keep the password on a note.
  * **The password beside a second factor:** a phished password with a stolen session would get
    through; the factor is what the thief lacks.
  * **Short sessions for everyone:** agents would be signed out mid-shift, though the risk is in a
    few actions, not in the session.
  * **A separate elevated token:** another secret to keep and send; the session's own time does
    the same with nothing new to carry.

## ADR-104 · The owner hands the shop to one of its managers who has a second factor, and stays on as a manager; the shop has one owner throughout

* **Context:** a shop has one owner, the membership a unique index allows one of, and the owner
  alone manages its managers; no invitation or change of role makes anyone the owner
  ([ADR-101](#adr-101--owners-and-managers-invite-staff-by-a-link-they-send-themselves-accepted-once-by-a-signed-in-account-the-owner-manages-every-role-but-its-own-managers-those-below-them-apps-none)).
  Yet shops change hands: a business is sold, a founder hands it to a partner or a relative, or
  the person who set it up was an employee. Shopify lets the owner transfer ownership to a staff
  member, confirming with their password.
* **Decision:**
  * **`shopOwnershipTransfer(staffMemberId)`**: the owner alone, never other staff or apps,
    having proved who they are in the last 15 minutes
    ([ADR-103](#adr-103--sensitive-actions-need-staff-to-have-proved-who-they-are-in-the-last-15-minutes-by-signing-in-or-confirming-with-the-strongest-factor-their-account-has-apps-are-not-asked)),
    hands the shop to one of its managers. The old owner becomes a manager and the new one the
    owner, from their next requests.
  * **Only to a manager with a second factor**: owners must pass one to open the shop, so a shop
    handed to someone without one would be shut to its owner; and a manager has been trusted
    with the shop's settings already.
  * **One owner throughout**: in one transaction, both memberships locked, the owner's first, the
    old owner steps down before the new one steps up.
  * **On the shop's audit log** as `shop.ownership_transferred`, from whom to whom, and on both
    accounts' activity.
* **Consequences:**
  * A shop changes hands without asking support. To hand it to someone new, the owner invites
    them as a manager first; the new owner decides whether the old one stays.
  * Not yet: a handover by support when the owner is gone for good, which needs Hatti to verify
    who is asking; the shop's plan, billing and payouts moving with it, once they exist.
* **Alternatives:**
  * **To any staff member:** a packer made the owner would meet the second-factor wall at once,
    and roles below manager have not been trusted with the shop's settings.
  * **An offer the new owner accepts:** safer against picking the wrong manager, but a shop with
    one waiting has two people who think it is theirs; the old owner stays on as a manager, and
    the new one can hand it back.
  * **The old owner leaving the shop:** the new owner can remove them in one step if that is the
    deal, while a mistaken handover with the old owner gone would need support.

## ADR-105 · A refund keeps its share of its order's sales tax: the order's tax in all it has refunded, less what the refunds before it gave back; the sales report adds up the tax its sales include

* **Context:** each order keeps the sales tax its prices include, as it was placed
  ([ADR-096](#adr-096--sales-tax-is-included-in-prices-at-a-rate-the-tax-module-keeps-each-order-keeps-the-tax-in-it-as-it-was-placed-line-by-line-and-in-its-delivery)),
  but refunds were amounts alone, and the sales report said nothing of tax: ADR-096 left both
  for later. A registered seller files its sales tax return each month from what it sold and
  what it gave back. Refunds here are money staff send back by hand, an amount and a method
  ([ADR-029](#adr-029--refunds-record-money-staff-sent-back-only-owners-and-managers-make-them)),
  not items returned, so nothing said what of a refund was tax.
* **Decision:**
  * **Each refund keeps the tax in it** (migration 0072): the order's tax in all it has refunded,
    this refund included, in proportion to its total and rounded half up, less what the refunds
    before it gave back; never less than nothing, nor more than the refund. Refunds that give
    back a whole order give back all its tax, however many there are. Refunds made before were
    worked out the same way, in the order they were made.
  * **The API gives `Refund.totalTax`, and `Order.currentTotalTax`**, what the order keeps after
    its refunds, as Shopify's `currentTotalTaxSet`. The refund's event and audit entry carry it.
  * **The sales report's `taxes`**: the tax its orders include, less that of the items that came
    back, each line's tax shared by its items, period by period. Prices include it, so it is part
    of the report's other amounts, never added to them (since [ADR-117](#adr-117--the-sales-report-leaves-out-the-sales-tax-its-amounts-include-as-shopifys-does-worked-out-from-the-tax-each-order-keeps-the-tax-said-apart-and-added-back-in-total-sales), taken
    out of them, and added back in total sales).
* **Consequences:**
  * A registered shop reads the tax its sales took in a period, and what its refunds gave back,
    from the API.
  * The proportion is exact for an order at one rate, and close for one mixing rates or with
    untaxed delivery: a refund doesn't say which items it was for.
  * The report counts the items that came back, as before, not refunds; refunds' tax is on the
    refunds.
  * Not yet: drafts' tax before they are placed; refunds by item, each with its line's tax; the
    credit notes FBR asks registered sellers for (TAX-05).
* **Alternatives:**
  * **Refunds by item, as Shopify's:** exact, but staff here refund amounts, often a delivery
    charge or part of a price, not items.
  * **Each refund's share rounded on its own:** partial refunds of a whole order could give back
    a paisa more or less than its tax.
  * **Gross sales without the tax, as Shopify reports included taxes:** every other amount here
    includes it, and one report without it would disagree with the orders it adds up (chosen
    since, in [ADR-117](#adr-117--the-sales-report-leaves-out-the-sales-tax-its-amounts-include-as-shopifys-does-worked-out-from-the-tax-each-order-keeps-the-tax-said-apart-and-added-back-in-total-sales), with total sales adding the tax back).

## ADR-106 · A draft says the sales tax its prices include: an open one's at the shop's rates now, as placing it would work it out; a completed one's as its order keeps it

* **Context:** orders keep the sales tax their prices include as they were placed, and checkout's
  page says it before the order is placed, worked out as placing will
  ([ADR-096](#adr-096--sales-tax-is-included-in-prices-at-a-rate-the-tax-module-keeps-each-order-keeps-the-tax-in-it-as-it-was-placed-line-by-line-and-in-its-delivery)).
  Drafts said none until they were placed: staff putting one together in a chat, and the
  customer confirming it through its link
  ([ADR-031](#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link)),
  saw a total without the tax in it, and the order then kept a tax neither had seen. ADR-096 left
  drafts' tax for later.
* **Decision:**
  * **An open draft's tax is worked out whenever it is read, as placing it then would**: at the
    shop's rates and its variants' taxable flag and tax code now, on each line after its share of
    the discount, and on its delivery charge where the shop's include it. A draft keeps no tax of
    its own, so a change of rate, or of a variant's tax code, is in it at once, as it will be in
    its order. A variant gone since is taxed at the shop's rate; placing the draft fails on it.
  * **A completed draft's is its order's**, as it was placed: an order's lines and charges don't
    change, so it stays what the order kept, whatever the shop's rate since.
  * **The API gives Shopify's `taxesIncluded`, `totalTax` and `taxLines` on drafts**, by rate,
    the lines' and the delivery charge's together. A page of drafts works theirs out at once,
    through the request's loaders: the shop's settings and the open drafts' variants read once,
    and the completed drafts' orders once.
  * **The link's page gives a line a rate under the total**, in English and Urdu, as orders'
    pages do. What the page showed includes the tax, so a page opened before the shop's tax
    changed shows the draft again, with the tax it includes now, rather than placing an order
    whose tax the customer did not see.
* **Consequences:**
  * Staff see in the chat, and the customer on the link, the tax the order will keep.
  * A draft's tax costs a read or two that the draft alone doesn't, only when asked for.
  * A page opened before this change and sent after it, a draft's or an order's, is shown once
    more, since what a page showed now includes the tax.
  * Not yet: each line's own tax on drafts, which their order's lines give once it is placed; a
    draft exempt from tax, as Shopify's `taxExempt`.
* **Alternatives:**
  * **The tax kept on the draft when it is saved:** a change of the shop's rate would leave open
    drafts saying a tax their orders won't keep, unless every change of rate rewrote them.
  * **Completed drafts' tax at today's rates too:** one way of working it out, but a completed
    draft would disagree with its own order once the rate changed.

## ADR-107 · A tenant transaction begins with its shop and limits set, in one round trip: begin and set_config sent as one simple query, the values written in once checked

* **Context:** request code does its work in tenant transactions (`db.tenant`), which began with
  drizzle's `begin`, then set the shop and the limits in a `set_config` statement of its own: two
  round trips before any work, each a hop through PgBouncer in production
  ([ADR-021](#adr-021--pgbouncer-transaction-pooling-with-no-session-state)). Spike 5 counted
  four round trips around a `select 1`, and listed folding the two as a follow-up. A statement
  with parameters goes on its own, in the extended protocol; only a simple query, which takes
  none, carries several statements.
* **Decision:**
  * **`db.tenant` begins its transaction itself**: it takes a connection from the pool and sends
    `begin; select set_config('app.shop_id', …, true), set_config('statement_timeout', …, true),
    set_config('idle_in_transaction_session_timeout', …, true)` as one simple query. The work then
    runs on drizzle's own transaction object over that connection, so savepoints and
    `tx.rollback()` work as before, and it ends with `commit`, or `rollback` if anything threw, as
    drizzle's transactions end.
  * **Values are written into that statement only once checked** (`tenantBegin`): the shop's ID
    must be a UUID, nothing but hex digits and hyphens, and the limits whole milliseconds.
    Everything else in the code base stays a parameter.
  * **A connection that fails while a transaction holds it is closed**, not handed to the next
    caller. Its errors between statements go to the transaction: the pool listens for idle
    connections' errors only, so with drizzle's transactions such an error went unheard and ended
    the process.
* **Consequences:**
  * A round trip less in every request's transactions. Around a `select 1`, the median fell from
    0.26 to 0.19 ms direct and from 0.40 to 0.30–0.32 ms through PgBouncer; the products page's
    from 2.93 to 2.86 ms direct and from 3.12 to 3.00 ms through PgBouncer, on the spike's dataset
    and machine. Across a network the saving is a network round trip.
  * No shop leaked across 34,965 interleaved transactions direct and 52,587 through PgBouncer, a
    tenth of them rolled back, while the control run still caught a session-level setting.
  * The code builds drizzle's `NodePgSession` and `NodePgTransaction` itself, through their
    public constructors. A drizzle upgrade that changes them fails the build, or the database
    tests, which count the round trips.
  * Cell-wide jobs' transactions (`db.system`) set nothing, and keep drizzle's own.
* **Alternatives:**
  * **`set_config` after `begin`, as before:** the extra round trip.
  * **The settings in the first statement of each transaction's work:** every first statement
    would need them, and one without would see no rows.
  * **Settings once per connection:** unsafe behind PgBouncer in transaction mode (ADR-021); the
    spike's control run shows them leaking to other callers.
  * **A function that begins the transaction:** functions can't.

## ADR-108 · Hot queries run as statements prepared by name, planned once per connection; every pooler in front of the application sets max_prepared_statements

* **Context:** every statement the application sends is parsed, rewritten under row-level
  security and planned each time it runs. Spike 5 found planning to be most of what RLS costs,
  and left prepared statements as a follow-up; ADR-021 ruled named prepared statements out, as
  session state that PgBouncer in transaction mode could not carry. PgBouncer 1.21 and later can,
  with `max_prepared_statements`: it prepares a client's statement on whichever server connection
  runs it. On spike 5's dataset, a products page's two statements in a transaction, through
  pgbench, took 1.50 ms over the extended protocol, as node-postgres sends them, and 0.98 ms
  prepared, directly; 1.66 and 1.09 ms through PgBouncer, with 30% to 49% more throughput at 8
  clients. Their generic plans, which Postgres may keep after five runs, are the same as the
  custom ones for shops of every size.
* **Decision:**
  * **`executePrepared(tx, sql)` runs a statement prepared by name** (`@hatti/db`): the name is
    a digest of its text, so each connection prepares it once and afterwards only binds and runs
    it. Values stay parameters, never written into the text.
  * **For hot queries only**, each checked first: its text takes a bounded number of shapes, and
    its generic plan suits every shop (`EXPLAIN (GENERIC_PLAN)` as `hatti_app` in a tenant
    transaction). First, the products statement (`loadProducts`): the admin's products list,
    newest first, and a product by ID, IDs or handle, as product pages and the storefront's read
    models load them. A collection's pages, sorted by price, position or title, are planned each
    time until their plans are checked.
  * **Every PgBouncer in front of the application sets `max_prepared_statements`** (200 per
    server connection, `db/pgbouncer/pgbouncer.ini`, and infrastructure code when it exists).
    Without it, a statement prepared on one server connection collides with or misses on
    another. A database test runs one from four callers at once through the pooler, which CI
    runs every test through, and fails without the setting. This amends ADR-021 for these
    statements alone.
* **Consequences:**
  * The products list's median fell from 2.81 to 2.23 ms directly and from 3.05 to 2.48 ms
    through PgBouncer, a fifth of the page, in the application's own code with one caller.
  * Each server connection keeps up to 200 prepared statements, and the driver the text of each
    it prepared on its connection: memory bounded by the hot queries' few shapes.
  * A query whose best plan depends on the shop must not be prepared: Postgres would keep one
    plan for all of them once it judged the generic plan no worse than the custom ones.
  * Next: the orders, customers and carts that requests read most, each checked the same way.
* **Alternatives:**
  * **Every statement prepared:** shapes without bound, such as lists of values and batch
    inserts, and generic plans for queries whose plan should depend on the shop.
  * **SQL `PREPARE` and `EXECUTE`:** session state, which transaction pooling cannot carry
    (ADR-021).
  * **`plan_cache_mode = force_custom_plan`:** would save parsing alone, not planning.

## ADR-109 · A customer's other numbers travel in a CSV column of their own: after the main number in exports, and in imports a new customer's or, on overwrite, in place of an existing one's

* **Context:** a customer can have up to ten other numbers, such as a second SIM, each theirs
  alone in the shop
  ([ADR-026](#adr-026--a-customer-can-have-several-numbers-modules-with-customer-data-join-merges-and-erasure)).
  Customer exports and imports carried main numbers only, so a shop moving its customers through a
  spreadsheet, or into another shop, lost the others. Shopify's customer export has no such
  column.
* **Decision:**
  * **Exports list them in an Other phones column**, after Phone: the customer's other numbers,
    oldest first, as people write them, separated by commas.
  * **Imports read the same column** (also Other numbers, Other phone numbers or Alternate
    phones), split at commas, semicolons or slashes. Each number is checked as a customer's other
    numbers are, as `customerUpdate` checks them: a Pakistani mobile, not the main number, at most
    ten. Within the file each number is in one row; in the shop it is no other customer's. A row
    that fails is reported at that column and left out, as other rows that fail are.
  * **A new customer gets the file's.** A customer already here keeps theirs unless the import
    overwrites, when a list takes the place of theirs, the numbers it leaves out no longer theirs.
    A blank cell, or one of nothing but separators, leaves a customer's as they are, as blank
    cells leave every field.
* **Consequences:**
  * Hatti's export imports into another shop with every number, each still one customer's.
  * A number moving between two customers in one file is refused the first time, since it is the
    other customer's until their row is taken; importing the file again moves it.
  * Not yet: a way to clear a customer's other numbers through a file.
* **Alternatives:**
  * **A column per number** (Other phone 1, 2 and so on): ten columns, mostly empty, and an
    order to each that people don't keep.
  * **Adding the file's numbers to a customer's on overwrite:** a number the shop removed would
    never go.

## ADR-110 · A customer's erasure can be asked for ten days ahead, and cancelled until then; the worker's sweep carries it out as the system, naming who asked

* **Context:** erasing a customer happened at once and could not be undone, and was refused while
  any of their orders was open
  ([ADR-026](#adr-026--a-customer-can-have-several-numbers-modules-with-customer-data-join-merges-and-erasure)).
  A shop answering a customer who asked to be forgotten had to come back once their orders had
  closed, and nothing could take back an erasure asked for in error, or by someone pretending to
  be the customer. ADR-026 left a waiting period with a cancel, as Shopify has, until the worker
  ran scheduled jobs; its sweeps now do
  ([ADR-092](#adr-092--an-order-whose-customer-could-not-be-reached-is-cancelled-as-many-days-after-it-was-placed-as-the-shop-says-by-a-sweep-in-the-worker-shop-by-shop-and-order-by-order)).
  [03 · Data §11](./03-multi-tenancy-and-data.md#11-data-lifecycle--privacy) asks for a
  customer's personal data to go within 30 days of their request.
* **Decision:**
  * **`customerErasureRequest(id)` asks for the customer's erasure in ten days**
    (`ERASURE_WAIT_DAYS`) and says when, as `erasureScheduledAt`. It takes `write_customers` and,
    from staff, a recent sign-in, as `customerErase` does
    ([ADR-103](#adr-103--sensitive-actions-need-staff-to-have-proved-who-they-are-in-the-last-15-minutes-by-signing-in-or-confirming-with-the-strongest-factor-their-account-has-apps-are-not-asked)).
    Asking again changes nothing: the first request's time stands.
  * **`customerErasureCancel(id)` cancels it** until then, with `write_customers` alone, and the
    customer stays. A customer's `erasureScheduledAt` says when theirs is due, or is null.
  * **A table, `customers.erasure_requests`**, holds one row per customer whose erasure waits:
    when it was asked for, when it is due, and who asked. The row goes with its customer, so an
    erasure at once takes it too.
  * **The worker's sweep carries out those due** (`CustomerErasures`, under the `sweeps` role,
    every `SWEEP_INTERVAL_MS`): it finds the shops with any as the system, then erases each
    customer in a transaction of their shop, once it holds them locked and their request is still
    there and due. It erases them as `customerErase` would. One with an order still open waits,
    and is tried again at each sweep until the order closes.
  * **The system erases, and the record names who asked.** Orders' timelines say the system
    erased the customer's details, since no one did at that moment; the `customer.erased` event
    and audit entry name whoever asked, and when (`requestedAt`). Asking and cancelling are
    events (`customer.erasure_requested`, `customer.erasure_cancelled`) and audit entries of
    their own.
  * **A duplicate whose erasure waits cannot be merged away**: its request would go with it, and
    the erasure never happen. Staff cancel it first, or keep that customer and merge the other
    into them.
* **Consequences:**
  * A shop answers a request to be forgotten once, whatever the state of the customer's orders,
    and has ten days to take back one made in error.
  * The customer's data goes within the 30 days unless an order of theirs stays open longer: a
    parcel still on its way, or coming back, holds it until it ends.
  * Merging a duplicate into a customer whose erasure waits adds the duplicate's data to what
    will go: the same person's.
  * The worker builds its own registry of the modules' customer data handlers, as the API's
    modules register theirs; a test holds the two lists equal, so a new module with customer data
    joins both.
  * Not yet: a list of the erasures waiting (since [ADR-116](#adr-116--the-admin-api-lists-the-erasures-waiting-the-soonest-due-first-with-their-customers-who-asked-stays-in-the-audit-log), listed), and a
    message to the customer when theirs is done, with messaging.
* **Alternatives:**
  * **Erasure at once alone, as before:** nothing to take back, and a second request once the
    customer's orders close.
  * **Erasing now what open orders don't need, and the rest when they close:** the courier still
    needs the customer's number and address, and the shop would have two erasures of one customer
    to follow.
  * **A delayed job per request in a queue:** the worker has no queue, and a table a sweep reads
    survives restarts, shows what waits and is cancelled by deleting a row.
  * **A column on the customer** (`erasure_due_at`): one table fewer, but who asked would sit on
    every customer's row.

## ADR-111 · Orders and carts are read through prepared statements too, each checked by the benchmark against shops of every size; a prepared page writes its size into its text

* **Context:** ADR-108 prepared the products statement, checked by hand, and left the orders,
  customers and carts that requests read most for next. Measured first, an order spends more
  time being planned than run: 0.35–0.6 ms planning against 0.2 ms running, and every change to
  an order answers with it; a page of 50 orders, 0.4 ms against 1.5 ms. Spike 5's dataset had no
  orders, customers or carts to check plans on, and Postgres keeps a generic plan only when it
  judges it no dearer than a shop's own, which no hand check showed.
* **Decision:**
  * **The benchmark's shops sell**: each gets a location with stock of most variants, about
    three customers for every four orders, orders over the last year at every stage with their
    lines and parcels, and shoppers' carts. Spike 5's 1,000 shops hold 724,204 orders, 543,267
    customers and 46,385 carts; their catalog is as spike 5 loaded it.
  * **`pnpm bench:db prepared` is the check**, run before preparing a statement and after
    changing one: it captures the statements the application prepares as the driver is asked to
    run them, then compares each one's generic plan (`EXPLAIN (GENERIC_PLAN)`, as `hatti_app` in
    a tenant transaction) with the plan Postgres makes for a small, a medium and a large shop's
    values, and shows how Postgres ran it over ten calls on one connection.
  * **Prepared now**, as each passed: an order by ID, orders by ID for loaders, and pages of the
    newest orders or of one stage's, risk level's or customer's, with or without a cursor; a cart
    by its secret, its variants (`snapshotsOf`, which placing an order reads too) and their stock.
    Searches, dates, filters together, exports and the Confirmation Desk's queries are planned
    each time.
  * **A prepared page writes its size into its text** (`literalLimit`), a whole number. Postgres
    plans a `LIMIT` it cannot see as a tenth of the rows, so it judged the generic plan of a
    shop's newest orders dearer than the shop's own, and planned every call. A page size is then
    a statement of its own: the API takes 1 to 250 rows, and the admin asks for one or two sizes.
    This amends ADR-108's rule that values go in as parameters, for page sizes alone.
  * **`runPrepared` prepares a Drizzle query** as `executePrepared` does SQL. A list of values goes
    in as one array parameter (`= ANY(…)`): `inArray` writes a parameter per value, a new text
    for every length.
  * **Customers' statements stay unprepared.** They plan in about 0.1 ms, Postgres went on
    planning them every call, and prepared, the customers page took 1.16 ms instead of 0.95.
* **Consequences:**
  * Medium shops, one caller, median, directly and through PgBouncer: an order went from 1.65
    to 0.49 ms and from 2.16 to 0.60 ms; the newest 50 orders from 3.66 to 2.69 and from 4.03
    to 2.84 (3.27 and 3.58 while the limit was a parameter); a cart from 2.44 to 2.26 and from
    3.23 to 3.00. Products and customers pages are as they were.
  * Every generic plan is the plan Postgres makes for small, medium and large shops alike. Postgres
    still chooses per connection, after five calls: it keeps the generic plan of an order and of
    the newest orders, and goes on planning some pages of smaller shops, such as their orders to
    confirm and the page after the first, whose own plans read fewer rows, and a cart's variants
    and stock, whose lists it cannot see the length of. Those still skip parsing and rewriting,
    most of what a cart saves.
  * A statement whose plan check fails is not prepared; a plan check is the benchmark's command,
    not a judgement made by hand.
  * Next: the loaders an order's page runs beside it, such as its customer and timeline, each
    checked the same way.
* **Alternatives:**
  * **`plan_cache_mode = force_generic_plan`:** it would apply to every statement with
    parameters, unnamed ones too, whose plans should depend on their values.
  * **Pages in a few sizes, rounded up:** fewer statements, but rows read only to be dropped.
  * **Customers' statements prepared as well:** slower, as measured.

## ADR-112 · An order waiting to be confirmed is scored again when its customer's history changes, by the worker; a score that makes it risky holds it, and a held order stays held

* **Context:** an order's risk is taken when it is placed and when its address changes
  ([ADR-025](#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)),
  so an order waiting for its call does not pick up a refusal of the customer's parcel that
  happens meanwhile. ADR-025 left re-scoring for the Confirmation Desk
  ([ADR-073](#adr-073--the-confirmation-desk-deals-orders-waiting-for-their-customers-to-agents-one-at-a-time-the-most-urgent-due-first-and-keeps-the-calls-that-did-not-settle-them)),
  which now deals such orders to agents: the agent should call about the customer as they are,
  and a shop that holds risky orders should hold one that a refusal makes risky.
* **Decision:**
  * **What changes a customer's history:** a parcel of theirs delivered, refused (starting back),
    back or lost; an order of theirs cancelled; another customer merged into them. The worker's
    `RiskRescoring` handles those events (`fulfillment.updated` with its status changed,
    `order.cancelled`, `customer.merged`) and asks the orders module to score that customer's
    waiting orders again (`rescoreRisk`).
  * **Which orders:** the customer's cash-on-delivery orders that are open, not yet shipped and
    scored, and still waiting to be confirmed or reviewed (`pending` or `needs_review`). A
    confirmed order keeps the score it was confirmed on, and one that asked for an advance waits
    for its money rather than a call.
  * **How:** by the same rules as at placement, on the history as it is now. The rule for a
    possible duplicate counts the customer's unshipped orders placed in the 6 hours before this
    one, as it did when it was placed.
  * **What follows:** a different score is kept with its reasons, the timeline says so as the
    system ("Scored again as the customer's history changed: risk 0.60 (high), was 0.25. …"),
    and `order.updated` names `risk`. A waiting order that the new score makes risky under the
    shop's policy, as the old one did not, waits for review as it would have when placed, the
    reasons on its timeline. An order held already stays held, whatever its new score: staff
    decide.
  * **Safe to repeat:** it reads the history as it is, locks the customer's waiting orders in one
    order, and changes nothing that is already so, so an event handled twice or late does no
    more.
* **Consequences:**
  * A refusal holds the customer's later order it makes risky, before an agent confirms it, and
    the agent who calls sees the score the customer has now.
  * It follows its event through the queue, so an order confirmed in the moment between keeps the
    score it was confirmed on.
  * Not covered: an order whose number moves to another customer leaves the first customer's
    waiting orders as they were until something else changes their history.
  * Not yet: a history across shops (COD-07's network tier), and confirmed orders not yet shipped
    flagged to staff when their customer refuses another parcel.
* **Alternatives:**
  * **In the transaction of the change:** every path that ends an order would lock and change the
    customer's other orders, and a refusal recorded at the door would wait on them.
  * **Scoring when read:** the basis of a hold would change after the decision (ADR-025).
  * **A sweep over open orders:** work for every customer every time, and late by its interval.

## ADR-113 · An erased customer's receipts leave storage too: the erasure records each order's receipt files in an event, and the worker removes them once it commits

* **Context:** a receipt for a transfer shows the customer's name and account, so erasing the
  customer deletes their receipts' records
  ([ADR-080](#adr-080--a-customer-sends-the-receipt-of-their-transfer-through-their-orders-page-in-a-form-the-core-reads-and-keeps-in-storage-by-order-the-shop-sees-it-with-the-order)).
  Storage kept their files: nothing signed a URL for them after, but the customer's data was
  still there, in R2, for as long as the shop lasted. The erasure runs in one database
  transaction, which storage can't join: a file deleted before the commit could be gone from an
  erasure that rolled back, and one deleted after could be missed if the process died between.
* **Decision:**
  * **The erasure records what to remove, in its transaction**: deleting an order's receipts, it
    appends an `order.receipts_erased` event naming their files' keys, one event per order.
    Nothing is recorded unless the erasure commits, and the outbox delivers what is recorded at
    least once.
  * **The worker removes them** (`ErasedReceipts`): each key under that order's receipts in that
    shop (`shops/{shop}/receipts/{order}/`), which every receipt's key is; a key elsewhere is left
    and logged. Removing a file already gone changes nothing, so a repeated or late event does no
    harm.
  * **The worker reads the API's storage settings** (`STORAGE_DRIVER`, the directory or the
    bucket and its keys), with the same checks, so the two name the same place.
* **Consequences:**
  * An erased customer's receipts are gone from storage moments after the erasure, by the worker,
    as their records went with it; an erasure that waited (ADR-110) does the same when the sweep
    carries it out.
  * The worker needs storage credentials that may delete. Locally both processes run from the
    core's directory, so `.storage` is one place.
  * A receipt can't be read while its file is going: its record is gone first.
  * Not yet: receipts customers send in a chat (with messaging), and a sweep that finds files no
    record names, such as an upload whose order refused it after a crash.
* **Alternatives:**
  * **Deleting the files in the erasure itself:** before the commit, an erasure that failed
    would leave records of files that are gone; after it, a crash would leave files no one
    removes.
  * **A table of files to remove, swept by the worker:** the same guarantee, with a table and a
    sweep where the outbox already delivers.
  * **A storage lifecycle rule:** R2 deletes by age or prefix, not by whose data a file holds.

## ADR-114 · A draft its customer confirms through its link keeps what they agreed to, as checkout's orders do: the page names the shop's policies above its button, and the order keeps their versions and where it was confirmed from

* **Context:** an order placed through checkout keeps what its customer agreed to: the versions
  of the shop's policies its page linked, and the address and browser it was placed from
  ([ADR-057](#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from)). An order taken in a chat is placed when its customer confirms the draft
  through its link ([ADR-031](#adr-031--draft-orders-keep-agreed-prices-and-hold-no-stock-customers-confirm-them-through-a-secret-link)), as surely their own doing, but it kept nothing: the page
  named no policies, so a shop whose customer refused the parcel, or asked for a return after
  the window, could show nothing they had agreed to.
* **Decision:**
  * **The draft's page says what confirming agrees to**, above its button, in English and Urdu,
    as checkout says it: the shop's policies, each linked where its storefront shows it and
    opening beside the page, but for its contact information, which promises nothing. Nothing
    when the shop has none.
  * **The order agrees only to what the page linked:** the page's digest covers the versions it
    linked, so a policy changed while the customer was there shows the page again, as a changed
    draft does.
  * **The order keeps it**, as checkout's orders do: the versions of the policies the page
    named, and the address and browser the confirmation came from, as the core sees them
    (`TRUST_PROXY` behind a proxy, as for staff sign-in). When is when the order was placed,
    which confirming does. Without policies, it keeps where it was confirmed from alone.
  * **A draft staff complete keeps none:** its customer agreed in the chat, not on a page.
* **Consequences:**
  * `Order.agreement` shows a draft's order's as it shows checkout's, the policies as they were
    then. The address and browser are the customer's data, as checkout's are: in the file of
    their own data, and cleared when they are erased.
  * The policies are linked at the shop's storefront on the platform's domain, as checkout
    links them; the storefront sends the customer on to the shop's own domain if it has one.
  * A policy saved while a customer fills in their address shows the form again, without what
    they typed, as a draft changed then does.
  * Checkout's limit on orders from one internet address
    ([ADR-087](#adr-087--checkout-takes-at-most-three-orders-a-day-from-one-mobile-number-and-twenty-an-hour-from-one-internet-address-counting-the-orders-it-placed-one-at-a-time))
    counts its own orders alone, as it does by number, now that drafts' orders keep addresses too.
  * Not yet: orders staff and apps place whose customers confirm them through the order's link
    ([ADR-032](#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order)). The order is placed before they agree, so when they agreed would be a
    time of its own to keep (since [ADR-115](#adr-115--an-order-staff-or-an-app-placed-keeps-what-its-customer-agreed-to-in-confirming-it-through-its-link-the-page-names-the-shops-policies-and-the-order-keeps-their-versions-where-it-was-confirmed-from-and-when), kept).
* **Alternatives:**
  * **A box to tick:** stronger evidence of assent, but one more tap at the step customers
    leave most, as for checkout.
  * **The policies as they were when staff made the link:** the customer reads them when they
    open the page, so a policy changed in between would be kept but never shown.
  * **The policies at the foot of the page, as checkout's are:** the sentence links those that
    bind; a footer would add the contact information alone.

## ADR-115 · An order staff or an app placed keeps what its customer agreed to in confirming it through its link: the page names the shop's policies, and the order keeps their versions, where it was confirmed from and when

* **Context:** an order its customer places through checkout, or by confirming its draft through
  the draft's link, keeps what they agreed to ([ADR-057](#adr-057--what-a-shopper-agrees-to-in-placing-an-order-is-kept-with-it-the-versions-of-the-shops-policies-its-checkout-linked-and-where-it-was-placed-from), [ADR-114](#adr-114--a-draft-its-customer-confirms-through-its-link-keeps-what-they-agreed-to-as-checkouts-orders-do-the-page-names-the-shops-policies-above-its-button-and-the-order-keeps-their-versions-and-where-it-was-confirmed-from)). An order
  staff or an app place, as from a phone call, is confirmed by its customer through the order's
  own link ([ADR-032](#adr-032--customers-confirm-or-cancel-cash-on-delivery-orders-through-a-link-that-then-follows-the-order)), and kept nothing: its page named no policies. Unlike a draft's,
  this order exists before its customer agrees, so the time it was placed is not when they did.
* **Decision:**
  * **The order's page says what confirming agrees to** while the order waits for its customer
    and keeps nothing they agreed to, as a draft's page says it: the shop's policies but its
    contact information, each linked at its storefront, in the page's digest.
  * **Confirming keeps it**, in the same transaction: the versions the page named, the address
    and browser the confirmation came from, and when (`agreed_at`, which orders placed through
    checkout or a draft's link take as they are placed). Migration 0074 dates the agreements
    kept before by when their orders were placed, and a check keeps the versions and the time
    together.
  * **An order that kept what its customer agreed to keeps it as it was:** one placed through
    checkout and waiting to be confirmed names nothing on its page, and confirming changes
    nothing of it. Cancelling through the link agrees to nothing.
* **Consequences:**
  * Every order a customer placed or confirmed themselves keeps what they agreed to, and
    `OrderAgreement.agreedAt` says when, which for these is when they confirmed it.
  * Staff who confirm an order themselves, after a call, record no agreement: the customer
    agreed to whatever the call said, which the order cannot show.
  * The customer's file of their own data carries when they agreed, beside where from.
* **Alternatives:**
  * **When as the order's confirmation:** the same moment for these orders, but not for an order
    placed through checkout and confirmed later, which agreed when it was placed.
  * **Asking at the first view of the page:** seeing the page agrees to nothing; confirming the
    order does.

## ADR-116 · The Admin API lists the erasures waiting, the soonest due first, with their customers; who asked stays in the audit log

* **Context:** a customer's erasure can wait ten days, which staff may cancel until then
  ([ADR-110](#adr-110--a-customers-erasure-can-be-asked-for-ten-days-ahead-and-cancelled-until-then-the-workers-sweep-carries-it-out-as-the-system-naming-who-asked)), and each customer says when theirs is due (`erasureScheduledAt`). Nothing
  listed them: staff could not see who would be erased this week, or find a request made in
  error, without opening every customer.
* **Decision:**
  * **`customerErasureRequests` lists them**, the soonest due first and then by customer, each
    with its customer, when it was asked for and when it is due, with `read_customers`, as the
    customer's own field is. The customer is shown as everywhere else, its number masked by role.
  * **Its pages carry the due time to the microsecond**, as the parcels' lists do: the platform's
    `exactTime` writes it in SQL and `decodeTimeCursor` refuses a cursor whose time is not exact
    or on no real day; the parcels' lists now use the same two.
  * **Who asked stays in the audit log**, as `customer.erasure_requested`, which only owners and
    managers read; the list names no staff.
* **Consequences:**
  * The admin's privacy screen can show what is coming and cancel what should not happen.
  * An erasure carried out or cancelled leaves the list at once; one that waits for an order to
    close stays on it, past its time, until the sweep carries it out.
* **Alternatives:**
  * **A filter on `customers`:** it pages newest first by ID; ordered by when they are due, the
    list is the one staff need.
  * **The requester on each entry:** a staff member's identity in a list read with
    `read_customers` alone, where the audit log keeps it for those who read it.

## ADR-117 · The sales report leaves out the sales tax its amounts include, as Shopify's does: worked out from the tax each order keeps, the tax said apart and added back in total sales

* **Context:** prices include the shop's sales tax ([ADR-096](#adr-096--sales-tax-is-included-in-prices-at-a-rate-the-tax-module-keeps-each-order-keeps-the-tax-in-it-as-it-was-placed-line-by-line-and-in-its-delivery)), and the sales report
  added it up apart (`taxes`, [ADR-105](#adr-105--a-refund-keeps-its-share-of-its-orders-sales-tax-the-orders-tax-in-all-it-has-refunded-less-what-the-refunds-before-it-gave-back-the-sales-report-adds-up-the-tax-its-sales-include)) but left it inside every other amount: gross
  sales, discounts, returns, net sales, shipping and fees. ADR-105 kept it so, for every amount
  to agree with the orders it adds up. But the report gives sales in Shopify's terms
  ([ADR-061](#adr-061--sales-are-reported-in-shopifys-terms-from-the-orders-when-asked-an-order-counts-on-the-day-it-was-placed-cancelled-ones-aside-and-so-do-its-items-that-came-back)), and Shopify's gross sales are prices before taxes, its net sales without
  them; a shop moving from Shopify, or its accountant, reads a net sales that includes tax as
  that much more sold. A sales tax return asks for the value of supplies without the tax too.
* **Decision:**
  * **Every amount but `taxes` leaves the tax out**, worked out from what each order keeps of it,
    never again from a rate:
    * gross sales: each line's total less the tax it includes at the rate the line was taxed at,
      rounded half up as the tax module rounds;
    * discounts: gross sales less what was paid for the items without their tax, the subtotal
      less the discount less the lines' tax, so that net sales are exactly what the items were
      paid without tax;
    * returns: the items that came back at the prices sold, less the tax that went back with
      them, as `taxes` leaves it out;
    * shipping and fees: less the tax of the charges, shared between the two in proportion.
  * **Total sales add the tax back**: net sales, shipping, additional fees and taxes, which come
    to what the orders were paid less the items that came back, as before.
  * The products that sold most are ranked by their sales without tax, and the average order
    value is gross sales less discounts without it, as Shopify's is.
* **Consequences:**
  * A shop that charges no tax sees the same report as before.
  * For one that does, gross and net sales are lower by the tax, and total sales the same.
  * Every amount but total sales differs from what the orders and the receipts show by their
    tax, which `taxes` says.
  * Discounts and returns carry a paisa's rounding each way against a rate applied to them
    alone: they are differences of kept amounts.
* **Alternatives:**
  * **Keeping the tax in, as ADR-105 did:** simpler, but not Shopify's terms, which the report
    promises.
  * **Each amount less the tax at the shop's rate now:** wrong for orders taxed at another rate,
    lines in categories, and orders placed before the rate changed.
