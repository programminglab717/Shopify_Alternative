# Engineering progress log

> Newest first. Every change that lands on the branch gets an entry, and so does the work in
> progress. The current state of each roadmap deliverable is on
> [Phase 0 status](./phase-0-status.md); this log records how it got there and what was learned.

## In progress

### Spike 5 · Row-level security and PgBouncer · started 2026-09-28

**Goal.** Measure what row-level security (RLS) costs on the products listing, the busiest admin
read. Check that tenant transactions stay correct and fast behind PgBouncer in transaction mode,
the pooling design in [02 · Tech stack](../architecture/02-tech-stack.md). This is the go/no-go
spike 5 in [Roadmap §2](../product/04-roadmap.md#2-phase-0--foundations-oct--mid-nov-2026).

**Found so far**

* **The app cannot connect through PgBouncer today.** node-postgres sends `statement_timeout` and
  `idle_in_transaction_session_timeout` as connection startup parameters. PgBouncer rejects every
  such connection with `unsupported startup parameter: statement_timeout` (reproduced with
  PgBouncer 1.22). The timeouts have to be applied some other way.
* **The worker would lose outbox notifications behind a transaction pooler.** It runs `LISTEN` on
  `DATABASE_SYSTEM_URL`. Through a transaction-mode pooler, `LISTEN` lands on whichever server
  connection runs that statement, so wake-ups would be lost without any error. The relay would
  fall back to polling, 1 s later.
* **`LIKE` and the array operators (`@>`, `&&`) are not leakproof in Postgres.** Under RLS,
  non-leakproof conditions are checked only after the policy, so they cannot drive a trigram or
  GIN index. uuid and text equality and ordering are leakproof, so the current listing,
  pagination and handle lookups can still use their B-tree indexes. Query plans will confirm
  this.

**Next.** Load a benchmark dataset of 1,000 shops, from 20 up to 25,000 products each (about 450k
products). Then:

* run pgbench with and without RLS, directly and through PgBouncer;
* benchmark the real `ProductService.list` code;
* check that no shop setting leaks between clients sharing pooled connections;
* fix what breaks;
* write up the results as `spikes/05-rls-and-pooling.md`.

### Catalog depth · queued after Spike 5

Product options, media, collections, inventory (locations, stock levels, adjustments with a
ledger) and bulk variant updates.

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
