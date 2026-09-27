# 02 · Tech Stack

> **Status:** Draft v0.1 · **Last updated:** 2026-09-27
> Principle: **one primary language, boring infrastructure, portable building blocks.** Every choice
> below should be something a strong Pakistani engineering team can hire for, operate, and move to
> another cloud if costs or regulation require it.

---

## 1. Summary table

| Layer | Choice | Why | Alternatives considered |
|---|---|---|---|
| Primary language | **TypeScript** on Node.js LTS | One language across backend, storefront, admin, mobile and edge. Shared types and validation. Pakistan's largest developer pool (JS/TS/React). | Go (faster and cheaper to run, but a second language and a smaller local talent pool); PHP/Laravel (big local pool, but splits the stack and is weaker for edge/SSR) |
| Backend framework | **NestJS** (Fastify adapter) | Enforces modules/DI/guards conventions that suit a modular monolith with a growing team. Widely known locally. Fastify for throughput. | Plain Fastify (more control, less structure); AdonisJS; Encore.ts |
| API | **GraphQL** (NestJS code-first, Mercurius driver) plus a small REST surface | Shopify-style Admin and Storefront APIs; typed clients; cost-based rate limiting; persisted queries for storefronts | REST-only (simpler, but chattier for rich admin UIs); tRPC (internal only, not a public API) |
| Data access | **Drizzle ORM** + `node-postgres`, raw SQL where needed | SQL-close, typed, first-class support for RLS, CTEs, partitioning; no heavy engine | Prisma (heavier, less SQL control); Kysely (good; slightly fewer batteries) |
| Validation | **Zod** | Shared schemas across API, admin, mobile, checkout | Valibot, TypeBox |
| System of record | **PostgreSQL** (17+, 18 where offered) | Transactions, JSONB, RLS, partitioning, native `uuidv7()` in 18, mature managed offerings everywhere | MySQL/Vitess (Shopify's path, more ops); CockroachDB/Yugabyte (distributed, costlier, Postgres-compatibility gaps) |
| Pooling | **PgBouncer** (transaction mode) | Many API/worker pods, few DB connections; `SET LOCAL` for RLS works per transaction | RDS Proxy (pins sessions on `SET`) |
| Cache, queues, rate limits | **Valkey** (Redis-compatible, BSD licence) | BullMQ, sessions, read models, token buckets; cheaper managed tiers | Redis 8 (AGPL/commercial licensing), KeyDB |
| Background jobs | **BullMQ** + transactional outbox | Priorities, delays, repeatable jobs, per-queue rate limits (vital for courier and WhatsApp throughput) | pg-boss (transactional enqueue, but loads the primary DB); Temporal (powerful, heavy); Inngest/Hatchet/DBOS (promising; revisit in the Growth phase) |
| Event log (later) | **Redpanda** (Kafka API) | Replayable, high-volume streams for analytics and multi-service fan-out once needed | Apache Kafka (more ops), NATS JetStream (lighter, less ecosystem) |
| Search | **Typesense** (3-node HA) | Typo tolerance, facets, synonyms, curation, vector/hybrid search, scoped API keys for tenant isolation, low RAM/ops | Meilisearch (similar), OpenSearch (powerful but heavy), Postgres FTS (fine for admin search only) |
| Analytics store | **ClickHouse** | Columnar, cheap at billions of events, fast merchant dashboards and funnels | BigQuery/Snowflake (cost scales with queries), TimescaleDB |
| Object storage | **Cloudflare R2** | S3 API, **zero egress fees**, which matters for image-heavy fashion stores | S3 (egress costs), Backblaze B2 |
| Images | **imgproxy** (libvips) behind the CDN; `sharp` at upload | Predictable cost at scale; AVIF/WebP; smart crop | Cloudflare Images (simple, per-transformation pricing) |
| Edge | **Cloudflare**: CDN, WAF, Turnstile, Workers, KV, Durable Objects, Cloudflare for SaaS | PoPs inside Pakistan; custom-domain TLS at scale; programmable routing; waiting room on Durable Objects | Fastly (costlier, fewer local PoPs), AWS CloudFront |
| Theme engine | **LiquidJS** + Hatti tags/filters, Shopify-compatible objects | Pakistan has thousands of Shopify/Liquid developers; safe, sandboxable templating; theme portability | React Server Components themes (heavier JS, harder for no-code); Handlebars |
| Admin web | **React** + Vite, TanStack Router/Query/Table, React Hook Form | Rich SPA, installable PWA, fast builds | Next.js (SSR is not needed for an authenticated app) |
| Design system | **Hatti UI**: Radix primitives + Tailwind CSS v4 + CSS-variable tokens | Accessible primitives, RTL via logical properties, themable | MUI (heavier, harder to brand), Polaris (Shopify-specific) |
| Charts | **Apache ECharts** | Canvas rendering holds up on low-end phones; RTL; large datasets | Recharts (SVG-heavy), visx |
| Mobile (merchant, POS) | **React Native + Expo** | Android-first market; shared TS packages; OTA updates; Bluetooth printers via native modules | Flutter (second language), native Kotlin (slower to build both platforms) |
| Storefront JS | **Vanilla JS + Web Components** ("hatti.js", < 15 KB gz) | Fast on Rs 25k phones; theme-agnostic | Alpine.js, Preact islands (used in checkout) |
| Checkout UI | **HTML-first, progressive enhancement + Preact islands** (< 50 KB JS gz) | Still works when JS fails on bad networks; small bundles | Full SPA |
| Documents (PDF) | **Gotenberg** (headless Chromium) for invoices and packing slips; **ESC/POS** for thermal receipts | Correct Urdu Nastaliq shaping and bilingual layouts; bulk generation via queue | pdfmake/pdf-lib (weak complex-script shaping), Typst (promising; evaluate) |
| ML | **Python** (FastAPI, LightGBM/XGBoost, scikit-learn, MLflow) | Standard ML ecosystem for RTO-risk and forecasting models | ONNX models served from Node (possible later for latency) |
| LLM | **Anthropic Claude** via an internal **AI Gateway** | Strong multilingual/Urdu and tool-use capability; gateway gives quotas, caching and provider abstraction | Multi-provider routing is supported by the gateway |
| Wasm Functions (later) | **Rust + Wasmtime** runner, JS→Wasm via Javy | Sandboxed, metered merchant/app logic (discounts, shipping, COD rules) | V8 isolates (harder to meter deterministically) |
| Auth (staff) | **In-house Identity module on audited primitives** (argon2id, TOTP, rotating refresh tokens; passkeys via `@simplewebauthn/server`); see [ADR-020](./13-decision-log.md#adr-020--staff-identity-built-in-house-on-audited-primitives) | No separate IdP to run; fits our session model, migrations and role separation. better-auth was evaluated in the Foundations spike | better-auth, Keycloak/Zitadel/Ory (extra services to operate) |
| OAuth provider (apps) | **`oidc-provider`** (panva, OpenID-certified) | Standards-compliant authorisation server for the app platform | Hand-rolled OAuth (risky) |
| Feature flags | **OpenFeature SDK + GrowthBook** (self-hosted) | Flags plus experiments; vendor-neutral API | Unleash, LaunchDarkly (USD cost) |
| Observability | **OpenTelemetry** → Grafana stack (Prometheus/Mimir, Loki, Tempo) + **Sentry** | Vendor-neutral instrumentation; cheap self-hosting; good error UX | Datadog/New Relic (costly per host/GB in USD) |
| Infra as code | **OpenTofu/Terraform**, Helm, **Argo CD** (GitOps) | Reproducible environments and cells; auditable deploys | Pulumi |
| Compute | **Managed Kubernetes** in the primary region, Karpenter/cluster-autoscaler, spot for stateless pools | One deployment model for pools, workers and cells; portable across clouds | ECS/Fargate (simpler, AWS-only), plain VMs + Docker (cheap, less elastic) |
| CI/CD | **GitHub Actions**, Turborepo remote cache, container signing (Cosign), SBOM (Syft) | Fast affected builds; supply-chain hygiene | GitLab CI, Buildkite |
| Testing | **Vitest**, **Testcontainers** (real Postgres/Valkey), **Playwright** (E2E), **k6** (load), Storybook | Tests against real dependencies; realistic load tests for sale events | Jest, Cypress |

---

## 2. Monorepo layout

A single repository (pnpm workspaces + Turborepo) keeps shared types, design tokens and module
contracts in lock-step.

```text
hatti/
├── apps/
│   ├── core/                  # NestJS modular monolith; entrypoints: admin-api, storefront-api, checkout-api, worker
│   ├── control-plane/         # identity, shop directory, platform billing, partners, app registry (own DB)
│   ├── storefront-renderer/   # Liquid SSR service (stateless)
│   ├── checkout-web/          # HTML-first checkout UI (SSR + Preact islands)
│   ├── admin-web/             # React SPA / PWA
│   ├── theme-editor/          # visual editor (can live inside admin-web as a route bundle)
│   ├── merchant-app/          # Expo (Android/iOS)
│   ├── pos-app/               # Expo, offline-first (Growth phase)
│   ├── edge/                  # Cloudflare Workers: router, waiting room, event collector
│   ├── webhook-ingress/       # thin, highly available receiver for provider callbacks
│   └── ml-service/            # Python FastAPI: risk scoring, forecasting
├── packages/
│   ├── modules/               # one package per bounded context (catalog, inventory, orders, ...)
│   │   └── orders/
│   │       ├── src/public/    # the ONLY importable surface: facade, DTOs, events
│   │       └── src/internal/  # entities, repositories, handlers (import-forbidden outside)
│   ├── platform/              # db, tenancy, events/outbox, queue, cache, http-resilience, money, i18n, telemetry
│   ├── integrations/
│   │   ├── couriers/          # tcs, leopards, mnp, postex, trax, ... (one adapter each)
│   │   ├── payments/          # gateway adapters
│   │   └── messaging/         # whatsapp-cloud, sms-*, email
│   ├── theme-engine/          # LiquidJS setup, tags, filters, drops, theme-check linter
│   ├── ui/                    # Hatti design system (React), tokens, icons
│   ├── api-client/            # generated, typed GraphQL client
│   └── config/                # eslint, tsconfig, prettier presets (including boundary rules)
├── themes/
│   └── hatti-base/            # reference theme (open source), the "Dawn" equivalent
├── infra/
│   ├── terraform/             # cloud, network, DBs, Cloudflare
│   ├── k8s/                   # Helm charts / Kustomize overlays per environment and cell
│   └── argocd/
└── docs/                      # this documentation
```

### 2.1 Module boundary rules (enforced in CI)

1. A module may import another module **only** through `@hatti/<module>/public`.
2. A module may read and write **only its own tables**. Cross-module data comes from facades or
   events. A lint rule flags any Drizzle query that references another module's schema.
3. Modules communicate synchronously through facades (in-process calls) and asynchronously through
   **domain events** via the outbox.
4. `packages/platform/*` may not import from modules.
5. Integrations (`packages/integrations/*`) are called only by their owning module:
   Fulfillment owns couriers, Payments owns gateways, Messaging owns channels.

With these rules, any module can later be extracted into its own service by swapping the in-process
facade for an RPC client. In practice we only expect to extract when a module needs independent
scaling or a separate team.

---

## 3. Runtime topology per cell

| Deployable | Image | Scales on | Notes |
|---|---|---|---|
| `core-admin-api` | core | CPU, RPS | Admin GraphQL, merchant app, partner APIs |
| `core-storefront-api` | core | RPS | Storefront GraphQL, cart, customer accounts; heavy read-replica use |
| `core-checkout` | core + checkout-web | RPS | Highest priority; separate HPA; never shares nodes with batch work |
| `core-worker-*` | core | Queue depth | Separate pools: `critical` (orders, payments), `integrations` (couriers), `messaging`, `bulk` (imports/exports), `indexing` |
| `storefront-renderer` | renderer | RPS / CPU | Stateless; reads Valkey read models; horizontally scaled; spot-friendly |
| `webhook-ingress` | ingress | RPS | Minimal logic: verify → enqueue → 200 |
| `outbox-relay` | core | Lag | Leader-elected, one active per cell |
| `scheduler` | core | n/a | Cron-like repeatable jobs (tracking polls, reconciliations, abandoned carts) |

---

## 4. Versioning & support policy

| Component | Policy |
|---|---|
| Node.js | Track active LTS; upgrade within 3 months of a new LTS |
| PostgreSQL | Stay within the two newest major versions supported by our managed provider |
| Public APIs | Date-based versions released quarterly (e.g. `2026-10`), each supported for 12 months |
| Themes | Theme engine features are additive; breaking changes only with a new theme "architecture version" |
| Mobile apps | Support current and previous two app versions; forced update for security fixes |

---

## 5. Hiring map (year 1)

| Skill | Where used | Market availability in Pakistan |
|---|---|---|
| TypeScript/Node, NestJS | Core, workers, integrations | High |
| React/React Native | Admin, merchant app, POS | High |
| Liquid/Shopify theme development | Themes, theme engine compatibility, partner ecosystem | High (large freelancer base) |
| PostgreSQL performance | Data layer, cells | Medium; hire at least one senior |
| Kubernetes/SRE | Platform | Medium; one senior plus managed services |
| Python ML | Risk models, forecasting | Medium |
| Rust | Wasm runner (Scale phase) | Low; contract or train |
