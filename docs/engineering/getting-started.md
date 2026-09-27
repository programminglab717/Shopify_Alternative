# Getting started

> Set up the monorepo, run the Admin API and the worker, and run the tests.

## Prerequisites

* **Node.js 22.12 or later** (24 recommended; see `.nvmrc`) and **pnpm 10** (`corepack enable`).
* **Docker**, for Postgres and Valkey. Your own Postgres 16+ and Redis/Valkey 7+ also work.
* **Python 3**, only for the feature catalog script.

## First run

```sh
pnpm install
docker compose up -d   # Postgres 17 on :5432, Valkey 8 on :6379
cp .env.example .env
pnpm db:setup          # creates the hatti database and its logins, applies migrations
pnpm seed              # demo shop, 6 products, an owner account and an app token (printed once)
pnpm dev:api           # http://localhost:4000, GraphiQL at /graphiql
pnpm dev:worker        # outbox relay and event consumers (in a second terminal)
```

`pnpm dev:api` and `pnpm dev:worker` build what they need first (Turborepo caches unchanged
packages), then start the process. Stop with Ctrl+C; both shut down gracefully.

## Try the API

Use the token that `pnpm seed` printed:

```sh
curl -s http://localhost:4000/admin/api/2026-10/graphql \
  -H 'content-type: application/json' \
  -H 'x-hatti-access-token: hat_…' \
  -d '{"query":"{ shop { name } products(first: 5, query: \"kamiz\") { nodes { title } } }"}'
```

`kamiz` finds "Shalwar Qameez": search folds Roman Urdu spellings (see
[conventions](./conventions.md#pakistan-specific-data)). In GraphiQL, set the
`x-hatti-access-token` header, then try:

```graphql
mutation {
  productCreate(
    input: { title: "Chunri Dupatta", status: ACTIVE, variants: [{ price: "1,450" }] }
  ) {
    product { id handle priceRange { minVariantPrice { formatted } } }
    userErrors { field code message }
  }
}
```

The worker logs a `product.created` event a few milliseconds later. The full schema is in
[`apps/core/schema.graphql`](../../apps/core/schema.graphql).

## Sign in as the shop owner

The seed also prints an owner account with two-step verification switched on. Owners must use it
(see [conventions](./conventions.md#staff-sign-in)).

```sh
# 1. Email and password give a challenge token
curl -s localhost:4000/auth/sign-in -H 'content-type: application/json' \
  -d '{"email":"owner-…@demo.hatti.test","password":"…"}'

# 2. A code from your authenticator app, or from `pnpm totp <2-step key>`
curl -s localhost:4000/auth/sign-in/verify -H 'content-type: application/json' \
  -d '{"challengeToken":"hmc_…","code":"123456"}'

# 3. The access token and the shop id call the Admin API
curl -s localhost:4000/admin/api/2026-10/graphql -H 'content-type: application/json' \
  -H 'authorization: Bearer hsa_…' -H 'x-hatti-shop-id: shop_…' \
  -d '{"query":"{ shop { name } }"}'
```

Access tokens last 15 minutes; `POST /auth/refresh` with `{"refreshToken":"hsr_…"}` gives new
ones.

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm check` | Format check, lint, typecheck and tests: what CI runs, apart from the seed step |
| `pnpm build` | Builds every package (cached by Turborepo) |
| `pnpm test` | All tests. Database and queue tests need the URLs below |
| `pnpm --filter @hatti/catalog test` | One package's tests |
| `pnpm db:migrate` | Applies new migrations |
| `pnpm format` | Formats with Prettier |
| `UPDATE_SCHEMA=1 pnpm --filter @hatti/core test` | Accepts GraphQL schema changes into `schema.graphql` |
| `pnpm features:summary` | Refreshes the feature catalog summary table |
| `pnpm totp <key>` | Prints the current authenticator code for a 2-step key |

## Tests and databases

Tests use real Postgres and Redis, never mocks. They read `DATABASE_ADMIN_URL` and `REDIS_URL`
from the environment. They do not read `.env`, because Turborepo passes only declared variables.

```sh
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres
export REDIS_URL=redis://localhost:6379
pnpm test
```

* Each test file creates its own database (`hatti_test_<random>`), migrates it and drops it
  afterwards, so test files run in parallel.
* Without the URLs, those tests are **skipped** locally. In CI (when `CI` is set) a missing URL
  **fails** the run, so a misconfigured pipeline can never pass by skipping.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `password authentication failed for user "hatti_app"` | Run `pnpm db:setup` again. It resets the login passwords to the ones in `.env` |
| Port 5432 or 6379 is already in use | Stop the local service, or change the port in `docker-compose.yml` and the URLs in `.env` |
| `Migration 0001_foundation changed after it was applied` | Applied migrations are immutable. Add a new migration. Locally you can also `dropdb hatti` and run `pnpm db:setup` |
| `DATABASE_ADMIN_URL must be set in CI` on your machine | Unset `CI` |
| `INVALID_CODE` just after seeding | Each code works once and the seed used the current one. Wait for the next code (up to 30 seconds) |
| `Invalid configuration: DATABASE_IDENTITY_URL` or `ENCRYPTION_KEYS` | Your `.env` predates staff sign-in. Copy the new lines from `.env.example` and run `pnpm db:setup` |
| `Cannot use GraphQLEnumType … from another module or realm` in a new package's tests | Copy the `graphql` alias from `apps/core/vitest.config.ts` (see [conventions](./conventions.md#testing)) |
