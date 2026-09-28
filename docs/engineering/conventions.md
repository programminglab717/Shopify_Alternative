# Engineering conventions

> The rules the codebase follows, and why. Architecture background is in
> [02 · Tech stack](../architecture/02-tech-stack.md) and
> [03 · Multi-tenancy & data](../architecture/03-multi-tenancy-and-data.md).

## Repository layout

| Path | Contents |
|---|---|
| `apps/core` | The modular monolith: Admin GraphQL API (`src/main.ts`), worker (`src/worker.ts`), seed |
| `packages/platform/*` | Shared infrastructure: `ids`, `money`, `pk`, `config`, `logger`, `telemetry`, `crypto`, `ratelimit`, `db`, `events`, `api` |
| `packages/modules/*` | One package per bounded context. So far: `catalog`, `identity` |
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

1. **The shop comes only from authentication.** An app token is bound to one shop. A staff
   request names its shop in `x-hatti-shop-id`, and authentication accepts it only if the user has
   an active role there. Resolvers take `@CurrentTenant()`; no GraphQL argument ever carries a
   shop ID.
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

### Queries under row-level security

Spike 5 measured these rules ([results](./spikes/05-rls-and-pooling.md)).

* **Filter by shop explicitly as well.** Postgres then reduces the policy to one check per query,
  a `One-Time Filter` in the plan, so row-level security costs next to nothing.
* **Only leakproof operators can use an index under row-level security.** Postgres applies the
  policy first. It lets a condition run before the policy, or inside an index scan, only if the
  operator cannot leak data through errors. Equality and ranges on uuid, text, numbers and
  timestamps are leakproof.
* **These are not leakproof:** `LIKE` and `ILIKE`, regular expressions, array and jsonb
  containment (`@>`, `&&`), and full-text search (`@@`). Postgres checks them row by row after
  the policy, even when a trigram or GIN index exists. It also cannot use column statistics for
  them, so its row estimates are guesses.
* So text search goes to Typesense (ADR-013). Filterable sets such as tags or collection
  membership are rows with a B-tree index, not arrays with a GIN index.
* Check the plan of any new list or search query with `pnpm bench:db explain` or `EXPLAIN` as
  `hatti_app` inside a tenant transaction. Checking as a superuser skips the policies and shows
  plans production will not get.

## Connection pooling

Request-serving processes reach Postgres through **PgBouncer in transaction mode**: each
transaction borrows a server connection and returns it at commit. CI runs every database test
this way (`DATABASE_POOLER_URL`), and `pgbouncer db/pgbouncer/pgbouncer.ini` runs the same set-up
locally on port 6432.

* **No session state.** Nothing may outlive a transaction: no `SET`, no `set_config(…, false)`,
  no `LISTEN`, no session-level advisory locks, no temporary tables and no named prepared
  statements. Use `set_config(…, true)` or `SET LOCAL`, as `db.tenant()` does. A session-level
  setting stays on its server connection, and PgBouncer hands that connection to other callers.
  The benchmark's control experiment shows it exposing one shop's rows to other requests.
* **No connection parameters.** PgBouncer refuses connections that send session settings, such
  as `statement_timeout`, when they connect. Timeouts come from two places instead:
  * each login's defaults (`LOGIN_DEFAULTS`: 15 s per statement, 30 s idle in a transaction),
    which `pnpm db:setup` sets locally and infrastructure code sets elsewhere;
  * each tenant transaction's limits (`transactionLimits` on the `Database`), set in the same
    statement as the shop. The Admin API allows 5 s.
* **Direct connections, only for:**
  * migrations and `db:setup`, which take session-level advisory locks;
  * the relay's `LISTEN` (`DATABASE_LISTEN_URL`). At start-up the relay checks that notifications
    arrive. If they don't, it logs a warning and polls.
  * operator tools.

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
* The relay isolates bad events. If the queue rejects one event while others get through, that
  event is retried and, after 10 attempts, **parked**: it stays unpublished with its `last_error`.
  To retry it, set its `attempts` back to 0. An outage of the queue itself never uses up attempts;
  the relay just backs off.

## GraphQL Admin API

* Versioned by date in the path: `/admin/api/2026-10/graphql`. The schema is committed as
  `apps/core/schema.graphql`, and a test fails on any unreviewed change.
* Two kinds of caller. **Apps** send `x-hatti-access-token: hat_…` (43 random characters; only
  the SHA-256 is stored). **Staff** send `Authorization: Bearer hsa_…` from
  [sign-in](#staff-sign-in) plus `x-hatti-shop-id: shop_…`; their role's preset decides the
  scopes.
* Declare scopes with `@RequireScopes('read_products')`. The guard runs on every resolver, so
  resolvers require authentication by default. `write_x` implies `read_x`.
* **Input problems are data, not errors.** Mutations return `userErrors { field code message }`
  with stable codes: `BLANK`, `TOO_LONG`, `TOO_MANY`, `TOO_FEW`, `INVALID`, `TAKEN`, `IN_USE`,
  `NOT_FOUND`.
* GraphQL errors carry `extensions.code`: `UNAUTHENTICATED` (HTTP 401: refresh or sign in),
  `SHOP_REQUIRED` (400), `NO_SHOP_ACCESS` and `MFA_REQUIRED` (403), `ACCESS_DENIED`,
  `BAD_USER_INPUT` (malformed IDs, cursors or page sizes), and `INTERNAL_SERVER_ERROR`. In
  production, internal errors show only a request id; the details go to the logs.
* Lists are Relay-style connections: `first` (1–250, default 50), `after`, and
  `pageInfo { hasNextPage endCursor }`. Cursors are opaque.
* Money fields return `{ amount, currencyCode, formatted }`. Money inputs are decimal strings in
  the shop currency, e.g. `"2,499.50"`.

## Catalog

The catalog follows Shopify's model, so merchants and importers find what they expect.

* **Options and variants.** A product has up to three options (Size, Colour, Fabric), each with
  ordered values, and at most 250 variants.
  * Each variant is one combination of values. A constraint in Postgres keeps combinations unique,
    and a product without options has exactly one variant, "Default Title".
  * A variant's title is its values joined with " / ", kept up to date when options are renamed,
    moved or removed.
  * Bulk mutations handle variants in one statement, so two variants can swap values.
* **Every change to a product's options, variants or media** bumps its `version` (caches are keyed
  by it). It records `product.updated`, with what changed, e.g. `changed: ["variants"]`.
* **Reads are one statement.** A product loads with its options, variants and media as JSON from
  one query, whatever the page size, because every round trip costs time through the pooler
  (spike 5). Amounts travel as text inside the JSON: JSON numbers lose precision above 2^53.
* **Smart collections** compile their rules to SQL. Membership is brought up to date in the same
  transaction as the change that affects it, whether a product edit, a variant price or new rules.
  So manual and smart collections read the same way, and never lag.
* **Media** records an image's source URL until the media worker, not built yet, fetches and
  resizes it. Only https sources are accepted.

## Staff sign-in

Staff identity is its own module (`@hatti/identity`); why it is built in-house is in
[ADR-020](../architecture/13-decision-log.md#adr-020--staff-identity-built-in-house-on-audited-primitives).

| Endpoint | Purpose |
|---|---|
| `POST /auth/sign-up` | Create an account; returns tokens |
| `POST /auth/sign-in` | Email and password. Returns tokens, or `mfa_required` with a `challengeToken` |
| `POST /auth/sign-in/verify` | The second step: an authenticator code or a recovery code |
| `POST /auth/refresh` | Swap a refresh token for new tokens |
| `POST /auth/sign-out` | End the current session |
| `GET /auth/me` | The user, the session and the shops they can open |
| `GET /auth/sessions`, `DELETE /auth/sessions/:id` | Signed-in devices; sign one out remotely |
| `POST /auth/two-step/totp/setup`, `…/confirm` | Turn on an authenticator app; returns 10 recovery codes once |

Rules the module enforces:

* **Passwords** are hashed with argon2id (19 MiB, 2 passes), must have at least 10 characters,
  must not contain the email's name, and are checked against Pwned Passwords by k-anonymity. That
  check fails open, so an outage never blocks sign-ups.
* **Tokens** are random, prefixed (`hsa_` access, `hsr_` refresh, `hmc_` sign-in challenge) and
  stored only as SHA-256 digests. Access tokens last 15 minutes. Refresh tokens rotate on every use;
  presenting a used one ends the whole session, except within 10 seconds (a client race). Sessions
  end after 30 days, or 7 days unused.
* **Two-step verification:** each TOTP code works once; authenticator secrets are encrypted with
  `SecretBox` (AES-256-GCM, keys in `ENCRYPTION_KEYS`) and bound to their user. Replacing an
  authenticator needs a session that passed the current one. **Owners, managers and accountants**
  cannot use a shop until their session has passed a second factor (`MFA_REQUIRED`).
* **Abuse limits** (Redis): sign-in by email (10 per 15 minutes) and by IP (100), sign-up by IP (10
  per hour), second-factor attempts by user (10), plus 5 attempts per challenge. Limits fail open
  if Redis is down.
* Wrong email and wrong password get the same answer after the same work, so responses do not
  reveal who has an account.
* **Database logins:** identity tables are reachable only by `hatti_identity`. Request-serving code
  resolves staff tokens through `identity.resolve_staff_access()`, a `SECURITY DEFINER` function
  that returns the role, and never sees password hashes.

## Configuration, logging and privacy

* Every process validates its environment at startup with `@hatti/config` (zod) and exits with a
  list of problems. Error messages never echo the values, which may be secrets.
* Log with `@hatti/logger` (JSON). **Log IDs, not personal data.** Phone numbers, email, CNIC,
  addresses, tokens and passwords are redacted automatically, but only as a backstop.
* Requests carry an `x-request-id`, accepted from the caller or generated. It appears in every
  log line for that request and in the response.

## Observability

Telemetry is OpenTelemetry, as planned in
[10 · Infrastructure](../architecture/10-infrastructure-and-devops.md#5-observability-stack). It is
off unless `OTEL_EXPORTER_OTLP_ENDPOINT` names a collector; the standard `OTEL_*` variables
configure the rest.

* **Start-up:** processes run with `node --import ./dist/instrumentation.js`, so instrumentation is
  in place before the libraries it patches load. On shutdown the last spans and metrics are
  flushed.
* **Automatic spans:** HTTP, the Fastify request and handler, GraphQL (parse, validate, resolvers),
  Postgres, Redis and outgoing `fetch`. Health probes are not traced.
* **Our spans:** `tenant transaction` (with `hatti.shop_id`), `outbox publish` (linked to the
  requests that recorded its events) and `process <event type>` in the worker. The outbox stores
  each event's W3C `traceparent`, so handling an event **continues the trace of the request that
  caused it**: API → Postgres → outbox → queue → worker.
* **Every request span** carries `hatti.shop_id` and `hatti.actor` (`app` or `staff`). Log lines
  written inside a trace carry `trace_id` and `span_id`, so Grafana can jump between logs and
  traces.
* **Metrics:** RED metrics from the HTTP instrumentation (`http.server.request.duration`), pool
  metrics from Postgres (`db.client.*`), and ours:

  | Metric | What to watch |
  |---|---|
  | `hatti.outbox.lag` (s) | Age of the oldest unpublished event; the relay is stuck or slow when it grows |
  | `hatti.outbox.parked` | Events set aside after repeated failures; anything above 0 needs a person |
  | `hatti.outbox.events.published`, `…rejected`, `hatti.outbox.relay.outages` | Relay throughput and failures |
  | `hatti.events.handle.duration` (ms) | Handler time by event type and outcome |
  | `hatti.auth.sign_ins` | Sign-in attempts by step and outcome; a jump in `invalid_credentials` or `rate_limited` means credential stuffing |

Rules:

* **No personal data in telemetry.** SQL is recorded without parameter values, Redis commands
  without keys or arguments, GraphQL without variable values. Attributes hold IDs, never names,
  phones, emails or addresses.
* **Shop IDs go on spans, not metrics.** A metric attribute per shop would create one time series
  per shop; keep metric attributes to small, fixed sets such as event types and outcomes.
* Name tracers and meters after the package, e.g. `hatti.catalog`. Create meters and instruments
  when a class is constructed, not at module load, so they bind to the running SDK.
* Sampling (keep all errors and slow traces) is the collector's job, not the application's.

## Testing

* **Vitest**, with real Postgres and Redis. Each test file creates and drops its own database with
  `createTestDatabase()` from `@hatti/db/testing`.
* With `DATABASE_POOLER_URL` set, as in CI, the database's app, system and identity URLs go
  through PgBouncer in transaction mode. Fixtures (`adminUrl`) and `listenUrl` stay direct. Code
  that only works on a direct connection fails there.
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
