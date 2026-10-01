# Spike 5 · Row-level security and PgBouncer

> **Status:** Done, 2026-09-28 · **Outcome: go**, with the fixes and rules below
> Roadmap: [Phase 0 spikes](../../product/04-roadmap.md#2-phase-0--foundations-oct--mid-nov-2026) ·
> Decision: [ADR-021](../../architecture/13-decision-log.md#adr-021--pgbouncer-transaction-pooling-with-no-session-state) ·
> Tool: [`tools/db-bench`](../../../tools/db-bench/README.md) ·
> Raw output: [05-benchmark-output.md](./05-benchmark-output.md)

## Question

Every shop's rows sit in shared tables, and Postgres row-level security (RLS) is the backstop
behind the application's own shop filter ([ADR-003](../../architecture/13-decision-log.md#adr-003--postgresql-shared-schema-with-shop_id--rls-cells-for-scale-out)).
Request-serving processes are meant to reach Postgres through PgBouncer in transaction mode
([02 · Tech stack](../../architecture/02-tech-stack.md)). The spike asked three things:

1. What does RLS cost on the busiest admin read, the products listing? Do its query plans survive?
2. Do tenant transactions work through PgBouncer in transaction mode, without the shop setting of
   one request leaking into another?
3. What does the pooler cost per request, and what does it buy?

**Answer: go.**

* RLS keeps every listing plan and costs about 0.1 ms per transaction.
* PgBouncer kept shops apart across more than 100,000 interleaved transactions, and served ten
  times more clients than Postgres allows.
* But the application could not connect through PgBouncer at all until this spike fixed it. The
  fixes, and the rules that keep them fixed, are below.

## Set-up

* **Dataset:** 1,000 shops, loaded by `pnpm bench:db seed` from a fixed seed in 22 seconds:
  * 850 small shops with 20–200 products (94,480 products);
  * 140 medium shops with 300–2,500 (198,183);
  * 10 large shops with 10,000–25,000 (170,156).

  That makes 462,819 products and 822,150 variants, 690 MB with indexes. Titles mix Pakistani
  product words: "lawn" appears in 14.1% of products and "organza" in 1.0%. Descriptions are
  0.5–1.5 KB of HTML, like real merchants'. Since 2026-10-01 the shops also sell, with the same
  catalog: 724,204 orders, 543,267 customers, 46,385 carts and stock, for the orders' and carts'
  prepared statements ([ADR-111](../../architecture/13-decision-log.md#adr-111--orders-and-carts-are-read-through-prepared-statements-too-each-checked-by-the-benchmark-against-shops-of-every-size-a-prepared-page-writes-its-size-into-its-text)).
* **Machine:** one 4-core virtual machine (Intel Xeon at 2.1 GHz, 16 GiB) running everything:
  Postgres 16.13 (`shared_buffers` 2 GB, `max_connections` 100, JIT on), PgBouncer 1.22
  (transaction mode, `default_pool_size` 20), pgbench and Node 22. All traffic stayed on
  localhost, without TLS.
* **Logins:** `hatti_app`, where RLS applies, and `hatti_bench_bypass`, which has the same grants
  and session settings plus `BYPASSRLS`. So "without RLS" differs only in the policies.
* **Method:**
  * pgbench runs the exact SQL `ProductService.list` sends, captured from the driver: `BEGIN`,
    `set_config`, the products query, the variants query, `COMMIT`.
  * Comparisons alternate their order over three rounds, and the tables report medians. Timings
    on this machine drift upwards for minutes after a restart, and a single run of the same
    configuration varied by up to 30%.
  * Planning and execution times come from `EXPLAIN ANALYZE` with warm caches.

## Results

### 1. Query plans are the same with and without RLS

Queries on the largest shop (17,023 products); times in ms, as the median of warm runs.

| Query | Plan (both logins) | Execution without / with RLS | Planning without / with RLS |
|---|---|---|---|
| First page, newest first | Index scan (backward) on `products_pkey` | 0.04 / 0.04 | 0.03 / 0.05 |
| A page 5,000 products in (`id < cursor`) | Index scan on `products_pkey` | 0.02 / 0.04 | 0.04 / 0.05 |
| First page matching "lawn" | Index scan on `products_pkey`, filter | 0.14 / 0.13 | 0.07 / 0.05 |
| First page matching "organza" | Index scan on `products_pkey`, filter | 1.20 / 1.43 | 0.06 / 0.07 |
| One product by handle | Index scan on `products_shop_handle_key` | 0.02 / 0.01 | 0.05 / 0.04 |
| The page's variants (50 products) | Index scan on `variants_shop_product_idx` | 0.09 / 0.12 | 0.07 / 0.09 |

The plans are the same because every query also filters by shop itself. Postgres sees both
`shop_id = '…'` and the policy's `shop_id = current_shop_id()`, concludes that the setting must
equal the literal, and checks that once per query: a `One-Time Filter` above an ordinary index
scan.

```
Limit
  ->  Result
        One-Time Filter: ((NULLIF(current_setting('app.shop_id', true), ''))::uuid = '…100990'::uuid)
        ->  Index Scan Backward using products_pkey on products
              Index Cond: (shop_id = '…100990'::uuid)
```

On the tiny smoke dataset, with 2,700 products in the largest shop, the "lawn" search did change
plan under RLS, to a bitmap scan plus sort taking 8 times longer. The next finding explains why.

### 2. Under RLS, only leakproof operators can use indexes and statistics

Postgres applies a policy before any condition that could leak data through an error message.
Only operators marked **leakproof** may run first or drive an index scan. The planner also stops
using column statistics for non-leakproof operators, so it guesses their selectivity.

| Filter on the largest shop | Operator | Leakproof | Without RLS | With RLS |
|---|---|---|---|---|
| `search_text LIKE '%organza%'`, with a trigram index | `textlike` | no | trigram index: 2.01 ms | index unused, row by row: 4.33 ms |
| `tags @> ARRAY['clearance']`, with a GIN index | `arraycontains` | no | GIN index: 1.35 ms | index unused: 4.06 ms |
| `status = 'archived'`, with a B-tree index | `texteq` | yes | index-only scan: 0.08 ms | index-only scan: 0.15 ms |

Leakproof in Postgres 16: equality and ordering on uuid, text, integers and timestamps. Not
leakproof: `LIKE`, `ILIKE`, regular expressions, array and jsonb containment, and full-text
search. The gap widens with shop size, because the non-leakproof filters scan every row of the
shop. This rules out a stopgap of trigram search in Postgres before Typesense, and GIN-indexed
tag filters.

### 3. What RLS costs

pgbench, direct connections, 8 clients, median of three alternating rounds of 10 s:

| Workload | Shops | Transactions/s without RLS | With RLS | Change |
|---|---|---|---|---|
| Products page | small | 5,923 | 5,428 | −8.4% |
| Products page | medium | 6,141 | 5,266 | −14.2% |
| Products page | large | 6,220 | 5,148 | −17.2% |
| Search, "lawn" | large | 4,273 | 3,935 | −7.9% |
| Search, "organza" | large | 1,091 | 1,051 | −3.7% |
| Product by handle | medium | 12,770 | 11,407 | −10.7% |

With one client, where latency rather than CPU is the limit, a products page took 0.77 ms without
RLS and 0.86 ms with it. That is **about 0.1 ms per transaction**, mostly planning (the policy
adds 0.01 to 0.06 ms of planning per query) and the one-time check. The share looks large here
because each transaction takes about a millisecond on localhost. Across a real network, with a
few tenths of a millisecond per round trip, it is 2–3%.

Prepared statements would remove most of it, since the plan would be made once. PgBouncer has
supported them in transaction mode since 1.21. This is a follow-up, not needed now.

### 4. What PgBouncer costs, and what it buys

The products page for medium shops, RLS on:

| Clients | Direct transactions/s | Direct p95 ms | PgBouncer transactions/s | PgBouncer p95 ms |
|---|---|---|---|---|
| 1 | 1,196 | 1.01 | 1,006 | 1.30 |
| 8 | 5,242 | 2.57 | 2,657 | 4.50 |
| 32 | 4,620 | 12.4 | 3,216 | 13.2 |
| 64 | 5,135 | 19.5 | 3,142 | 24.7 |
| 128 | **fails**: `remaining connection slots are reserved` | – | 3,156 | 46.3 |
| 512 | – | – | 3,044 | 185 |
| 1,024 | – | – | 2,896 | 381 |

* **What it buys:** direct connections stop at `max_connections`, which is 100 here. At 128
  clients, pgbench could not connect. In production every API and worker pod keeps its own pool,
  so pods × pool size exceeds any sensible `max_connections` long before traffic does.
  Through PgBouncer, 1,024 clients shared 20 server connections, throughput stayed level, and
  the excess waited in line. Latency then grows with the queue: p95 381 ms at 1,024 clients.
  So bursts need admission control at the edge ([12 · Scalability](../../architecture/12-scalability-and-reliability.md)), not
  more connections.
* **What it costs:** one extra hop per round trip. A `select 1` took 0.038 ms direct and
  0.068 ms through PgBouncer, so **about 0.03 ms per round trip** on the same host. The products
  page makes 5 round trips (`BEGIN`, `set_config`, products, variants, `COMMIT`), so the pooler
  adds about 0.15 ms per page.
* **Why throughput fell on this machine:** PgBouncer, pgbench and Postgres shared 4 cores.
  PgBouncer used about half a core and was not the bottleneck. The loss is the extra hop plus CPU
  taken from Postgres. With PgBouncer on its own CPU, as a sidecar or a separate service,
  pooled throughput should approach direct. This must be re-measured in the target cloud (the
  latency bake-off, ADR-015).

### 5. The application code

`ProductService.list`, the real code path (Drizzle, node-postgres, row mapping), first page of 50
products for medium shops, RLS on:

| Callers | Connection | Calls/s | p50 ms | p95 ms |
|---|---|---|---|---|
| 1 | direct | 470 | 1.96 | 3.10 |
| 1 | PgBouncer | 400 | 2.36 | 3.48 |
| 16 | direct | 788 | 18.6 | 31.1 |
| 16 | PgBouncer | 777 | 18.5 | 32.5 |

* **One caller:** the pooler adds 0.4 ms per page. That is 5 round trips of about 0.03 ms each,
  plus about 60 KB of rows passing through PgBouncer.
* **Sixteen callers:** direct and pooled are the same, because the Node process is the limit. One
  process tops out near 790 pages a second, about 1.3 ms of JavaScript per page (driver parsing,
  Drizzle mapping, records). Postgres served over 5,000 such pages a second to pgbench on the same
  machine.
* **So:** API capacity scales with API processes, and trimming work per row (fewer columns in
  lists, no descriptions unless asked) raises it more than any database change would.

### 6. Shop settings never leak between pooled callers

Callers loop for 15 s over tenant transactions for random shops, sharing few connections. Inside
each transaction, the shop setting and every row read must belong to that shop. About one in ten
transactions ends in an error, half thrown by the caller and half a failing SQL statement, since
those paths end differently. Straight after each transaction, a statement outside any transaction
must see no shop setting and no rows.

| Connection | Callers | Tenant transactions | Rolled back | Leaks |
|---|---|---|---|---|
| direct (pool of 32) | 32 | 46,655 | 4,586 | **0** |
| PgBouncer (20 server connections) | 128 | 59,965 | 5,958 | **0** |

**Control.** To show that the check would catch a leak, one statement set the shop for the whole
session with `set_config(…, false)`, which the code never does. Other callers then ran statements
outside any transaction. Directly, 246 of 2,000 could read that shop's products; through
PgBouncer, 95 of 2,000. A session-level setting stays on its server connection, and the pooler
hands that connection to other callers. After the connections were reset, 0 of 2,000 could.

The same checks run in CI as ordinary tests: 400 interleaved transactions for two shops on four
connections, some failing, through PgBouncer.

## What broke, and the fixes

1. **The application could not connect through PgBouncer.** node-postgres sends
   `statement_timeout` and `idle_in_transaction_session_timeout` as startup parameters when
   `createPool` sets them. PgBouncer refuses such connections:
   `unsupported startup parameter: statement_timeout`. Every pooled benchmark run of the real
   `ProductService` failed this way.
   **Fix:** pools send no session settings. Timeouts come from two places:
   * the login's own defaults (`LOGIN_DEFAULTS`: 15 s per statement, 30 s idle in a
     transaction), which `pnpm db:setup` sets and infrastructure code must set;
   * each tenant transaction's limits, set by `set_config(…, true)` in the same statement as the
     shop, at no extra round trip. The Admin API uses 5 s, the budget in
     [12 · Scalability](../../architecture/12-scalability-and-reliability.md).
2. **The worker would lose outbox notifications.** The relay ran `LISTEN` on
   `DATABASE_SYSTEM_URL`. Through a transaction pooler, `LISTEN` registers on whichever server
   connection runs it, and later notifications go to whoever holds that connection. Wake-ups
   would have silently stopped, leaving only the 1 s poll.
   **Fix:**
   * `DATABASE_LISTEN_URL` gives the relay a direct connection.
   * At start-up, the relay sends itself a notification from its other connection. If it does
     not arrive, the relay logs why and polls.
   * The probe must come from the other connection: a session always receives its own
     notifications, even through a pooler.
3. **Nothing tested the pooled path.** CI now installs PgBouncer and runs every database test
   through it (`DATABASE_POOLER_URL`). Fixtures, migrations and the relay's `LISTEN` stay direct.
   Any code that needs session state now fails in CI instead of in production. Locally, the same
   suite passes both ways.

**Live check.** The built API and worker ran with every request-serving connection through
PgBouncer and only the relay's `LISTEN` direct. A product created through the Admin API reached
the worker 3 ms after the request finished. With `DATABASE_LISTEN_URL` unset, so `LISTEN` also
went through PgBouncer, the worker logged the warning and fell back to polling.

## Rules that follow

Recorded in [conventions](../conventions.md#connection-pooling) and ADR-021:

* **No session state outside a transaction:** no `SET`, no `set_config(…, false)`, no `LISTEN`,
  no session advisory locks, no temporary tables and no named prepared statements across
  transactions. The control run above shows what one session-level setting does.
* **Direct connections only for:** migrations and setup (advisory locks), the relay's `LISTEN`,
  and operator tools.
* **Always filter by shop explicitly as well.** It keeps RLS down to one check per query.
* **Index only leakproof conditions.** Text search goes to Typesense (ADR-013). Filterable sets,
  such as tags or collection membership, are rows with B-tree indexes. Check plans as
  `hatti_app` inside a tenant transaction (`pnpm bench:db explain`), never as a superuser.
* **Keep round trips per request low.** Each one costs a hop through the pooler, and across a
  network. The catalog now loads a product with its options, variants and media in one statement.

## Caveats

* It ran on one small machine, with everything sharing 4 cores and no network. Absolute numbers
  are not production numbers; the comparisons and the correctness results carry over.
* It used Postgres 16. CI runs 17, and production will run 16 or 17. The planner behaviour relied
  on here (equivalence classes, leakproof checks) is the same in both.
* The dataset is synthetic, with a realistic size distribution, text and description length.
* JIT was on and never triggered: no listing query came near `jit_above_cost`.

## Follow-ups

| Follow-up | Why | When |
|---|---|---|
| Re-run in the target cloud, with PgBouncer beside the API pods | Real network and CPU placement; confirms the pooled throughput | With the hosting decision (ADR-015) |
| Fold `set_config` into `BEGIN` | Saves one round trip per transaction (a small custom transaction helper) | Done 2026-10-01 ([ADR-107](../../architecture/13-decision-log.md#adr-107--a-tenant-transaction-begins-with-its-shop-and-limits-set-in-one-round-trip-begin-and-set_config-sent-as-one-simple-query-the-values-written-in-once-checked)): a tenant transaction around `select 1` went from 0.26 to 0.19 ms (median) direct, and from 0.40 to 0.30–0.32 ms through PgBouncer |
| Prepared statements for hot queries | Removes planning, most of RLS's cost | Begun 2026-10-01 ([ADR-108](../../architecture/13-decision-log.md#adr-108--hot-queries-run-as-statements-prepared-by-name-planned-once-per-connection-every-pooler-in-front-of-the-application-sets-max_prepared_statements)): the products statement, with PgBouncer's `max_prepared_statements`; the products page went from 2.81 to 2.23 ms (median) direct, and from 3.05 to 2.48 ms through PgBouncer. Then orders and carts ([ADR-111](../../architecture/13-decision-log.md#adr-111--orders-and-carts-are-read-through-prepared-statements-too-each-checked-by-the-benchmark-against-shops-of-every-size-a-prepared-page-writes-its-size-into-its-text)), on a dataset with sales and checked by `pnpm bench:db prepared` ([output](./05-prepared-output.md)): an order went from 1.65 to 0.49 ms direct and from 2.16 to 0.60 ms through PgBouncer, the newest 50 orders from 3.66 to 2.69 and from 4.03 to 2.84 ms. Then an order's timeline, on orders with timelines ([ADR-122](../../architecture/13-decision-log.md#adr-122--an-orders-timeline-is-read-through-a-prepared-statement-too-checked-by-the-benchmark-on-orders-with-their-timelines-its-locations-loader-stays-planned-as-customers-statements-do)): its newest 50 events from 0.37 to 0.27 ms direct and from 0.48 to 0.39 ms through PgBouncer; its location's loader, no faster prepared, stays planned |
| Admin search to Typesense for large shops | A rare word scans the whole shop: 1.2–1.4 ms for 17,000 products, and 9–10 ms p95 under load | Already in the simplifications table (trigger: shops above 10k products) |
