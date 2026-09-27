# 13 · Architecture Decision Log

> **Status:** Living document · **Last updated:** 2026-09-27
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
