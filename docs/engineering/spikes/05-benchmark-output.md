# Spike 5 · Benchmark output

> The report `pnpm bench:db all` printed on 2026-09-28, summarised in
> [05-rls-and-pooling.md](./05-rls-and-pooling.md). Query plans are folded under each row.

| Setting | Value |
| --- | --- |
| Scale | full |
| Measured seconds per run (warm-up) | 15 (3) |
| CPU | 4 × Intel(R) Xeon(R) Processor @ 2.10GHz |
| Memory | 16 GiB |
| Node | v22.22.2 |
| Postgres | 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1) |
| Postgres shared_buffers | 2GB |
| Postgres max_connections | 100 |
| Postgres jit | on |
| pgbench | pgbench (PostgreSQL) 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1) |
| PgBouncer | PgBouncer 1.22.0 |
| PgBouncer pool_mode | transaction |
| PgBouncer default_pool_size | 20 |
| PgBouncer max_client_conn | 2000 |

## Query plans (largest shop)

| Query | Plan with RLS | Same plan without RLS? | Execution ms without / with | Planning ms without / with |
| --- | --- | --- | --- | --- |
| First page, newest first | Index Scan on products_pkey | yes | 0.04 / 0.04 | 0.03 / 0.05 |
| A page deep in the list (cursor: id < …, up to 5,000 products in) | Index Scan on products_pkey | yes | 0.02 / 0.04 | 0.04 / 0.05 |
| First page matching "lawn" | Index Scan on products_pkey | yes | 0.14 / 0.13 | 0.07 / 0.05 |
| First page matching "organza" | Index Scan on products_pkey | yes | 1.20 / 1.43 | 0.06 / 0.07 |
| One product by handle | Index Scan on products_shop_handle_key | yes | 0.02 / 0.01 | 0.05 / 0.04 |
| The page's variants (50 product ids) | Index Scan on variants_shop_product_idx | yes | 0.09 / 0.12 | 0.07 / 0.09 |

<details><summary>First page, newest first: plan with RLS</summary>

```
Limit
  ->  Result
        One-Time Filter: ((NULLIF(current_setting('app.shop_id'::text, true), ''::text))::uuid = '00000000-0000-7000-8000-000000100990'::uuid)
        ->  Index Scan Backward using products_pkey on products
              Index Cond: (shop_id = '00000000-0000-7000-8000-000000100990'::uuid)
```

</details>
<details><summary>A page deep in the list (cursor: id < …, up to 5,000 products in): plan with RLS</summary>

```
Limit
  ->  Result
        One-Time Filter: ((NULLIF(current_setting('app.shop_id'::text, true), ''::text))::uuid = '00000000-0000-7000-8000-000000100990'::uuid)
        ->  Index Scan Backward using products_pkey on products
              Index Cond: ((shop_id = '00000000-0000-7000-8000-000000100990'::uuid) AND (id < '01a0e5af-6f75-7480-b562-1bdea563082b'::uuid))
```

</details>
<details><summary>First page matching "lawn": plan with RLS</summary>

```
Limit
  ->  Result
        One-Time Filter: ((NULLIF(current_setting('app.shop_id'::text, true), ''::text))::uuid = '00000000-0000-7000-8000-000000100990'::uuid)
        ->  Index Scan Backward using products_pkey on products
              Index Cond: (shop_id = '00000000-0000-7000-8000-000000100990'::uuid)
              Filter: (search_text ~~ '%lawn%'::text)
```

</details>
<details><summary>First page matching "organza": plan with RLS</summary>

```
Limit
  ->  Result
        One-Time Filter: ((NULLIF(current_setting('app.shop_id'::text, true), ''::text))::uuid = '00000000-0000-7000-8000-000000100990'::uuid)
        ->  Index Scan Backward using products_pkey on products
              Index Cond: (shop_id = '00000000-0000-7000-8000-000000100990'::uuid)
              Filter: (search_text ~~ '%organza%'::text)
```

</details>
<details><summary>One product by handle: plan with RLS</summary>

```
Result
  One-Time Filter: ((NULLIF(current_setting('app.shop_id'::text, true), ''::text))::uuid = '00000000-0000-7000-8000-000000100990'::uuid)
  ->  Index Scan using products_shop_handle_key on products
        Index Cond: ((shop_id = '00000000-0000-7000-8000-000000100990'::uuid) AND (handle = 'item-42'::text))
```

</details>
<details><summary>The page's variants (50 product ids): plan with RLS</summary>

```
Sort
  Sort Key: product_id, "position"
  ->  Result
        One-Time Filter: ((NULLIF(current_setting('app.shop_id'::text, true), ''::text))::uuid = '00000000-0000-7000-8000-000000100990'::uuid)
        ->  Index Scan using variants_shop_product_idx on variants
              Index Cond: ((shop_id = '00000000-0000-7000-8000-000000100990'::uuid) AND (product_id = ANY ('{01a0e5af-6ff0-7378-bbce-ef7864cf1ad6,01a0e5af-6ff0-7378-bbce-e76719677955,01a0e5af-6ff0-7378-bbce-de25f6c7a4c5,01a0e5af-6ff0-7378-bbce-d2f05efae7bc,01a0e5af-6ff0-7378-bbce-c2cae23cb874,01a0e5af-6ff0-7378-bbce-b8243e0830ae,01a0e5af-6ff0-7378-bbce-af4d4d7a5b4e,01a0e5af-6ff0-7378-bbce-a4daa954b261,01a0e5af-6ff0-7378-bbce-90cdcd2da34e,01a0e5af-6ff0-7378-bbce-881ec05f02a0,01a0e5af-6ff0-7378-bbce-7f1ef078526c,01a0e5af-6ff0-7378-bbce-76668747abed,01a0e5af-6ff0-7378-bbce-6e9dc21d7451,01a0e5af-6ff0-7378-bbce-67938a47aafd,01a0e5af-6ff0-7378-bbce-51d2fce2e97b,01a0e5af-6ff0-7378-bbce-49b6c338a7bc,01a0e5af-6ff0-7378-bbce-427c3af69a61,01a0e5af-6ff0-7378-bbce-39c988ae6ea9,01a0e5af-6ff0-7378-bbce-2ee24c616865,01a0e5af-6ff0-7378-bbce-2623d23a7785,01a0e5af-6ff0-7378-bbce-1fa974453f66,01a0e5af-6ff0-7378-bbce-1650abaae52b,01a0e5af-6ff0-7378-bbce-042ee193a619,01a0e5af-6ff0-7378-bbcd-ff61a3d7afc0,01a0e5af-6ff0-7378-bbcd-f78c5bd03eb7,01a0e5af-6fef-7083-bfaf-60d99ab40a48,01a0e5af-6fef-7083-bfaf-4ef1284ea094,01a0e5af-6fef-7083-bfaf-441a5bdfe1e1,01a0e5af-6fef-7083-bfaf-38855d310d72,01a0e5af-6fef-7083-bfaf-308dff05e65f,01a0e5af-6fef-7083-bfaf-2448f2a8022c,01a0e5af-6fef-7083-bfaf-1de663a64447,01a0e5af-6fef-7083-bfaf-1474408109d3,01a0e5af-6fef-7083-bfaf-0c3c51a94b82,01a0e5af-6fef-7083-bfaf-0707dfe3a89e,01a0e5af-6fef-7083-bfae-fdf9890b18d1,01a0e5af-6fef-7083-bfae-f0e92a5707e0,01a0e5af-6fef-7083-bfae-eb0e5415a820,01a0e5af-6fef-7083-bfae-e2b62e16a08e,01a0e5af-6fef-7083-bfae-db59e9a60394,01a0e5af-6fef-7083-bfae-d38d9c9087d6,01a0e5af-6fef-7083-bfae-c8719d0f8d03,01a0e5af-6fef-7083-bfae-c007eb9ae339,01a0e5af-6fef-7083-bfae-b9446b84d628,01a0e5af-6fef-7083-bfae-b0a3dbb323bc,01a0e5af-6fef-7083-bfae-aa37bf450f41,01a0e5af-6fef-7083-bfae-a39b82d1282c,01a0e5af-6fef-7083-bfae-9ad2ec3c031e,01a0e5af-6fef-7083-bfae-91ba8bddc915,01a0e5af-6fef-7083-bfae-8971a1f5631d}'::uuid[])))
```

</details>

## Which filters can use an index under RLS

| Filter | Operator function | Leakproof | Plan without RLS | Plan with RLS | ms without | ms with |
| --- | --- | --- | --- | --- | --- | --- |
| `search_text LIKE '%organza%'` | textlike | no | Bitmap Heap Scan on products → Bitmap Index Scan on bench_products_status → Bitmap Index Scan on bench_products_search_trgm | Index Scan on bench_products_status | 2.01 | 4.33 |
| `tags @> ARRAY['clearance']` | arraycontains | no | Bitmap Heap Scan on products → Bitmap Index Scan on bench_products_tags → Bitmap Index Scan on bench_products_status | Index Scan on bench_products_status | 1.35 | 4.06 |
| `status = 'archived'` | texteq | yes | Index Only Scan on bench_products_status | Index Only Scan on bench_products_status | 0.08 | 0.15 |

Leakproof: int4eq, int8lt, text_lt, texteq, timestamptz_lt, uuid_eq, uuid_lt. Not leakproof: arraycontains, arrayoverlap, jsonb_contains, texticlike, textlike, textregexeq, ts_match_vq.

## Row-level security overhead (pgbench, direct, 8 clients, median of 3 alternating rounds of 10 s)

| Workload | Shops | tps without RLS | tps with RLS | Change | p95 ms without | p95 ms with |
| --- | --- | --- | --- | --- | --- | --- |
| list | small | 5,923 (5,102–6,124) | 5,428 (5,039–5,622) | -8.4% | 2.34 | 2.04 |
| list | medium | 6,141 (5,988–6,278) | 5,266 (4,596–5,582) | -14.2% | 1.82 | 2.43 |
| list | large | 6,220 (5,522–6,289) | 5,148 (5,126–5,604) | -17.2% | 1.79 | 2.76 |
| search-common | large | 4,273 (4,028–4,294) | 3,935 (3,632–3,996) | -7.9% | 2.39 | 3.10 |
| search-rare | large | 1,091 (1,008–1,092) | 1,051 (1,042–1,067) | -3.7% | 9.06 | 10.0 |
| lookup | medium | 12,770 (12,693–13,802) | 11,407 (9,797–11,684) | -10.7% | 1.12 | 0.98 |

## Direct connections and PgBouncer (pgbench, RLS on, products page, medium shops)

| Clients | Direct tps | Direct p50 / p95 / p99 ms | PgBouncer tps | PgBouncer p50 / p95 / p99 ms |
| --- | --- | --- | --- | --- |
| 1 | 1,196 | 0.80 / 1.01 / 1.32 | 1,006 | 0.95 / 1.30 / 1.57 |
| 8 | 5,242 | 1.39 / 2.57 / 3.57 | 2,657 | 2.92 / 4.50 / 5.41 |
| 32 | 4,620 | 6.13 / 12.4 / 16.4 | 3,216 | 9.86 / 13.2 / 15.0 |
| 64 | 5,135 | 11.0 / 19.5 / 24.8 | 3,142 | 20.2 / 24.7 / 27.5 |
| 128 | fails: pgbench: error: connection to server at "127.0.0.1", port 5432 failed: FATAL:  remaining connection slots are reserved for roles with the SUPERUSER attribute |  | 3,156 | 40.1 / 46.3 / 49.5 |
| 512 | – |  | 3,044 | 167 / 185 / 191 |
| 1024 | – |  | 2,896 | 347 / 381 / 391 |

## Round trips (pgbench, 1 client, mean latency)

| Statement | Direct ms | PgBouncer ms |
| --- | --- | --- |
| select 1 (1 round trip) | 0.04 | 0.07 |
| Tenant transaction around select 1 (4 round trips) | 0.14 | 0.27 |

## The application code (ProductService, RLS on, medium shops)

| Operation | Callers | Connection | Calls/s | p50 ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- | --- |
| ProductService.list (50 products) | 1 | direct | 470 | 1.96 | 3.10 | 4.06 |
| ProductService.list (50 products) | 1 | PgBouncer | 400 | 2.36 | 3.48 | 4.14 |
| ProductService.list (50 products) | 16 | PgBouncer | 777 | 18.5 | 32.5 | 42.4 |
| ProductService.list (50 products) | 16 | direct | 788 | 18.6 | 31.1 | 37.0 |
| Tenant transaction around select 1 | 1 | direct | 4,375 | 0.21 | 0.28 | 0.38 |
| Tenant transaction around select 1 | 1 | PgBouncer | 2,808 | 0.33 | 0.46 | 0.64 |
| select 1 | 1 | PgBouncer | 11,497 | 0.08 | 0.11 | 0.15 |
| select 1 | 1 | direct | 17,208 | 0.05 | 0.08 | 0.11 |

## Shop settings under pooling

| Connection | Callers | Tenant transactions | Rolled back | Checks outside transactions | Leaks |
| --- | --- | --- | --- | --- | --- |
| direct | 32 | 46,655 | 4,586 | 46,655 | 0 |
| PgBouncer | 128 | 59,965 | 5,958 | 59,965 | 0 |

Control: one session-level `set_config(…, false)`, which the code never does, then statements
outside tenant transactions from other callers:

| Connection | Statements | Could read the shop | After resetting connections |
| --- | --- | --- | --- |
| direct | 2,000 | 246 | 0 |
| PgBouncer | 2,000 | 95 | 0 |

