# Engineering conventions

> The rules the codebase follows, and why. Architecture background is in
> [02 · Tech stack](../architecture/02-tech-stack.md) and
> [03 · Multi-tenancy & data](../architecture/03-multi-tenancy-and-data.md).

## Repository layout

| Path | Contents |
|---|---|
| `apps/core` | The modular monolith: Admin GraphQL API (`src/main.ts`), worker (`src/worker.ts`), seed |
| `packages/platform/*` | Shared infrastructure: `ids`, `money`, `pk`, `config`, `logger`, `db`, `events`, `api` |
| `packages/modules/*` | One package per bounded context. So far: `catalog` |
| `packages/ui/*` | Design system. So far: `tokens` |
| `db/migrations` | Forward-only SQL migrations, applied in order |
| `docs` | Research, product, design, architecture and engineering documents |

## Packages and boundaries

* Everything is **ESM TypeScript** (`"type": "module"`, `NodeNext`). Relative imports end in
  `.js`.
* Packages are used **only through their entry points** (`package.json` `exports`). ESLint rejects
  deep imports such as `@hatti/db/src/…`.
* A module exposes **only `@hatti/<module>/public`**; `src/internal` is private. Other modules use
  its public facade and events, never its tables.
* `packages/platform/*` never imports from modules.
* Dependency versions live in the **pnpm catalog** (`pnpm-workspace.yaml`), and packages refer to
  them as `catalog:`. pnpm refuses releases younger than a day (`minimumReleaseAge`) and runs no
  dependency install scripts.
* NestJS and GraphQL are **peer dependencies** of library packages, so the app and its modules
  share one copy. Two copies of `@nestjs/graphql` would split its type registry.

## Tenancy

A leak between shops is the worst bug this platform can have, so isolation has three layers.

1. **The shop comes only from authentication.** Resolvers take `@CurrentTenant()`; no API accepts a
   shop ID as input.
2. **Queries filter by shop explicitly**, as in `where shop_id = tenant.shopId`.
3. **Postgres row-level security** enforces it anyway. Request code runs in
   `db.tenant(shopId, tx => …)`, which sets `app.shop_id` for that transaction only. The login
   `hatti_app` has no `BYPASSRLS`. Without a shop set, queries see no rows.

When you add a table:

* Add a `shop_id uuid NOT NULL` column and a primary key that starts with it:
  `PRIMARY KEY (shop_id, id)`. Every index starts with `shop_id` too.
* Call `SELECT platform.enable_tenant_isolation('<schema>.<table>')` in the migration. It enables
  and forces RLS, adds the tenant and system policies, and grants access.
* Reference other tenant tables with composite foreign keys `(shop_id, x_id)`, so a row can never
  point into another shop.
* Add a **cross-tenant test**: using shop B's token on shop A's IDs must give not-found. See
  `apps/core/src/api/api.e2e.test.ts`.

The `hatti_system` login sees every shop. Only cell-wide jobs get it, such as the outbox relay;
request-serving processes never do.

## IDs

* Primary keys are **UUIDv7**, generated in the application with `newId()` from `@hatti/ids`.
  They sort by time, which keeps B-tree inserts cheap.
* APIs expose **public IDs**: a type prefix plus Crockford base32, e.g. `prod_01m3ja7a10…`. Add
  new kinds to `ID_PREFIXES`. Decode input with `tryFromPublicId(id, 'product')`, which also
  rejects an ID of the wrong kind.

## Money

* Amounts are **`bigint` minor units** (paisa) plus a currency. Never use floats.
* Use `@hatti/money` for arithmetic, percentages (basis points, half-even rounding), splitting
  (largest remainder, so parts always add up) and parsing (`fromMajor('2,499.50', 'PKR')`).
* Display prices with `formatMoney()`, which groups digits the South Asian way:
  `Rs 1,25,000`.

## Pakistan-specific data

Use `@hatti/pk` instead of ad-hoc regular expressions:

| Need | Function |
|---|---|
| Mobile numbers, in any format and with Urdu digits | `parsePkMobile()`. Store the `e164` form |
| CNIC and NTN | `normalizeCnic()`, `normalizeNtn()` |
| Bank accounts | `normalizePkIban()` (mod-97 checked), `formatIban()` |
| City input | `findCity()`, `searchCities()`: aliases such as Pindi, Lyallpur, RYK, and Urdu names |
| Search and matching | `searchKey()`: unifies Arabic and Urdu letters, strips diacritics, folds Roman Urdu (qameez = kameez = kamiz) |

## Migrations

* Plain SQL in `db/migrations/NNNN_description.sql`, applied in order. Each file runs in one
  transaction.
* **Forward-only and immutable.** The migrator stores a checksum and refuses to run if an applied
  file changed. To fix something, add a new migration.
* Drizzle table definitions in modules mirror the SQL for typed queries. Each module has a test
  that selects every column, so drift fails CI.
* Migrations must work for a non-superuser owner, as on managed Postgres. Grant to the group
  roles `hatti_app_role` and `hatti_system_role`, never to login users.

## Domain events

* Record events with `appendEvent(tx, shopId, …)` **inside the transaction that makes the
  change**. They are published only if it commits (transactional outbox).
* Name them `<aggregate>.<past-tense verb>`, e.g. `product.created`. Keep payloads thin: IDs,
  changed field names and versions, not whole documents.
* Delivery is **at least once and not strictly ordered**. Handlers must be idempotent: deduplicate
  on the event `id`, and compare versions where order matters.

## GraphQL Admin API

* Versioned by date in the path: `/admin/api/2026-10/graphql`. The schema is committed as
  `apps/core/schema.graphql`, and a test fails on any unreviewed change.
* Authenticate with the `x-hatti-access-token` header. Tokens are `hat_` plus 43 random
  characters, and only their SHA-256 is stored.
* Declare scopes with `@RequireScopes('read_products')`. The guard runs on every resolver, so
  resolvers require authentication by default. `write_x` implies `read_x`.
* **Input problems are data, not errors.** Mutations return `userErrors { field code message }`
  with stable codes: `BLANK`, `TOO_LONG`, `TOO_MANY`, `INVALID`, `TAKEN`, `NOT_FOUND`.
* GraphQL errors carry `extensions.code`: `UNAUTHENTICATED` (HTTP 401), `ACCESS_DENIED`,
  `BAD_USER_INPUT` (malformed IDs, cursors or page sizes), and `INTERNAL_SERVER_ERROR`. In
  production, internal errors show only a request id; the details go to the logs.
* Lists are Relay-style connections: `first` (1–250, default 50), `after`, and
  `pageInfo { hasNextPage endCursor }`. Cursors are opaque.
* Money fields return `{ amount, currencyCode, formatted }`. Money inputs are decimal strings in
  the shop currency, e.g. `"2,499.50"`.

## Configuration, logging and privacy

* Every process validates its environment at startup with `@hatti/config` (zod) and exits with a
  list of problems. Error messages never echo the values, which may be secrets.
* Log with `@hatti/logger` (JSON). **Log IDs, not personal data.** Phone numbers, email, CNIC,
  addresses, tokens and passwords are redacted automatically, but only as a backstop.
* Requests carry an `x-request-id`, accepted from the caller or generated. It appears in every
  log line for that request and in the response.

## Testing

* **Vitest**, with real Postgres and Redis. Each test file creates and drops its own database with
  `createTestDatabase()` from `@hatti/db/testing`.
* Test behaviour through public interfaces: the service for module logic, and HTTP (`app.inject`)
  for the API.
* NestJS needs decorator metadata. Builds get it from `tsc` (`tsconfig.nest.json`); tests get it
  from Vite's transformer. `packages/platform/api` has a test that fails if it goes missing.
* In packages that use GraphQL, `vitest.config.ts` pins `graphql` to its CommonJS build, which is
  the one NestJS and Mercurius load. Two copies of graphql cannot share a schema.

## Style

* Prettier (single quotes, trailing commas, width 100) and ESLint. `any` is an error, and so is
  `console` outside CLI scripts.
* Comments say **why**, not what.
* Prefer plain functions and small classes. Use NestJS for HTTP, GraphQL and dependency injection
  in the app, not as a reason to wrap everything in providers.
