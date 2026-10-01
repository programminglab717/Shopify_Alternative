# @hatti/db-bench

The spike 5 benchmark: what row-level security and PgBouncer transaction pooling cost on the
products listing, and whether shop settings stay isolated when many callers share pooled
connections. Since then it also times orders, customers and carts, and checks the statements the
application prepares. Results and conclusions are in
[docs/engineering/spikes/05-rls-and-pooling.md](../../docs/engineering/spikes/05-rls-and-pooling.md)
and [05-prepared-output.md](../../docs/engineering/spikes/05-prepared-output.md).

```sh
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres
export BENCH_POOLER_URL=postgres://127.0.0.1:6432   # optional: pgbouncer db/pgbouncer/pgbouncer.ini
pnpm bench:db seed
pnpm bench:db all --json results.json
```

| Command | What it does |
|---|---|
| `seed` | Recreates the `hatti_bench` database. Loads 1,000 shops (850 small, 140 medium, 10 large, 20 to 25,000 products each), about 460k products and 820k variants, from a fixed seed. Clothes and shoes have a Size option, as the catalog requires of products with several variants. Each shop also sells: a location with stock of most variants, about 720k orders over the last year at every stage with lines and parcels, three customers for every four orders, and 46k shoppers' carts, from generators of their own so the catalog stays the same. About two minutes |
| `explain` | Plans for the listing's queries on the largest shop, as `hatti_app` (policies apply) and as `hatti_bench_bypass` (same grants, `BYPASSRLS`). Then which filters can use trigram, GIN and B-tree indexes under the policies |
| `pgbench` | The listing's SQL with and without row-level security, and direct versus PgBouncer from 1 to 1,024 clients |
| `service` | The application's own code, direct and through PgBouncer: a page of products, orders and customers, an order, and a cart |
| `prepared` | The statements the application prepares, captured from the driver: each one's generic plan against the plans for a small, a medium and a large shop's values, its planning and execution times, and how Postgres ran it over ten calls. Run it before preparing a statement ([ADR-111](../../docs/architecture/13-decision-log.md#adr-111--orders-and-carts-are-read-through-prepared-statements-too-each-checked-by-the-benchmark-against-shops-of-every-size-a-prepared-page-writes-its-size-into-its-text)) |
| `leaks` | Hundreds of thousands of interleaved tenant transactions, some rolled back, on shared connections. The shop setting and every row must belong to the right shop, and nothing may stay set afterwards. Also a control run with one session-level setting, to show the check catches a leak |
| `all` | `explain`, `pgbench`, `service`, `prepared` and `leaks` |

Settings: `BENCH_DATABASE` (default `hatti_bench`), `BENCH_SCALE=full|smoke`, `BENCH_DURATION_S`
and `BENCH_WARMUP_S` per run (defaults 15 and 3). The pooled runs need PgBouncer's admin console
(`admin_users` in `db/pgbouncer/pgbouncer.ini`) and an open-file limit above 1,024 for the
1,024-client run (`ulimit -n 8192` before starting PgBouncer).

Shop UUIDs are built from six-digit numbers (`…-000000100000`), so pgbench scripts can pick a
random shop of a given size with `\set n random(first, last)`. Product handles are `item-1`,
`item-2`, and so on, for point lookups. A shop's customer k has the number `+923` and k in nine
digits, and its cart k the secret `cartToken(shopNumber, k)`, so a run can read them.
