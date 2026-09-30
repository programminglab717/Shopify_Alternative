# Hatti: Pakistan's Commerce Operating System

> **Working name:** Hatti (Punjabi ہٹی, "shop"). It is a placeholder until branding is final.
> **Stage:** Phase 0 · Foundations. The plan is complete; the engineering foundation and a first
> vertical slice (Admin GraphQL API for products) are built and tested.

Hatti is an affordable alternative to Shopify for Pakistani merchants. It does everything Shopify
does (store builder, themes, checkout, payments, orders, marketing, analytics, POS, apps, APIs) and
is built for how Pakistan actually buys: **cash on delivery, WhatsApp, local couriers, wallets and
Raast, and Urdu**. Plans are priced in rupees, with **0% transaction fees**.

**Start here → [Executive Summary](./docs/00-executive-summary.md)** ·
**Developers → [Getting started](./docs/engineering/getting-started.md)**

---

## Quick start

```sh
pnpm install
docker compose up -d && cp .env.example .env
pnpm db:setup && pnpm seed   # prints an owner sign-in, an app token and its storefront
pnpm dev:api                 # http://localhost:4000/admin/api/2026-10/graphql
pnpm dev:storefront          # http://localhost:4100/, the sample shop in Hatti Base
```

| Path | Contents |
|---|---|
| [`apps/core`](./apps/core) | Modular monolith: Admin GraphQL API, worker (outbox relay, storefront publishing) |
| [`apps/storefront`](./apps/storefront) | Storefront renderer: Liquid themes within hard limits, over documents in Valkey |
| [`themes/hatti-base`](./themes/hatti-base) | The reference theme, in English and Urdu |
| [`packages/modules`](./packages/modules) | Bounded contexts: `catalog`, `inventory`, `orders`, `customers`, `online-store` (themes, menus and storefront preferences) and `identity` (staff sign-in) |
| [`packages/platform`](./packages/platform) | `db` (RLS tenancy, migrations), `events` (outbox), `api`, `telemetry` (OpenTelemetry), `documents` (printable pages), `storefront-data` (storefront documents in Valkey), `themes` (themes as the storefront reads them, and Theme Check), `crypto`, `ratelimit`, `csv`, `ids`, `money`, `pk` (Pakistan data), `config`, `logger` |
| [`packages/ui/tokens`](./packages/ui/tokens) | Design tokens with contrast tests |
| [`db/migrations`](./db/migrations) | Forward-only SQL migrations |

---

## Documentation

### Research

| Doc | What's inside |
|---|---|
| [01 · Market research](./docs/research/01-market-research.md) | Market size, digital adoption, COD reality, who sells online (with platform evidence), competitors, pain points, opportunities |
| [02 · Shopify benchmark](./docs/research/02-shopify-benchmark.md) | Shopify's 2026 features, pricing, what's unavailable in Pakistan, app TCO, agentic commerce, architecture lessons |
| [03 · Local ecosystem](./docs/research/03-local-ecosystem.md) | Payments (gateways, Raast, regulation), couriers (API matrix), WhatsApp/SMS, tax (FBR, withholding, e-invoicing), law, hosting and network |

### Product

| Doc | What's inside |
|---|---|
| [01 · Vision & strategy](./docs/product/01-vision-and-strategy.md) | Mission, problem, positioning, segments, personas, principles, competitive edge, KPIs, go-to-market, risks |
| [02 · Feature catalog](./docs/product/02-feature-catalog.md) | **268 features** in 24 domains, tagged PARITY / LOCAL / BEYOND and phased MVP → SCALE |
| [03 · Pricing & business model](./docs/product/03-pricing-and-business-model.md) | PKR plans, add-ons, revenue streams, savings vs Shopify, unit economics, partner programme |
| [04 · Roadmap](./docs/product/04-roadmap.md) | Phases with dates set around the Pakistani retail calendar, scope by feature ID, exit criteria, team plan |

### Design

| Doc | What's inside |
|---|---|
| [01 · Principles & design system](./docs/design/01-design-principles-and-system.md) | Design principles, Urdu/RTL content rules, colour and typography tokens (contrast-checked), components, accessibility |
| [02 · Information architecture](./docs/design/02-information-architecture.md) | Admin and mobile-app navigation, settings, storefront URLs, role-based access |
| [03 · Key user flows](./docs/design/03-key-user-flows.md) | 11 critical flows with diagrams and wireframes: onboarding, COD checkout, confirmation, bulk booking, reconciliation, returns, migration, Drop Mode |

### Architecture

| Doc | What's inside |
|---|---|
| [01 · System overview](./docs/architecture/01-system-overview.md) | Drivers, C4 diagrams, control plane vs cells, modules, runtime flows, evolution |
| [02 · Tech stack](./docs/architecture/02-tech-stack.md) | Choices with rationale, monorepo layout, module boundaries, runtime topology |
| [03 · Multi-tenancy & data](./docs/architecture/03-multi-tenancy-and-data.md) | Isolation layers, RLS, cells and shop moves, IDs, money, ERD, read models, search, analytics |
| [04 · Storefront, themes & edge](./docs/architecture/04-storefront-and-themes.md) | Performance targets, caching, Liquid-compatible themes, editor, i18n/RTL, SEO |
| [05 · Checkout & payments](./docs/architecture/05-checkout-and-payments.md) | Checkout flow, pricing pipeline, payment orchestration, COD risk, provider shortlist |
| [06 · Orders, fulfillment & logistics](./docs/architecture/06-orders-fulfillment-logistics.md) | The COD operating system: confirmation, courier adapters, tracking, NDR/RTO, reconciliation |
| [07 · Messaging & marketing](./docs/architecture/07-messaging-and-marketing.md) | Notification engine, WhatsApp/SMS/IVR, automations, conversion APIs, feeds |
| [08 · APIs & app platform](./docs/architecture/08-api-and-app-platform.md) | GraphQL APIs, webhooks, OAuth apps, extensions, Wasm Functions, migrations |
| [09 · AI & intelligence](./docs/architecture/09-ai-and-intelligence.md) | AI gateway, generative features, COD-risk ML, agent-ready commerce (MCP/UCP), evals, costs |
| [10 · Infrastructure & DevOps](./docs/architecture/10-infrastructure-and-devops.md) | Environments, topology, hosting decision, CI/CD, observability, cost model |
| [11 · Security & compliance](./docs/architecture/11-security-and-compliance.md) | Threat model, identity, data protection, PCI, trust & safety, compliance map |
| [12 · Scalability & reliability](./docs/architecture/12-scalability-and-reliability.md) | SLOs, capacity plan, Drop Mode, degradation matrix, DR, operational calendar |
| [13 · Decision log](./docs/architecture/13-decision-log.md) | 27 architecture decision records (ADRs) |

### Engineering

| Doc | What's inside |
|---|---|
| [Getting started](./docs/engineering/getting-started.md) | Setup, running the API and worker, trying the API, tests, troubleshooting |
| [Conventions](./docs/engineering/conventions.md) | Boundaries, tenancy rules, IDs, money, migrations, events, API design, testing |
| [Phase 0 status](./docs/engineering/phase-0-status.md) | What is built, deliberate simplifications and when to revisit them, next steps |
| [Progress log](./docs/engineering/progress-log.md) | Every change as it lands, newest first, and the work in progress |
| [Spike 1 · Liquid rendering](./docs/engineering/spikes/01-liquid-rendering.md) | What rendering a Dawn-class theme costs, how templates are held to limits, and how data reaches them |
| [Spike 5 · RLS and PgBouncer](./docs/engineering/spikes/05-rls-and-pooling.md) | What row-level security and connection pooling cost, what broke, and the rules that followed |

---

## Conventions

* **Feature IDs** (e.g. `COD-04`, `SHP-06`) come from the feature catalog and are used in the
  roadmap, specs and tickets. After editing the catalog, run `pnpm features:summary` to refresh
  its summary table (CI checks it).
* **Decisions** are recorded as ADRs in the decision log. Supersede them; don't rewrite them.
* **Evidence tags** in research docs (`[P]`, `[S]`, `[3P]`, `[U]`) show how well each fact is
  verified. Items marked `[U]` must be checked before they are used externally. Each research doc
  ends with a verification backlog.
* Diagrams are Mermaid and render on GitHub.

## Status of this work

This is v0.1 of the plan, compiled on 2026-09-27. Legal and tax points need confirmation by
Pakistani counsel. Prices, rates and third-party terms change often and must be re-verified before
commitments are made. Engineering progress is tracked in
[Phase 0 status](./docs/engineering/phase-0-status.md) and, change by change, in the
[progress log](./docs/engineering/progress-log.md).
