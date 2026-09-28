# @hatti/db-bench

The spike 5 benchmark: what row-level security and PgBouncer transaction pooling cost on the
products listing, and whether shop settings stay isolated when many callers share pooled
connections. Results and conclusions are in
[docs/engineering/spikes/05-rls-and-pooling.md](../../docs/engineering/spikes/05-rls-and-pooling.md).

```sh
export DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres
export BENCH_POOLER_URL=postgres://127.0.0.1:6432   # optional: pgbouncer db/pgbouncer/pgbouncer.ini
pnpm bench:db seed
pnpm bench:db all --json results.json
```

| Command | What it does |
|---|---|
| `seed` | Recreates the `hatti_bench` database. Loads 1,000 shops (850 small, 140 medium, 10 large, 20 to 25,000 products each), about 460k products and 820k variants, from a fixed seed |
| `explain` | Plans for the listing's queries on the largest shop, as `hatti_app` (policies apply) and as `hatti_bench_bypass` (same grants, `BYPASSRLS`). Then which filters can use trigram, GIN and B-tree indexes under the policies |
| `pgbench` | The listing's SQL with and without row-level security, and direct versus PgBouncer from 1 to 1,024 clients |
| `service` | `ProductService.list`, the application's own code, direct and through PgBouncer |
| `leaks` | Hundreds of thousands of interleaved tenant transactions, some rolled back, on shared connections. The shop setting and every row must belong to the right shop, and nothing may stay set afterwards. Also a control run with one session-level setting, to show the check catches a leak |
| `all` | `explain`, `pgbench`, `service` and `leaks` |

Settings: `BENCH_DATABASE` (default `hatti_bench`), `BENCH_SCALE=full|smoke`, `BENCH_DURATION_S`
and `BENCH_WARMUP_S` per run (defaults 15 and 3). The pooled runs need PgBouncer's admin console
(`admin_users` in `db/pgbouncer/pgbouncer.ini`) and an open-file limit above 1,024 for the
1,024-client run (`ulimit -n 8192` before starting PgBouncer).

Shop UUIDs are built from six-digit numbers (`…-000000100000`), so pgbench scripts can pick a
random shop of a given size with `\set n random(first, last)`. Product handles are `item-1`,
`item-2`, and so on, for point lookups.
