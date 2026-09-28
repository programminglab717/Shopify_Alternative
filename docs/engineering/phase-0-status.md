# Phase 0 · Engineering foundations: status

> **Last updated:** 2026-09-28 · Tracks the Engineering row of
> [Roadmap §2](../product/04-roadmap.md#2-phase-0--foundations-oct--mid-nov-2026).
> Change by change history, and the work in progress: [progress log](./progress-log.md).

## Summary

The monorepo, the data layer and one vertical slice are in place and tested end to end. An
authenticated Admin API request creates a product under row-level security, and the product's event
reaches a worker through the outbox. Staff sign-in and tracing are in. Spike 5 showed that
row-level security and PgBouncer transaction pooling hold up. It fixed what broke behind the
pooler, and CI now runs every database test through PgBouncer. The catalog has options, bulk
variants, images and collections. Stock is in: locations, levels per variant and location, an
append-only ledger, and the reserve, commit and fulfil operations checkout and orders will use,
which never sell a unit twice. Environments and IaC wait on the hosting decision.

| Deliverable (roadmap) | Status | Where |
|---|---|---|
| Monorepo | ✅ Done | pnpm workspaces and catalog, Turborepo, TypeScript (ESM), ESLint, Prettier |
| CI | ✅ Done | `.github/workflows/ci.yml`: format, lint, catalog check, build, typecheck, tests against real Postgres and Valkey (request-serving connections through PgBouncer, as in production), fresh migrate and seed |
| CD, environments, IaC | ⏳ Not started | Waits on the hosting decision (ADR-015 latency bake-off) |
| Observability | 🟡 Mostly done | OpenTelemetry traces and metrics over OTLP, one trace from API through the outbox to the worker, `shop_id` on spans, trace ids in logs, outbox and sign-in metrics, local Grafana stack. Not yet: Sentry, dashboards and SLO alerts, collector tail sampling (with the infrastructure) |
| Tenancy skeleton with RLS | ✅ Done | `db/migrations/0001_foundation.sql`, `@hatti/db` |
| Auth | 🟡 Mostly done | App access tokens with scopes. Staff sign-in: argon2id passwords with breach checks, TOTP with recovery codes, rotating refresh tokens, device list, role presets with MFA for owners, managers and accountants ([ADR-020](../architecture/13-decision-log.md#adr-020--staff-identity-built-in-house-on-audited-primitives)). Not yet: passkeys, email verification and password reset (need email delivery), staff invitations, re-authentication for sensitive actions, OAuth apps |
| Design tokens | ✅ Done | `@hatti/tokens`, with WCAG contrast tests for every text pair |
| Catalog and stock (ahead of the MVP) | ✅ Done | Options, variants, images and collections (CAT-01–04), and stock: INV-03 (quantities and adjustment ledger) and the tracking half of INV-01. Multi-location levels (INV-02) and the restock reason for INV-06 are in place for the features that use them |
| Spike 5: RLS and PgBouncer performance | ✅ Done: go | [Results](./spikes/05-rls-and-pooling.md). RLS keeps every listing plan and costs about 0.1 ms per transaction. PgBouncer adds about 0.03 ms per round trip, and serves 1,024 clients where direct connections fail at 128. Fixed: timeout startup parameters that PgBouncer refused, and the relay's `LISTEN` behind a pooler ([ADR-021](../architecture/13-decision-log.md#adr-021--pgbouncer-transaction-pooling-with-no-session-state)) |

## What exists

| Package | Purpose | Tests |
|---|---|---|
| `@hatti/ids` | UUIDv7 keys, typed public IDs (`prod_…`) | 12 |
| `@hatti/money` | Exact minor-unit money, allocation, rounding, PKR formatting | 24 |
| `@hatti/pk` | Mobile numbers, CNIC and NTN, IBAN, cities and provinces, Urdu and Roman Urdu search keys | 47 |
| `@hatti/config` | Validated environment configuration | 6 |
| `@hatti/crypto` | Secret encryption with key rotation, TOTP, base32, secret tokens | 35 |
| `@hatti/ratelimit` | Redis fixed-window rate limits; subjects hashed | 3 |
| `@hatti/logger` | JSON logging with secret and PII redaction, trace ids | 6 |
| `@hatti/tokens` | Colour, type, space and motion tokens, CSS variables, contrast checks | 37 |
| `@hatti/telemetry` | OpenTelemetry set-up with privacy-safe instrumentation | 3 |
| `@hatti/db` | Pools, tenant transactions with per-transaction limits, migrator, setup, Postgres error checks, disposable test databases (direct or through PgBouncer) | 23 |
| `@hatti/events` | Transactional outbox (one event or many per statement), relay (`SKIP LOCKED` with `LISTEN`/`NOTIFY` checked at start-up, poison-event isolation), BullMQ transport, trace propagation | 11 |
| `@hatti/api` | Tenant context, access tokens, scope guard (field resolvers too), input checks and mutation results, per-request batch loaders, shared GraphQL types | 10 |
| `@hatti/catalog` | Products with up to three options and 250 variants, bulk variant changes, variant cost and weight, images by URL, manual and smart collections: services, GraphQL API, events | 54 |
| `@hatti/inventory` | Locations with Pakistani addresses, stock levels, an append-only ledger with history, stock counts and adjustments, reserve, commit and fulfil for checkout and orders: services, GraphQL API, stock fields on products and variants, events | 33 |
| `@hatti/identity` | Staff accounts, passwords, two-step verification, sessions, shop roles | 25 |
| `@hatti/core` | Admin API (app and staff callers), `/auth`, worker, seed, health checks, telemetry wiring | 40 |

That is 369 tests. They cover:

* RLS isolation at the SQL level, including a shop setting that must not leak to the next
  transaction, and 400 interleaved transactions for two shops on four shared connections;
* cross-tenant probes through the API, including every catalog, stock and location mutation;
* stock that is never sold twice (20 buyers for 5 units), orders listing the same variants in
  opposite orders without deadlocking, and a location deactivation that waits for a sale in
  progress there;
* a page of products that reads all its variants' stock with one query;
* smart collections that follow product, variant and rule changes, and pages in every sort order;
* a migration that gives products created before options a "Title" option;
* concurrent relays that never publish an event twice, and a bad event that must not block other
  shops' events;
* refresh-token reuse detection and one-time TOTP codes;
* database role boundaries around identity data;
* a committed GraphQL schema snapshot.

One test starts the built API exactly as production does and checks the exported spans, so a
dependency upgrade cannot silently break tracing. CI runs everything against Postgres 17 and
Valkey 8, through PgBouncer 1.22. The suite also runs locally against Postgres 16, directly and
through PgBouncer.

`tools/db-bench` (`pnpm bench:db`) is the spike 5 benchmark. It loads 1,000 shops and runs
pgbench, the application's own code and leak checks, directly and through PgBouncer.

A manual run on 2026-09-27 went through setup, migrate, seed, starting the API and the worker, and
querying with a Roman Urdu search. A product created through the API reached the worker **3 ms**
after the request finished. Both processes shut down cleanly on SIGTERM. On 2026-09-28 migration
0005 went onto the development database, the seed stocked two locations, and the running API
reported each variant's stock and whether it can be sold online.

## Deliberate simplifications

Each item below is smaller than the target architecture on purpose, and each has a trigger for
revisiting it.

| # | Now | Target (architecture docs) | Revisit when |
|---|---|---|---|
| 1 | Outbox is one table, with a partial index on unpublished rows | Daily range partitions, dropped after 7 days | Before launch, or above about 1M events a day |
| 2 | `control.shops` lives in the application database | A control-plane database, replicated read-only into cells | When the control-plane service is built (MVP) |
| 3 | Admin product search uses `LIKE` over a normalised `search_text` column | Typesense with per-shop scoped keys | Storefront search (MVP), or a shop above about 10k products |
| 4 | Every API request looks up its token in Postgres | Short-lived cache with revocation fan-out | When token lookups show up in latency profiles |
| 5 | The worker wires handlers by hand, without NestJS DI | A NestJS application context shared with the API modules | When the first module handler needs module services |
| 6 | One BullMQ queue for all domain events | Separate queues and worker pools (`critical`, `integrations`, `messaging`, `bulk`, `indexing`) | When a second real consumer arrives |
| 7 | Tests use CI service containers | Testcontainers | Only if we need versions or topologies that service containers can't provide |
| 8 | No rate limiting | Cost-based GraphQL limits per app and shop (Shopify-style leaky bucket) | Before any third-party app gets a token |
| 9 | Product images keep their source URL; nothing fetches or resizes them yet | A media worker that fetches, checks and resizes into R2 (AVIF/WebP), with signed uploads | With the infrastructure (R2), before the storefront shows images |
| 10 | `Product.collections` loads per product, so a list asking for it runs one query per product | Batched loading per request, as stock fields already do (`@Loaders()`) | When an admin screen lists collections beside products |
| 11 | Stock holds (`reserved`) have no expiry of their own | Checkout holds that lapse after 15–30 minutes, released by a sweeper | With checkout, which owns its holds and calls `releaseReservation` |
| 12 | The first location stays primary; no transfers, purchase orders or low-stock alerts; history lives in one table | A primary chosen in settings; transfers (INV-04), purchase orders (INV-05), low-stock alerts (INV-01), monthly partitions for movements | Alerts with messaging (MVP); the rest with multi-location merchants (V1), or above about 10M movements |

## Next steps

1. **Observability, remaining:** Sentry for errors; Grafana dashboards and SLO burn-rate alerts
   (admin GraphQL p95 ≤ 500 ms, outbox lag, parked events, sign-in failures); the production
   collector with tail sampling, set up with the infrastructure.
2. **Environments and IaC:** after the latency bake-off, write Terraform/OpenTofu for one cell
   (managed Postgres, Valkey, Kubernetes), container images and a staging deploy from `main`.
3. **Spike 5 follow-ups:**
   * re-run the benchmark in the target cloud, with PgBouncer beside the API pods;
   * fold `set_config` into `BEGIN`, to save a round trip per transaction;
   * prepared statements for hot queries.
4. **Staff identity, remaining:** passkeys (`@simplewebauthn/server`), staff invitations,
   email verification and password reset once email delivery exists, and re-authentication for
   sensitive actions.
5. **Catalog and stock, remaining:** the media worker (fetch, check and resize images into R2,
   with the infrastructure), batched collection lookups for product lists, and low-stock alerts
   once messaging exists.
6. **Orders (MVP):** placing an order commits stock through `StockService` in the same
   transaction; cancelling releases it, shipping fulfils it, and RTO parcels are restocked or
   written off as damaged (INV-06).
7. **Spikes 1–4** (Liquid rendering, courier adapter SDK, WhatsApp confirmation, checkout
   sandboxes) build on these packages.
