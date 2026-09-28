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
append-only ledger, and reserve, commit and fulfil operations that never sell a unit twice.
Orders run end to end: staff and apps place them, which commits their stock; cash-on-delivery
orders are confirmed or cancelled; parcels ship, are delivered, or are refused and checked back
in with items restocked or written off; and orders close when they are paid or back. Every order
belongs to a customer, found by mobile number, whose profile shows what their orders add up to and
how they turned out. Orders from numbers on the merchant's blocklist wait for review, and so do
cash-on-delivery orders whose risk score, from transparent rules, reaches the shop's threshold.
Segments filter customers by who they are and what they ordered, in a query language close to
Shopify's, and marketing consent is kept per channel with a ledger of every change. Customers
come in from Shopify or a spreadsheet and go out as CSV. A customer can have several numbers;
duplicates merge, and a customer's data can be erased on request while the shop keeps its order
records. Staff other than owners and managers see customers' numbers masked; confirmation agents
reveal one when they call, and an audit log records it, with exports, merges and erasures.
Environments and IaC wait on the hosting decision.

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
| Orders (ahead of the MVP) | ✅ Done, first slice | Placing orders with per-shop numbers and committed stock, confirmation, cancellation that releases stock, edits, payment, search by number, mobile, tracking number or name, counts by stage, a timeline, and parcels: shipped, delivered, or refused and checked back in with restock or write-off. Cash-on-delivery risk scores with reasons, from transparent rules, and holds for review at the shop's threshold ([ADR-025](../architecture/13-decision-log.md#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)). Parts of ORD-01, ORD-02, ORD-03, ORD-10, COD-04 and COD-09; the MVP half of COD-06; INV-06. Not yet: courier booking (spike 2), confirmation messages (spike 3), refunds, invoices and bulk actions |
| Customers (ahead of the MVP) | ✅ Done, first slice | Phone-first profiles that orders find or create, with their orders, what they paid, their delivery history and the addresses they used, worked out from the orders ([ADR-023](../architecture/13-decision-log.md#adr-023--customer-order-stats-are-worked-out-from-orders-when-read)); the merchant's blocklist, whose numbers' orders wait for review; segments over customer and order fields, evaluated when asked for ([ADR-024](../architecture/13-decision-log.md#adr-024--segments-are-queries-evaluated-on-demand-over-fields-modules-contribute)); marketing consent per channel (WhatsApp, SMS, email) with an append-only ledger; CSV import (Hatti, Shopify or a spreadsheet) and watermarked, recorded exports; several numbers per customer, merging duplicates, and erasure on request that keeps the shop's order records ([ADR-026](../architecture/13-decision-log.md#adr-026--a-customer-can-have-several-numbers-modules-with-customer-data-join-merges-and-erasure)). numbers masked for every staff role but owners and managers, with a logged reveal for confirmation agents, and the shop's audit log ([ADR-027](../architecture/13-decision-log.md#adr-027--customers-numbers-are-masked-by-role-and-reveals-go-to-an-append-only-audit-log)). CUS-01, CUS-03, CUS-04, CUS-07, the erasure half of CUS-05 and the merchant half of COD-07. Not yet: a customer's own data export |
| Spike 5: RLS and PgBouncer performance | ✅ Done: go | [Results](./spikes/05-rls-and-pooling.md). RLS keeps every listing plan and costs about 0.1 ms per transaction. PgBouncer adds about 0.03 ms per round trip, and serves 1,024 clients where direct connections fail at 128. Fixed: timeout startup parameters that PgBouncer refused, and the relay's `LISTEN` behind a pooler ([ADR-021](../architecture/13-decision-log.md#adr-021--pgbouncer-transaction-pooling-with-no-session-state)) |

## What exists

| Package | Purpose | Tests |
|---|---|---|
| `@hatti/ids` | UUIDv7 keys, typed public IDs (`prod_…`) | 12 |
| `@hatti/money` | Exact minor-unit money, allocation, rounding, PKR formatting | 24 |
| `@hatti/pk` | Mobile numbers (and their masked form), CNIC and NTN, IBAN, cities and provinces, Urdu and Roman Urdu search keys | 48 |
| `@hatti/config` | Validated environment configuration | 6 |
| `@hatti/crypto` | Secret encryption with key rotation, TOTP, base32, secret tokens | 35 |
| `@hatti/ratelimit` | Redis fixed-window rate limits; subjects hashed | 3 |
| `@hatti/logger` | JSON logging with secret and PII redaction, trace ids | 6 |
| `@hatti/tokens` | Colour, type, space and motion tokens, CSS variables, contrast checks | 37 |
| `@hatti/telemetry` | OpenTelemetry set-up with privacy-safe instrumentation | 3 |
| `@hatti/db` | Pools, tenant transactions with per-transaction limits, migrator, setup, Postgres error checks, timestamps from raw queries, disposable test databases (direct or through PgBouncer) | 24 |
| `@hatti/events` | Transactional outbox (one event or many per statement), relay (`SKIP LOCKED` with `LISTEN`/`NOTIFY` checked at start-up, poison-event isolation), BullMQ transport, trace propagation, and the append-only audit log | 13 |
| `@hatti/csv` | CSV reading and writing: RFC 4180 quoting, byte-order marks, formula-safe cells | 7 |
| `@hatti/api` | Tenant context, access tokens, scopes and role presets, who sees customers' numbers, scope guard (field resolvers too), input checks (text, prices, tags, email, Pakistani mobiles) and mutation results, per-request batch loaders, shared GraphQL types | 14 |
| `@hatti/catalog` | Products with up to three options and 250 variants, bulk variant changes, variant cost and weight, images by URL, manual and smart collections: services, GraphQL API, events | 54 |
| `@hatti/inventory` | Locations with Pakistani addresses, stock levels, an append-only ledger with history, stock counts and adjustments, reserve, commit, fulfil and restock for checkout and orders: services, GraphQL API, stock fields on products and variants, events | 34 |
| `@hatti/customers` | Customers by mobile number, found or created by orders, with other numbers, search by number, its last digits or name, the blocklist, segments (a query language with typed fields other modules contribute, compiled to one SQL statement), marketing consent with its ledger, CSV import and export, merging and erasure that other modules take part in, numbers masked by role with a logged reveal: services, GraphQL API, events | 49 |
| `@hatti/orders` | Orders from staff and apps with Pakistani addresses and committed stock, per-shop numbers, confirmation, cancellation, edits, payment, parcels through delivery or return to origin, search, stage counts, timeline, customers' numbers hidden from packers; each order's customer, holds for blocked numbers, each customer's orders and what they add up to, order fields for segments, COD risk scores with reasons, holds at the shop's threshold and the policy, orders moved on a merge or kept without personal data after an erasure, and numbers masked by role with a logged reveal: services, GraphQL API, events | 49 |
| `@hatti/identity` | Staff accounts, passwords, two-step verification, sessions, shop roles | 25 |
| `@hatti/core` | Admin API (app and staff callers), `/auth`, the audit log's API, worker, seed, health checks, telemetry wiring | 61 |

That is 504 tests. They cover:

* RLS isolation at the SQL level, including a shop setting that must not leak to the next
  transaction, and 400 interleaved transactions for two shops on four shared connections;
* cross-tenant probes through the API, including every catalog, stock, location, order, customer
  and blocklist mutation;
* stock that is never sold twice (20 buyers for 5 units), orders listing the same variants in
  opposite orders without deadlocking, and a location deactivation that waits for a sale in
  progress there;
* a page of products that reads all its variants' stock with one query;
* orders numbered without gaps while several are placed at once and some run out of stock;
* orders placed at the same moment by a new number sharing one customer, and a number blocked by
  two requests at once getting one entry;
* a customer's delivery history across a completed, a delivered, a refused, a cancelled and a new
  order;
* risk scores from a customer's refusals (counted from when the parcel starts coming back),
  deliveries and a possible duplicate, with holds at the shop's threshold, and an address change
  that holds an order only when it makes the order risky;
* merging a customer's second SIM into their profile, after which that number's orders and
  refusals are theirs; erasure refused while an order is open, then orders kept for the accounts
  without the customer's details; consent-ledger functions that stay in the caller's shop;
* a migration run on a database with data in it, which the empty test databases cannot show;
* numbers masked for each staff role, a confirmation agent revealing one through the API and a
  packer refused, with the reveal in the audit log, which request code cannot change, and masked
  roles limited to whole-number searches;
* segment queries over every field type, including days counted in Pakistan time, customers with
  no orders under `NOT`, and error messages that point at the mistake;
* a consent ledger that request code cannot change or delete, and consent that starts again when
  a number or email changes;
* importing Shopify's customer export with the problems real files have, and a Hatti export that
  imports into another shop unchanged;
* parcels through every path, including an order split into a delivered parcel and a refused one,
  with stock and stage checked at each step;
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
reported each variant's stock and whether it can be sold online. Later that day migrations 0006
and 0007 went on, and the seed's seven orders came back through the API at every stage, from
waiting for confirmation to delivered and paid, and a refused parcel checked back in. Then 0008
and 0009 gave the development database's orders their customers, and a new seed's nine orders
came back with eight customers, their delivery history, and an order from a blocked number
waiting for review with the reason on its timeline. Migration 0010 went on next, and the seed's
four segments and a preview came back through the API with the customers they should have.
With 0011, the seed's customers came back with their consent, its history, and a segment of
WhatsApp subscribers. With 0012, the seed's ten orders came back scored through the API, and the
large order of the customer who refused a parcel was waiting for review at risk 0.70, with its
three reasons on its timeline; the shop's policy changed and came back through the API. Migration
0013 first failed on the development database, whose customers made the backfill leave checks
pending (the empty test databases had passed); fixed, and a migration test now runs it over data.
The seed's customer found by her second SIM came back with both numbers and her three orders, and
a customer erased through the API left their completed order with its total, stage, city and
province, and an `erased` timeline entry. With 0014, a number revealed through the API came back
in the shop's audit log, naming the access token that asked.

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
| 13 | A customer's order stats are worked out from their orders on every read, and a segment using order fields aggregates the shop's orders each time it runs; customers can't be sorted by those stats | A customers search index (Typesense) fed by order events, behind the same segment language ([ADR-023](../architecture/13-decision-log.md#adr-023--customer-order-stats-are-worked-out-from-orders-when-read), [ADR-024](../architecture/13-decision-log.md#adr-024--segments-are-queries-evaluated-on-demand-over-fields-modules-contribute)) | A shop above about 50k orders, or when segment counts show up in latency profiles |
| 14 | No tax lines; each order ships from one location; refunds happen outside Hatti | Sales tax (TAX-01), routing lines to locations (INV-10), refunds (ORD-09) | Tax and refunds in the MVP; routing with multi-location merchants |
| 15 | Order numbers come from one counter row per shop, so a shop's orders are numbered one at a time | Unchanged for normal shops; flash sales go through Drop Mode (ADR-019) | If numbering shows up as a wait in traces |
| 16 | Confirmation is recorded by staff or apps; no WhatsApp, SMS or call outcomes yet | The confirmation sequence and Confirmation Desk (COD-01, 02, 04) | With messaging (spike 3) |
| 17 | Parcels are marked shipped, delivered or refused by hand, with a free-text courier and tracking number | Couriers booked and tracked through adapters, with normalised statuses (SHP-01, 02) | Spike 2, the courier adapter SDK |
| 18 | Marking an order paid records the full amount at once; no COD remittance matching | Remittance statements reconciled against expected cash, per parcel (COD-10) | With courier integrations |
| 19 | A delivered parcel cannot come back yet | Customer returns and exchanges (ORD-07) | V1 |
| 20 | The blocklist and the risk rules hold orders for review; nothing refuses an order or asks for an OTP or an advance; the rules see only this shop's history, with fixed weights | The checkout risk decision: OTP, partial advance, prepaid only or a hard block (COD-03), a model trained on delivery outcomes (COD-06, V1), and a cross-store reliability tier (COD-07, Growth) | Checkout (MVP); the model once there are outcomes to train on (V1); the network tier after legal sign-off |
| 21 | Erasure happens at once when staff or an app ask; there is no request with a waiting period, and a customer cannot get their own data as a file; imports and exports carry main numbers only; a customer's addresses are where their orders went | Erasure requests that wait and can be cancelled, a customer's data export (CUS-05), other numbers in CSV, saved addresses | Scheduled jobs in the worker; the privacy work before launch; customer accounts (CUS-02) |
| 22 | Masking follows fixed role presets, and apps see numbers whole; the audit log is one table, and records reveals, exports, merges, erasures and the risk policy only | Custom roles with a PII-visibility permission, protected customer data scopes for apps, monthly partitions kept 24 months, and every sensitive action logged ([security §2.1](../architecture/11-security-and-compliance.md#21-merchant-staff)) | Custom roles (V1); the app platform; above about 1M entries a month |
| 23 | Segment dates count days in Pakistan time for every shop; segments have no behaviour fields and nothing reacts to someone joining one | A shop time zone setting; storefront behaviour fields; automations that evaluate membership per event | A shop outside Pakistan; storefront analytics; automations (V1) |
| 24 | Consent is recorded by staff and apps; no checkout box, keyword opt-outs, push consent or email double opt-in yet | Consent at checkout and on forms, "STOP" and "band karo" replies (MSG-09), push per device, confirmed email opt-in | Checkout and the storefront (MVP); messaging (spike 3) |
| 25 | Imports and exports run inside one API request, capped at 5,000 and 10,000 customers; imports bring profiles and consent, not addresses or order history | Background jobs with files in R2 and progress; the full Shopify migration (F10) | With the infrastructure (R2) and the migration tool |
| 26 | An order's risk is scored when it is placed and when its address changes; a refusal of the customer's other orders later does not re-score open ones ([ADR-025](../architecture/13-decision-log.md#adr-025--order-risk-is-a-snapshot-taken-when-an-order-is-placed-or-re-addressed)) | Re-scoring open orders on events that change the customer's history | With the Confirmation Desk (COD-04) |

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
6. **Orders:** bulk actions (ORD-05), invoices and packing slips (ORD-06) and refunds (ORD-09).
   **Customers, later:** a customer's own data export (CUS-05), erasure requests that wait and
   can be cancelled, and other numbers in CSV.
7. **Spikes 1–4** (Liquid rendering, courier adapter SDK, WhatsApp confirmation, checkout
   sandboxes) build on these packages.
