# Phase 0 · Engineering foundations: status

> **Last updated:** 2026-09-27 · Tracks the Engineering row of
> [Roadmap §2](../product/04-roadmap.md#2-phase-0--foundations-oct--mid-nov-2026).

## Summary

The monorepo, the data layer and one vertical slice are in place and tested end to end. An
authenticated Admin API request creates a product under row-level security, and the product's event
reaches a worker through the outbox. Next come the parts that need infrastructure decisions: cloud
environments, IaC, observability and staff sign-in.

| Deliverable (roadmap) | Status | Where |
|---|---|---|
| Monorepo | ✅ Done | pnpm workspaces and catalog, Turborepo, TypeScript (ESM), ESLint, Prettier |
| CI | ✅ Done | `.github/workflows/ci.yml`: format, lint, catalog check, build, typecheck, tests against real Postgres and Valkey, fresh migrate and seed |
| CD, environments, IaC | ⏳ Not started | Waits on the hosting decision (ADR-015 latency bake-off) |
| Observability | 🟡 Partial | JSON logs with redaction, request ids, health and readiness probes. No OpenTelemetry, metrics or Sentry yet |
| Tenancy skeleton with RLS | ✅ Done | `db/migrations/0001_foundation.sql`, `@hatti/db` |
| Auth | 🟡 Mostly done | App access tokens with scopes. Staff sign-in: argon2id passwords with breach checks, TOTP with recovery codes, rotating refresh tokens, device list, role presets with MFA for owners, managers and accountants ([ADR-020](../architecture/13-decision-log.md#adr-020--staff-identity-built-in-house-on-audited-primitives)). Not yet: passkeys, email verification and password reset (need email delivery), staff invitations, re-authentication for sensitive actions, OAuth apps |
| Design tokens | ✅ Done | `@hatti/tokens`, with WCAG contrast tests for every text pair |
| Spike 5: RLS and PgBouncer performance | 🟡 Partial | Transaction-local `set_config` is pooler-safe by design; not yet benchmarked |

## What exists

| Package | Purpose | Tests |
|---|---|---|
| `@hatti/ids` | UUIDv7 keys, typed public IDs (`prod_…`) | 12 |
| `@hatti/money` | Exact minor-unit money, allocation, rounding, PKR formatting | 24 |
| `@hatti/pk` | Mobile numbers, CNIC and NTN, IBAN, cities and provinces, Urdu and Roman Urdu search keys | 47 |
| `@hatti/config` | Validated environment configuration | 6 |
| `@hatti/crypto` | Secret encryption with key rotation, TOTP, base32, secret tokens | 35 |
| `@hatti/ratelimit` | Redis fixed-window rate limits; subjects hashed | 3 |
| `@hatti/logger` | JSON logging with secret and PII redaction | 5 |
| `@hatti/tokens` | Colour, type, space and motion tokens, CSS variables, contrast checks | 37 |
| `@hatti/db` | Pools, tenant transactions, migrator, setup, disposable test databases | 19 |
| `@hatti/events` | Transactional outbox, relay (`SKIP LOCKED` with `LISTEN`/`NOTIFY`, poison-event isolation), BullMQ transport | 8 |
| `@hatti/api` | Tenant context, access tokens, scope guard, shared GraphQL types | 7 |
| `@hatti/catalog` | Products and variants: service, GraphQL API, events | 18 |
| `@hatti/identity` | Staff accounts, passwords, two-step verification, sessions, shop roles | 25 |
| `@hatti/core` | Admin API (app and staff callers), `/auth`, worker, seed, health checks | 26 |

That is 272 tests. They cover RLS isolation at the SQL level (including a shop setting that must
not leak to the next transaction), cross-tenant probes through the API, concurrent relays that
never publish an event twice, a bad event that must not block other shops' events, refresh-token
reuse detection, one-time TOTP codes, database role boundaries around identity data, and a
committed GraphQL schema snapshot. CI runs them against Postgres 17 and Valkey 8; they were also run locally
against Postgres 16.

A manual run on 2026-09-27 went through setup, migrate, seed, starting the API and the worker, and
querying with a Roman Urdu search. A product created through the API reached the worker **3 ms**
after the request finished. Both processes shut down cleanly on SIGTERM.

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

## Next steps

1. **Observability:** OpenTelemetry traces across API, Postgres, BullMQ and the relay; RED metrics;
   Sentry; then a Grafana dashboard for outbox lag and queue depth.
2. **Environments and IaC:** after the latency bake-off, write Terraform/OpenTofu for one cell
   (managed Postgres, Valkey, Kubernetes), container images and a staging deploy from `main`.
3. **Spike 5:** benchmark RLS overhead and PgBouncer transaction pooling on the products listing.
4. **Staff identity, remaining:** passkeys (`@simplewebauthn/server`), staff invitations,
   email verification and password reset once email delivery exists, and re-authentication for
   sensitive actions.
5. **Catalog MVP depth:** options, media, collections, inventory items and levels, and
   `productVariantsBulkUpdate`.
6. **Spikes 1–4** (Liquid rendering, courier adapter SDK, WhatsApp confirmation, checkout
   sandboxes) build on these packages.
