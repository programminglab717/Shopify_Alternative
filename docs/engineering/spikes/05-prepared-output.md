# Spike 5 · Prepared statements: benchmark output

> What `pnpm bench:db prepared` and `pnpm bench:db service` printed on 2026-10-01, on spike 5's
> dataset with shops' sales added: the statements the application prepares, checked against a
> small, a medium and a large shop's own plans, and the services timed before and after orders
> and carts were prepared. Summarised in [ADR-111](../../architecture/13-decision-log.md#adr-111--orders-and-carts-are-read-through-prepared-statements-too-each-checked-by-the-benchmark-against-shops-of-every-size-a-prepared-page-writes-its-size-into-its-text)
> and the [spike 5 report](./05-rls-and-pooling.md#follow-ups). Statements are folded under the
> table.

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

## Dataset

The catalog is spike 5's, from the same seed; each shop's sales draw from a generator of their
own. Loaded in 109 s.

| Shops | Count | Products | Variants | Products per shop | Orders | Customers | Carts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| small | 850 | 94,480 | 168,409 | 20–200 | 131,908 | 99,026 | 12,949 |
| medium | 140 | 198,183 | 352,771 | 300–2,500 | 316,220 | 237,183 | 21,943 |
| large | 10 | 170,156 | 300,970 | 10,000–25,000 | 276,076 | 207,058 | 11,493 |

| Table | Size with indexes |
| --- | --- |
| catalog.product_option_values | 210 MB |
| catalog.product_options | 78 MB |
| catalog.products | 471 MB |
| catalog.variants | 283 MB |
| checkout.carts | 26 MB |
| customers.customer_phones | 139 MB |
| customers.customers | 166 MB |
| inventory.items | 62 MB |
| inventory.levels | 106 MB |
| inventory.locations | 336 kB |
| orders.fulfillment_lines | 155 MB |
| orders.fulfillments | 214 MB |
| orders.lines | 320 MB |
| orders.orders | 779 MB |


## Prepared statements: generic plans against each shop size (RLS on, direct)

Each statement as the application sent it, captured from the driver. "Generic / custom runs of
10" is how Postgres ran it over ten calls for one shop on one connection: after five custom
plans it keeps the generic one when it judges it no dearer.

| Operation | Statement | Shops | Generic plan | Same plan for the shop's values? | Planning ms | Execution ms | Generic / custom runs of 10 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ProductService.list (50 products) | products (I_5s9Z) | small | Index Scan on products_pkey → Index Scan on product_options_position_key → Index Scan on product_option_values_position_key → Index Scan on variants_shop_product_idx → Index Scan on product_media_position_key | yes | 0.30 | 1.30 | 5 / 5 |
| OrderService.list (50 orders) | orders (Ma8Ybw) | small | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.39 | 1.56 | 5 / 5 |
| OrderService.list (50 orders to confirm) | orders (NvBPVt) | small | Index Scan on orders_stage_idx → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.44 | 0.31 | 0 / 10 |
| OrderService.list (50 high-risk orders) | orders (OCnQgX) | small | Index Scan on orders_risk_idx → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.39 | 1.28 | 5 / 5 |
| OrderService.list (a customer's orders) | orders (4IRwGI) | small | Index Scan on orders_customer_idx → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.51 | 0.22 | 5 / 5 |
| OrderService.list (the next 50 orders) | orders (Ma8Ybw) | small | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.59 | 2.17 | 5 / 5 |
| OrderService.list (the next 50 orders) | orders (z34rju) | small | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.52 | 2.15 | 0 / 10 |
| OrderService.get (one order) | orders (TYq93l) | small | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.35 | 0.16 | 5 / 5 |
| OrderService.getMany (10 orders) | orders (CwvuF4) | small | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.39 | 0.37 | 5 / 5 |
| CartService.cart (one cart) | carts (30HzdJ) | small | Index Scan on carts_shop_id_token_hash_key | yes | 0.07 | 0.02 | 5 / 5 |
| CartService.cart (one cart) | variants (o7X6mM) | small | Index Scan on variants_pkey → Index Scan on products_pkey | yes | 0.24 | 0.06 | 0 / 10 |
| CartService.cart (one cart) | items (V1cr4O) | small | Index Scan on items_pkey → Index Scan on levels_pkey → Index Scan on locations_pkey | yes | 0.27 | 0.11 | 0 / 10 |
| ProductService.list (50 products) | products (I_5s9Z) | medium | Index Scan on products_pkey → Index Scan on product_options_position_key → Index Scan on product_option_values_position_key → Index Scan on variants_shop_product_idx → Index Scan on product_media_position_key | yes | 0.32 | 1.37 | 5 / 5 |
| OrderService.list (50 orders) | orders (Ma8Ybw) | medium | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.41 | 1.50 | 5 / 5 |
| OrderService.list (50 orders to confirm) | orders (NvBPVt) | medium | Index Scan on orders_stage_idx → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.39 | 1.08 | 0 / 10 |
| OrderService.list (50 high-risk orders) | orders (OCnQgX) | medium | Index Scan on orders_risk_idx → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.35 | 1.62 | 5 / 5 |
| OrderService.list (a customer's orders) | orders (4IRwGI) | medium | Index Scan on orders_customer_idx → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.43 | 0.21 | 5 / 5 |
| OrderService.list (the next 50 orders) | orders (Ma8Ybw) | medium | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.38 | 1.47 | 5 / 5 |
| OrderService.list (the next 50 orders) | orders (z34rju) | medium | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.42 | 1.54 | 0 / 10 |
| OrderService.get (one order) | orders (TYq93l) | medium | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.41 | 0.23 | 5 / 5 |
| OrderService.getMany (10 orders) | orders (CwvuF4) | medium | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.38 | 0.52 | 5 / 5 |
| CartService.cart (one cart) | carts (30HzdJ) | medium | Index Scan on carts_shop_id_token_hash_key | yes | 0.09 | 0.02 | 5 / 5 |
| CartService.cart (one cart) | variants (o7X6mM) | medium | Index Scan on variants_pkey → Index Scan on products_pkey | yes | 0.15 | 0.03 | 0 / 10 |
| CartService.cart (one cart) | items (V1cr4O) | medium | Index Scan on items_pkey → Index Scan on levels_pkey → Index Scan on locations_pkey | yes | 0.27 | 0.10 | 0 / 10 |
| ProductService.list (50 products) | products (I_5s9Z) | large | Index Scan on products_pkey → Index Scan on product_options_position_key → Index Scan on product_option_values_position_key → Index Scan on variants_shop_product_idx → Index Scan on product_media_position_key | yes | 0.37 | 1.10 | 5 / 5 |
| OrderService.list (50 orders) | orders (Ma8Ybw) | large | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.41 | 1.54 | 5 / 5 |
| OrderService.list (50 orders to confirm) | orders (NvBPVt) | large | Index Scan on orders_stage_idx → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.54 | 1.35 | 5 / 5 |
| OrderService.list (50 high-risk orders) | orders (OCnQgX) | large | Index Scan on orders_risk_idx → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.41 | 1.55 | 5 / 5 |
| OrderService.list (a customer's orders) | orders (4IRwGI) | large | Index Scan on orders_customer_idx → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.41 | 0.18 | 5 / 5 |
| OrderService.list (the next 50 orders) | orders (Ma8Ybw) | large | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.49 | 1.58 | 5 / 5 |
| OrderService.list (the next 50 orders) | orders (z34rju) | large | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.43 | 1.39 | 5 / 5 |
| OrderService.get (one order) | orders (TYq93l) | large | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.41 | 0.21 | 5 / 5 |
| OrderService.getMany (10 orders) | orders (CwvuF4) | large | Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.46 | 0.57 | 5 / 5 |
| CartService.cart (one cart) | carts (30HzdJ) | large | Index Scan on carts_shop_id_token_hash_key | yes | 0.08 | 0.02 | 5 / 5 |
| CartService.cart (one cart) | variants (o7X6mM) | large | Index Scan on variants_pkey → Index Scan on products_pkey | yes | 0.18 | 0.04 | 0 / 10 |
| CartService.cart (one cart) | items (V1cr4O) | large | Index Scan on items_pkey → Index Scan on levels_pkey → Index Scan on locations_pkey | yes | 0.25 | 0.09 | 0 / 10 |

<details><summary>products (I_5s9Z)</summary>

```sql

    SELECT p.id, p.title, p.handle, p.status, p.description, p.vendor, p.product_type, p.tags,
           p.version, p.created_at, p.updated_at,
           (NULL)::text AS sort_key,
           (SELECT coalesce(json_agg(json_build_object(
                     'id', o.id, 'name', o.name, 'position', o.position,
                     'values', (SELECT coalesce(json_agg(json_build_object(
                                         'id', ov.id, 'name', ov.name, 'position', ov.position)
                                         ORDER BY ov.position), '[]'::json)
                                  FROM catalog.product_option_values ov
                                 WHERE ov.shop_id = o.shop_id AND ov.option_id = o.id))
                     ORDER BY o.position), '[]'::json)
              FROM catalog.product_options o
             WHERE o.shop_id = p.shop_id AND o.product_id = p.id) AS options,
           (SELECT coalesce(json_agg(json_build_object(
                     'id', v.id, 'title', v.title, 'sku', v.sku, 'barcode', v.barcode,
                     'price', v.price::text, 'compareAtPrice', v.compare_at_price::text,
                     'cost', v.cost::text, 'weightGrams', v.weight_grams, 'taxable', v.taxable,
                     'taxCode', v.tax_code, 'position', v.position,
                     'optionValueIds',
                       json_build_array(v.option1_value_id, v.option2_value_id, v.option3_value_id),
                     'mediaId', v.media_id)
                     ORDER BY v.position, v.id), '[]'::json)
              FROM catalog.variants v
             WHERE v.shop_id = p.shop_id AND v.product_id = p.id) AS variants,
           (SELECT coalesce(json_agg(json_build_object(
                     'id', m.id, 'mediaType', m.media_type, 'sourceUrl', m.source_url,
                     'alt', m.alt, 'position', m.position, 'status', m.status,
                     'width', m.width, 'height', m.height)
                     ORDER BY m.position), '[]'::json)
              FROM catalog.product_media m
             WHERE m.shop_id = p.shop_id AND m.product_id = p.id) AS media
      FROM catalog.products p
     WHERE p.shop_id = $1 AND true
     ORDER BY p.id DESC
     LIMIT 51
```

</details>
<details><summary>orders (Ma8Ybw)</summary>

```sql

    SELECT o.id, o.number, o.source, o.status, o.confirmation_status, o.financial_status,
           o.fulfillment_status, o.stage, o.payment_method, o.currency, o.subtotal, o.discount,
           o.shipping, o.cod_fee, o.tax_rate, o.total_tax, o.shipping_tax, o.transfer_discount,
           o.total, o.discount_codes, o.amount_paid,
           o.amount_refunded, o.cod_amount, o.advance_due, o.bank_account, o.customer_id,
           o.phone, o.email, o.shipping_address, o.location_id, o.note, o.tags, o.cancel_reason,
           o.risk_score, o.risk_level, o.risk_reasons, o.customer_erased_at,
           o.link_token_hash IS NOT NULL AS has_link, o.link_expires_at,
           o.agreed_policy_versions::text[] AS agreed_policy_versions,
           host(o.client_ip) AS client_ip, o.client_user_agent, o.confirmed_at,
           o.packed_at, o.cancelled_at, o.paid_at, o.closed_at, o.version, o.created_at,
           o.updated_at,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', l.id, 'position', l.position, 'variant_id', l.variant_id,
                      'product_id', l.product_id, 'title', l.title,
                      'variant_title', l.variant_title, 'sku', l.sku, 'quantity', l.quantity,
                      'unit_price', l.unit_price::text, 'total', l.total::text,
                      'weight_grams', l.weight_grams,
                      'fulfilled_quantity', l.fulfilled_quantity, 'taxable', l.taxable,
                      'tax_rate', l.tax_rate, 'tax', l.tax::text) ORDER BY l.position)
               FROM orders.lines l
              WHERE l.shop_id = o.shop_id AND l.order_id = o.id), '[]') AS lines,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', f.id, 'status', f.status, 'location_id', f.location_id,
                      'tracking_company', f.tracking_company,
                      'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url,
                      'lines', (SELECT json_agg(json_build_object(
                                         'line_id', fl.line_id, 'quantity', fl.quantity,
                                         'restocked_quantity', fl.restocked_quantity))
                                  FROM orders.fulfillment_lines fl
                                 WHERE fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id),
                      'shipped_at', f.shipped_at, 'delivered_at', f.delivered_at,
                      'returning_at', f.returning_at, 'returned_at', f.returned_at,
                      'lost_at', f.lost_at, 'courier_charges', f.courier_charges::text,
                      'claim_status', f.claim_status, 'claim_amount', f.claim_amount::text,
                      'claim_paid', f.claim_paid::text, 'claim_note', f.claim_note,
                      'claimed_at', f.claimed_at, 'claim_settled_at', f.claim_settled_at,
                      'version', f.version, 'created_at', f.created_at,
                      'updated_at', f.updated_at) ORDER BY f.id)
               FROM orders.fulfillments f
              WHERE f.shop_id = o.shop_id AND f.order_id = o.id), '[]') AS fulfillments,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', r.id, 'amount', r.amount::text, 'tax', r.tax::text,
                      'method', r.method,
                      'reference', r.reference, 'note', r.note, 'actor_kind', r.actor_kind,
                      'actor_id', r.actor_id, 'created_at', r.created_at) ORDER BY r.id)
               FROM orders.refunds r
              WHERE r.shop_id = o.shop_id AND r.order_id = o.id), '[]') AS refunds
      FROM orders.orders o
     WHERE o.shop_id = $1 AND true
     ORDER BY o.id DESC
     LIMIT 51
```

</details>
<details><summary>orders (NvBPVt)</summary>

```sql

    SELECT o.id, o.number, o.source, o.status, o.confirmation_status, o.financial_status,
           o.fulfillment_status, o.stage, o.payment_method, o.currency, o.subtotal, o.discount,
           o.shipping, o.cod_fee, o.tax_rate, o.total_tax, o.shipping_tax, o.transfer_discount,
           o.total, o.discount_codes, o.amount_paid,
           o.amount_refunded, o.cod_amount, o.advance_due, o.bank_account, o.customer_id,
           o.phone, o.email, o.shipping_address, o.location_id, o.note, o.tags, o.cancel_reason,
           o.risk_score, o.risk_level, o.risk_reasons, o.customer_erased_at,
           o.link_token_hash IS NOT NULL AS has_link, o.link_expires_at,
           o.agreed_policy_versions::text[] AS agreed_policy_versions,
           host(o.client_ip) AS client_ip, o.client_user_agent, o.confirmed_at,
           o.packed_at, o.cancelled_at, o.paid_at, o.closed_at, o.version, o.created_at,
           o.updated_at,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', l.id, 'position', l.position, 'variant_id', l.variant_id,
                      'product_id', l.product_id, 'title', l.title,
                      'variant_title', l.variant_title, 'sku', l.sku, 'quantity', l.quantity,
                      'unit_price', l.unit_price::text, 'total', l.total::text,
                      'weight_grams', l.weight_grams,
                      'fulfilled_quantity', l.fulfilled_quantity, 'taxable', l.taxable,
                      'tax_rate', l.tax_rate, 'tax', l.tax::text) ORDER BY l.position)
               FROM orders.lines l
              WHERE l.shop_id = o.shop_id AND l.order_id = o.id), '[]') AS lines,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', f.id, 'status', f.status, 'location_id', f.location_id,
                      'tracking_company', f.tracking_company,
                      'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url,
                      'lines', (SELECT json_agg(json_build_object(
                                         'line_id', fl.line_id, 'quantity', fl.quantity,
                                         'restocked_quantity', fl.restocked_quantity))
                                  FROM orders.fulfillment_lines fl
                                 WHERE fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id),
                      'shipped_at', f.shipped_at, 'delivered_at', f.delivered_at,
                      'returning_at', f.returning_at, 'returned_at', f.returned_at,
                      'lost_at', f.lost_at, 'courier_charges', f.courier_charges::text,
                      'claim_status', f.claim_status, 'claim_amount', f.claim_amount::text,
                      'claim_paid', f.claim_paid::text, 'claim_note', f.claim_note,
                      'claimed_at', f.claimed_at, 'claim_settled_at', f.claim_settled_at,
                      'version', f.version, 'created_at', f.created_at,
                      'updated_at', f.updated_at) ORDER BY f.id)
               FROM orders.fulfillments f
              WHERE f.shop_id = o.shop_id AND f.order_id = o.id), '[]') AS fulfillments,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', r.id, 'amount', r.amount::text, 'tax', r.tax::text,
                      'method', r.method,
                      'reference', r.reference, 'note', r.note, 'actor_kind', r.actor_kind,
                      'actor_id', r.actor_id, 'created_at', r.created_at) ORDER BY r.id)
               FROM orders.refunds r
              WHERE r.shop_id = o.shop_id AND r.order_id = o.id), '[]') AS refunds
      FROM orders.orders o
     WHERE o.shop_id = $1 AND o.stage = $2
     ORDER BY o.id DESC
     LIMIT 51
```

</details>
<details><summary>orders (OCnQgX)</summary>

```sql

    SELECT o.id, o.number, o.source, o.status, o.confirmation_status, o.financial_status,
           o.fulfillment_status, o.stage, o.payment_method, o.currency, o.subtotal, o.discount,
           o.shipping, o.cod_fee, o.tax_rate, o.total_tax, o.shipping_tax, o.transfer_discount,
           o.total, o.discount_codes, o.amount_paid,
           o.amount_refunded, o.cod_amount, o.advance_due, o.bank_account, o.customer_id,
           o.phone, o.email, o.shipping_address, o.location_id, o.note, o.tags, o.cancel_reason,
           o.risk_score, o.risk_level, o.risk_reasons, o.customer_erased_at,
           o.link_token_hash IS NOT NULL AS has_link, o.link_expires_at,
           o.agreed_policy_versions::text[] AS agreed_policy_versions,
           host(o.client_ip) AS client_ip, o.client_user_agent, o.confirmed_at,
           o.packed_at, o.cancelled_at, o.paid_at, o.closed_at, o.version, o.created_at,
           o.updated_at,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', l.id, 'position', l.position, 'variant_id', l.variant_id,
                      'product_id', l.product_id, 'title', l.title,
                      'variant_title', l.variant_title, 'sku', l.sku, 'quantity', l.quantity,
                      'unit_price', l.unit_price::text, 'total', l.total::text,
                      'weight_grams', l.weight_grams,
                      'fulfilled_quantity', l.fulfilled_quantity, 'taxable', l.taxable,
                      'tax_rate', l.tax_rate, 'tax', l.tax::text) ORDER BY l.position)
               FROM orders.lines l
              WHERE l.shop_id = o.shop_id AND l.order_id = o.id), '[]') AS lines,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', f.id, 'status', f.status, 'location_id', f.location_id,
                      'tracking_company', f.tracking_company,
                      'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url,
                      'lines', (SELECT json_agg(json_build_object(
                                         'line_id', fl.line_id, 'quantity', fl.quantity,
                                         'restocked_quantity', fl.restocked_quantity))
                                  FROM orders.fulfillment_lines fl
                                 WHERE fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id),
                      'shipped_at', f.shipped_at, 'delivered_at', f.delivered_at,
                      'returning_at', f.returning_at, 'returned_at', f.returned_at,
                      'lost_at', f.lost_at, 'courier_charges', f.courier_charges::text,
                      'claim_status', f.claim_status, 'claim_amount', f.claim_amount::text,
                      'claim_paid', f.claim_paid::text, 'claim_note', f.claim_note,
                      'claimed_at', f.claimed_at, 'claim_settled_at', f.claim_settled_at,
                      'version', f.version, 'created_at', f.created_at,
                      'updated_at', f.updated_at) ORDER BY f.id)
               FROM orders.fulfillments f
              WHERE f.shop_id = o.shop_id AND f.order_id = o.id), '[]') AS fulfillments,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', r.id, 'amount', r.amount::text, 'tax', r.tax::text,
                      'method', r.method,
                      'reference', r.reference, 'note', r.note, 'actor_kind', r.actor_kind,
                      'actor_id', r.actor_id, 'created_at', r.created_at) ORDER BY r.id)
               FROM orders.refunds r
              WHERE r.shop_id = o.shop_id AND r.order_id = o.id), '[]') AS refunds
      FROM orders.orders o
     WHERE o.shop_id = $1 AND o.risk_level = $2
     ORDER BY o.id DESC
     LIMIT 51
```

</details>
<details><summary>orders (4IRwGI)</summary>

```sql

    SELECT o.id, o.number, o.source, o.status, o.confirmation_status, o.financial_status,
           o.fulfillment_status, o.stage, o.payment_method, o.currency, o.subtotal, o.discount,
           o.shipping, o.cod_fee, o.tax_rate, o.total_tax, o.shipping_tax, o.transfer_discount,
           o.total, o.discount_codes, o.amount_paid,
           o.amount_refunded, o.cod_amount, o.advance_due, o.bank_account, o.customer_id,
           o.phone, o.email, o.shipping_address, o.location_id, o.note, o.tags, o.cancel_reason,
           o.risk_score, o.risk_level, o.risk_reasons, o.customer_erased_at,
           o.link_token_hash IS NOT NULL AS has_link, o.link_expires_at,
           o.agreed_policy_versions::text[] AS agreed_policy_versions,
           host(o.client_ip) AS client_ip, o.client_user_agent, o.confirmed_at,
           o.packed_at, o.cancelled_at, o.paid_at, o.closed_at, o.version, o.created_at,
           o.updated_at,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', l.id, 'position', l.position, 'variant_id', l.variant_id,
                      'product_id', l.product_id, 'title', l.title,
                      'variant_title', l.variant_title, 'sku', l.sku, 'quantity', l.quantity,
                      'unit_price', l.unit_price::text, 'total', l.total::text,
                      'weight_grams', l.weight_grams,
                      'fulfilled_quantity', l.fulfilled_quantity, 'taxable', l.taxable,
                      'tax_rate', l.tax_rate, 'tax', l.tax::text) ORDER BY l.position)
               FROM orders.lines l
              WHERE l.shop_id = o.shop_id AND l.order_id = o.id), '[]') AS lines,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', f.id, 'status', f.status, 'location_id', f.location_id,
                      'tracking_company', f.tracking_company,
                      'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url,
                      'lines', (SELECT json_agg(json_build_object(
                                         'line_id', fl.line_id, 'quantity', fl.quantity,
                                         'restocked_quantity', fl.restocked_quantity))
                                  FROM orders.fulfillment_lines fl
                                 WHERE fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id),
                      'shipped_at', f.shipped_at, 'delivered_at', f.delivered_at,
                      'returning_at', f.returning_at, 'returned_at', f.returned_at,
                      'lost_at', f.lost_at, 'courier_charges', f.courier_charges::text,
                      'claim_status', f.claim_status, 'claim_amount', f.claim_amount::text,
                      'claim_paid', f.claim_paid::text, 'claim_note', f.claim_note,
                      'claimed_at', f.claimed_at, 'claim_settled_at', f.claim_settled_at,
                      'version', f.version, 'created_at', f.created_at,
                      'updated_at', f.updated_at) ORDER BY f.id)
               FROM orders.fulfillments f
              WHERE f.shop_id = o.shop_id AND f.order_id = o.id), '[]') AS fulfillments,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', r.id, 'amount', r.amount::text, 'tax', r.tax::text,
                      'method', r.method,
                      'reference', r.reference, 'note', r.note, 'actor_kind', r.actor_kind,
                      'actor_id', r.actor_id, 'created_at', r.created_at) ORDER BY r.id)
               FROM orders.refunds r
              WHERE r.shop_id = o.shop_id AND r.order_id = o.id), '[]') AS refunds
      FROM orders.orders o
     WHERE o.shop_id = $1 AND o.customer_id = $2
     ORDER BY o.id DESC
     LIMIT 51
```

</details>
<details><summary>orders (z34rju)</summary>

```sql

    SELECT o.id, o.number, o.source, o.status, o.confirmation_status, o.financial_status,
           o.fulfillment_status, o.stage, o.payment_method, o.currency, o.subtotal, o.discount,
           o.shipping, o.cod_fee, o.tax_rate, o.total_tax, o.shipping_tax, o.transfer_discount,
           o.total, o.discount_codes, o.amount_paid,
           o.amount_refunded, o.cod_amount, o.advance_due, o.bank_account, o.customer_id,
           o.phone, o.email, o.shipping_address, o.location_id, o.note, o.tags, o.cancel_reason,
           o.risk_score, o.risk_level, o.risk_reasons, o.customer_erased_at,
           o.link_token_hash IS NOT NULL AS has_link, o.link_expires_at,
           o.agreed_policy_versions::text[] AS agreed_policy_versions,
           host(o.client_ip) AS client_ip, o.client_user_agent, o.confirmed_at,
           o.packed_at, o.cancelled_at, o.paid_at, o.closed_at, o.version, o.created_at,
           o.updated_at,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', l.id, 'position', l.position, 'variant_id', l.variant_id,
                      'product_id', l.product_id, 'title', l.title,
                      'variant_title', l.variant_title, 'sku', l.sku, 'quantity', l.quantity,
                      'unit_price', l.unit_price::text, 'total', l.total::text,
                      'weight_grams', l.weight_grams,
                      'fulfilled_quantity', l.fulfilled_quantity, 'taxable', l.taxable,
                      'tax_rate', l.tax_rate, 'tax', l.tax::text) ORDER BY l.position)
               FROM orders.lines l
              WHERE l.shop_id = o.shop_id AND l.order_id = o.id), '[]') AS lines,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', f.id, 'status', f.status, 'location_id', f.location_id,
                      'tracking_company', f.tracking_company,
                      'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url,
                      'lines', (SELECT json_agg(json_build_object(
                                         'line_id', fl.line_id, 'quantity', fl.quantity,
                                         'restocked_quantity', fl.restocked_quantity))
                                  FROM orders.fulfillment_lines fl
                                 WHERE fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id),
                      'shipped_at', f.shipped_at, 'delivered_at', f.delivered_at,
                      'returning_at', f.returning_at, 'returned_at', f.returned_at,
                      'lost_at', f.lost_at, 'courier_charges', f.courier_charges::text,
                      'claim_status', f.claim_status, 'claim_amount', f.claim_amount::text,
                      'claim_paid', f.claim_paid::text, 'claim_note', f.claim_note,
                      'claimed_at', f.claimed_at, 'claim_settled_at', f.claim_settled_at,
                      'version', f.version, 'created_at', f.created_at,
                      'updated_at', f.updated_at) ORDER BY f.id)
               FROM orders.fulfillments f
              WHERE f.shop_id = o.shop_id AND f.order_id = o.id), '[]') AS fulfillments,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', r.id, 'amount', r.amount::text, 'tax', r.tax::text,
                      'method', r.method,
                      'reference', r.reference, 'note', r.note, 'actor_kind', r.actor_kind,
                      'actor_id', r.actor_id, 'created_at', r.created_at) ORDER BY r.id)
               FROM orders.refunds r
              WHERE r.shop_id = o.shop_id AND r.order_id = o.id), '[]') AS refunds
      FROM orders.orders o
     WHERE o.shop_id = $1 AND o.id < $2
     ORDER BY o.id DESC
     LIMIT 51
```

</details>
<details><summary>orders (TYq93l)</summary>

```sql

    SELECT o.id, o.number, o.source, o.status, o.confirmation_status, o.financial_status,
           o.fulfillment_status, o.stage, o.payment_method, o.currency, o.subtotal, o.discount,
           o.shipping, o.cod_fee, o.tax_rate, o.total_tax, o.shipping_tax, o.transfer_discount,
           o.total, o.discount_codes, o.amount_paid,
           o.amount_refunded, o.cod_amount, o.advance_due, o.bank_account, o.customer_id,
           o.phone, o.email, o.shipping_address, o.location_id, o.note, o.tags, o.cancel_reason,
           o.risk_score, o.risk_level, o.risk_reasons, o.customer_erased_at,
           o.link_token_hash IS NOT NULL AS has_link, o.link_expires_at,
           o.agreed_policy_versions::text[] AS agreed_policy_versions,
           host(o.client_ip) AS client_ip, o.client_user_agent, o.confirmed_at,
           o.packed_at, o.cancelled_at, o.paid_at, o.closed_at, o.version, o.created_at,
           o.updated_at,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', l.id, 'position', l.position, 'variant_id', l.variant_id,
                      'product_id', l.product_id, 'title', l.title,
                      'variant_title', l.variant_title, 'sku', l.sku, 'quantity', l.quantity,
                      'unit_price', l.unit_price::text, 'total', l.total::text,
                      'weight_grams', l.weight_grams,
                      'fulfilled_quantity', l.fulfilled_quantity, 'taxable', l.taxable,
                      'tax_rate', l.tax_rate, 'tax', l.tax::text) ORDER BY l.position)
               FROM orders.lines l
              WHERE l.shop_id = o.shop_id AND l.order_id = o.id), '[]') AS lines,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', f.id, 'status', f.status, 'location_id', f.location_id,
                      'tracking_company', f.tracking_company,
                      'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url,
                      'lines', (SELECT json_agg(json_build_object(
                                         'line_id', fl.line_id, 'quantity', fl.quantity,
                                         'restocked_quantity', fl.restocked_quantity))
                                  FROM orders.fulfillment_lines fl
                                 WHERE fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id),
                      'shipped_at', f.shipped_at, 'delivered_at', f.delivered_at,
                      'returning_at', f.returning_at, 'returned_at', f.returned_at,
                      'lost_at', f.lost_at, 'courier_charges', f.courier_charges::text,
                      'claim_status', f.claim_status, 'claim_amount', f.claim_amount::text,
                      'claim_paid', f.claim_paid::text, 'claim_note', f.claim_note,
                      'claimed_at', f.claimed_at, 'claim_settled_at', f.claim_settled_at,
                      'version', f.version, 'created_at', f.created_at,
                      'updated_at', f.updated_at) ORDER BY f.id)
               FROM orders.fulfillments f
              WHERE f.shop_id = o.shop_id AND f.order_id = o.id), '[]') AS fulfillments,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', r.id, 'amount', r.amount::text, 'tax', r.tax::text,
                      'method', r.method,
                      'reference', r.reference, 'note', r.note, 'actor_kind', r.actor_kind,
                      'actor_id', r.actor_id, 'created_at', r.created_at) ORDER BY r.id)
               FROM orders.refunds r
              WHERE r.shop_id = o.shop_id AND r.order_id = o.id), '[]') AS refunds
      FROM orders.orders o
     WHERE o.shop_id = $1 AND o.id = $2
     ORDER BY o.id DESC
     
```

</details>
<details><summary>orders (CwvuF4)</summary>

```sql

    SELECT o.id, o.number, o.source, o.status, o.confirmation_status, o.financial_status,
           o.fulfillment_status, o.stage, o.payment_method, o.currency, o.subtotal, o.discount,
           o.shipping, o.cod_fee, o.tax_rate, o.total_tax, o.shipping_tax, o.transfer_discount,
           o.total, o.discount_codes, o.amount_paid,
           o.amount_refunded, o.cod_amount, o.advance_due, o.bank_account, o.customer_id,
           o.phone, o.email, o.shipping_address, o.location_id, o.note, o.tags, o.cancel_reason,
           o.risk_score, o.risk_level, o.risk_reasons, o.customer_erased_at,
           o.link_token_hash IS NOT NULL AS has_link, o.link_expires_at,
           o.agreed_policy_versions::text[] AS agreed_policy_versions,
           host(o.client_ip) AS client_ip, o.client_user_agent, o.confirmed_at,
           o.packed_at, o.cancelled_at, o.paid_at, o.closed_at, o.version, o.created_at,
           o.updated_at,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', l.id, 'position', l.position, 'variant_id', l.variant_id,
                      'product_id', l.product_id, 'title', l.title,
                      'variant_title', l.variant_title, 'sku', l.sku, 'quantity', l.quantity,
                      'unit_price', l.unit_price::text, 'total', l.total::text,
                      'weight_grams', l.weight_grams,
                      'fulfilled_quantity', l.fulfilled_quantity, 'taxable', l.taxable,
                      'tax_rate', l.tax_rate, 'tax', l.tax::text) ORDER BY l.position)
               FROM orders.lines l
              WHERE l.shop_id = o.shop_id AND l.order_id = o.id), '[]') AS lines,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', f.id, 'status', f.status, 'location_id', f.location_id,
                      'tracking_company', f.tracking_company,
                      'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url,
                      'lines', (SELECT json_agg(json_build_object(
                                         'line_id', fl.line_id, 'quantity', fl.quantity,
                                         'restocked_quantity', fl.restocked_quantity))
                                  FROM orders.fulfillment_lines fl
                                 WHERE fl.shop_id = f.shop_id AND fl.fulfillment_id = f.id),
                      'shipped_at', f.shipped_at, 'delivered_at', f.delivered_at,
                      'returning_at', f.returning_at, 'returned_at', f.returned_at,
                      'lost_at', f.lost_at, 'courier_charges', f.courier_charges::text,
                      'claim_status', f.claim_status, 'claim_amount', f.claim_amount::text,
                      'claim_paid', f.claim_paid::text, 'claim_note', f.claim_note,
                      'claimed_at', f.claimed_at, 'claim_settled_at', f.claim_settled_at,
                      'version', f.version, 'created_at', f.created_at,
                      'updated_at', f.updated_at) ORDER BY f.id)
               FROM orders.fulfillments f
              WHERE f.shop_id = o.shop_id AND f.order_id = o.id), '[]') AS fulfillments,
           coalesce((
             SELECT json_agg(json_build_object(
                      'id', r.id, 'amount', r.amount::text, 'tax', r.tax::text,
                      'method', r.method,
                      'reference', r.reference, 'note', r.note, 'actor_kind', r.actor_kind,
                      'actor_id', r.actor_id, 'created_at', r.created_at) ORDER BY r.id)
               FROM orders.refunds r
              WHERE r.shop_id = o.shop_id AND r.order_id = o.id), '[]') AS refunds
      FROM orders.orders o
     WHERE o.shop_id = $1 AND o.id = ANY($2::uuid[])
     ORDER BY o.id DESC
     
```

</details>
<details><summary>carts (30HzdJ)</summary>

```sql
select "id", "lines", "note", "attributes", "discount_codes" from "checkout"."carts" where ("checkout"."carts"."shop_id" = $1 and "checkout"."carts"."token_hash" = $2 and "checkout"."carts"."expires_at" > now())
```

</details>
<details><summary>variants (o7X6mM)</summary>

```sql
select "catalog"."variants"."id", "catalog"."variants"."product_id", "catalog"."products"."title", "catalog"."products"."status", "catalog"."products"."tags", "catalog"."variants"."title", "catalog"."variants"."sku", "catalog"."variants"."price", "catalog"."variants"."weight_grams", "catalog"."variants"."taxable", "catalog"."variants"."tax_code" from "catalog"."variants" inner join "catalog"."products" on ("catalog"."products"."shop_id" = "catalog"."variants"."shop_id" and "catalog"."products"."id" = "catalog"."variants"."product_id") where ("catalog"."variants"."shop_id" = $1 and "catalog"."variants"."id" = ANY($2::uuid[]))
```

</details>
<details><summary>items (V1cr4O)</summary>

```sql

    SELECT i.variant_id, i.tracked, i.inventory_policy,
           l.id AS level_id, l.on_hand, l.committed, l.reserved, l.safety_stock, l.available,
           l.updated_at AS level_updated_at, to_jsonb(loc) AS location
      FROM inventory.items i
      LEFT JOIN (inventory.levels l
                 JOIN inventory.locations loc
                   ON loc.shop_id = l.shop_id AND loc.id = l.location_id AND loc.is_active)
        ON l.shop_id = i.shop_id AND l.variant_id = i.variant_id
     WHERE i.shop_id = $1
       AND i.variant_id = ANY($2::uuid[])
     ORDER BY i.variant_id, loc.is_primary DESC, lower(loc.name), loc.id
```

</details>

Every generic plan is the plan Postgres makes for small, medium and large shops alike.

## The application code before (RLS on, medium shops)

Orders, customers and carts planned every time; products already prepared (ADR-108).

| Operation | Callers | Connection | Calls/s | p50 ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- | --- |
| ProductService.list (50 products) | 1 | direct | 426 | 2.15 | 3.45 | 5.37 |
| ProductService.list (50 products) | 1 | PgBouncer | 400 | 2.27 | 3.90 | 5.39 |
| ProductService.list (50 products) | 16 | PgBouncer | 894 | 17.4 | 26.8 | 32.4 |
| ProductService.list (50 products) | 16 | direct | 820 | 18.5 | 31.0 | 37.3 |
| OrderService.list (50 orders) | 1 | direct | 255 | 3.66 | 5.95 | 7.10 |
| OrderService.list (50 orders) | 1 | PgBouncer | 234 | 4.03 | 6.24 | 7.33 |
| OrderService.get (one order) | 1 | PgBouncer | 454 | 2.16 | 2.77 | 3.27 |
| OrderService.get (one order) | 1 | direct | 581 | 1.65 | 2.27 | 2.76 |
| CustomerService.list (50 customers) | 1 | direct | 944 | 0.95 | 1.73 | 2.73 |
| CustomerService.list (50 customers) | 1 | PgBouncer | 661 | 1.43 | 2.18 | 3.18 |
| CartService.cart (one cart) | 1 | PgBouncer | 303 | 3.23 | 4.13 | 4.83 |
| CartService.cart (one cart) | 1 | direct | 392 | 2.44 | 3.45 | 4.39 |
| Tenant transaction around select 1 | 1 | direct | 4,752 | 0.19 | 0.27 | 0.42 |
| Tenant transaction around select 1 | 1 | PgBouncer | 3,151 | 0.30 | 0.40 | 0.62 |
| select 1 | 1 | PgBouncer | 9,609 | 0.09 | 0.14 | 0.21 |
| select 1 | 1 | direct | 14,644 | 0.06 | 0.09 | 0.13 |

## The application code after (RLS on, medium shops)

Orders and carts prepared, pages' sizes written into their text.

| Operation | Callers | Connection | Calls/s | p50 ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- | --- |
| ProductService.list (50 products) | 1 | direct | 424 | 2.14 | 3.78 | 5.26 |
| ProductService.list (50 products) | 1 | PgBouncer | 390 | 2.35 | 4.02 | 5.54 |
| ProductService.list (50 products) | 16 | PgBouncer | 908 | 17.2 | 26.5 | 32.4 |
| ProductService.list (50 products) | 16 | direct | 802 | 18.9 | 31.8 | 38.4 |
| OrderService.list (50 orders) | 1 | direct | 343 | 2.69 | 4.78 | 5.55 |
| OrderService.list (50 orders) | 1 | PgBouncer | 325 | 2.84 | 4.88 | 5.73 |
| OrderService.get (one order) | 1 | PgBouncer | 1,476 | 0.60 | 1.09 | 1.77 |
| OrderService.get (one order) | 1 | direct | 1,821 | 0.49 | 0.83 | 1.20 |
| CustomerService.list (50 customers) | 1 | direct | 964 | 0.94 | 1.56 | 2.64 |
| CustomerService.list (50 customers) | 1 | PgBouncer | 616 | 1.55 | 2.34 | 3.39 |
| CartService.cart (one cart) | 1 | PgBouncer | 325 | 3.00 | 3.99 | 4.58 |
| CartService.cart (one cart) | 1 | direct | 426 | 2.26 | 3.15 | 4.04 |
| Tenant transaction around select 1 | 1 | direct | 4,741 | 0.19 | 0.28 | 0.42 |
| Tenant transaction around select 1 | 1 | PgBouncer | 3,077 | 0.30 | 0.42 | 0.67 |
| select 1 | 1 | PgBouncer | 9,230 | 0.10 | 0.15 | 0.22 |
| select 1 | 1 | direct | 14,304 | 0.06 | 0.10 | 0.14 |

## The order page's loaders (ADR-122)

Run again later the same day, on the dataset with each order's timeline added: 3,390,948 events,
4.68 an order (`orders.order_events`, 891 MB), the rest as before, loaded in 151 s. The timeline
and the location's loader were each prepared, checked, and timed before and after; the location's
loader was then left planned ([ADR-122](../../architecture/13-decision-log.md#adr-122--an-orders-timeline-is-read-through-a-prepared-statement-too-checked-by-the-benchmark-on-orders-with-their-timelines-its-locations-loader-stays-planned-as-customers-statements-do)).

### Generic plans against each shop size (RLS on, direct)

| Operation | Statement | Shops | Generic plan | Same plan for the shop's values? | Planning ms | Execution ms | Generic / custom runs of 10 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OrderService.timeline (an order's 50 newest events) | order_events (-zrm72) | small | Index Scan on order_events_order_idx | yes | 0.07 | 0.02 | 5 / 5 |
| LocationService.getMany (an order's location) | locations (dFjNmG) | small | Index Scan on locations_name_key | yes | 0.08 | 0.03 | 5 / 5 |
| OrderService.timeline (an order's 50 newest events) | order_events (-zrm72) | medium | Index Scan on order_events_order_idx | yes | 0.12 | 0.03 | 5 / 5 |
| LocationService.getMany (an order's location) | locations (dFjNmG) | medium | Index Scan on locations_name_key | yes | 0.07 | 0.02 | 5 / 5 |
| OrderService.timeline (an order's 50 newest events) | order_events (-zrm72) | large | Index Scan on order_events_order_idx | yes | 0.06 | 0.02 | 5 / 5 |
| LocationService.getMany (an order's location) | locations (dFjNmG) | large | Index Scan on locations_name_key | yes | 0.09 | 0.03 | 5 / 5 |

<details><summary>order_events (-zrm72)</summary>

```sql

        SELECT id, order_id, kind, message, actor_kind, actor_id, created_at
          FROM "orders"."order_events"
         WHERE shop_id = $1 AND order_id = $2
           
         ORDER BY id DESC
         LIMIT 51
```

</details>
<details><summary>locations (dFjNmG)</summary>

```sql
select "shop_id", "id", "name", "address1", "address2", "city", "province_code", "zip", "phone", "is_primary", "is_active", "fulfills_online_orders", "deactivated_at", "version", "created_at", "updated_at" from "inventory"."locations" where ("inventory"."locations"."shop_id" = $1 and "inventory"."locations"."id" = ANY($2::uuid[]))
```

</details>

### Before: planned every time (RLS on, medium shops)

| Operation | Callers | Connection | Calls/s | p50 ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- | --- |
| OrderService.get (one order) | 1 | PgBouncer | 1,429 | 0.63 | 1.10 | 1.69 |
| OrderService.get (one order) | 1 | direct | 1,861 | 0.49 | 0.80 | 1.16 |
| OrderService.timeline (an order's 50 newest events) | 1 | direct | 2,425 | 0.37 | 0.62 | 0.93 |
| OrderService.timeline (an order's 50 newest events) | 1 | PgBouncer | 1,881 | 0.48 | 0.78 | 1.19 |
| LocationService.getMany (an order's location) | 1 | PgBouncer | 1,317 | 0.64 | 1.46 | 1.97 |
| LocationService.getMany (an order's location) | 1 | direct | 1,702 | 0.51 | 1.03 | 1.52 |

### After: both prepared (RLS on, medium shops)

| Operation | Callers | Connection | Calls/s | p50 ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- | --- |
| OrderService.get (one order) | 1 | PgBouncer | 1,233 | 0.70 | 1.52 | 1.97 |
| OrderService.get (one order) | 1 | direct | 1,870 | 0.48 | 0.82 | 1.23 |
| OrderService.timeline (an order's 50 newest events) | 1 | direct | 3,218 | 0.27 | 0.44 | 0.65 |
| OrderService.timeline (an order's 50 newest events) | 1 | PgBouncer | 2,296 | 0.39 | 0.58 | 0.96 |
| LocationService.getMany (an order's location) | 1 | PgBouncer | 1,310 | 0.68 | 1.21 | 1.96 |
| LocationService.getMany (an order's location) | 1 | direct | 1,801 | 0.50 | 0.83 | 1.71 |

## An order's timeline with its comments (ADR-128)

Run again with comments on the benchmark's orders, one on every fourth and a second on every
twelfth (240,560 in `orders.order_comments`, 67 MB, beside the 3,390,948 events), the rest as
before, loaded in 146 s. The timeline's statement reads both tables, merged by ID
([ADR-128](../../architecture/13-decision-log.md#adr-128--staff-and-apps-comment-on-an-orders-timeline-each-comment-its-authors-to-change-kept-apart-from-the-events-and-read-among-them-every-entry-saying-who-made-it-and-comments-going-with-the-customers-details-in-an-erasure)).

### Generic plans against each shop size (RLS on, direct)

| Operation | Statement | Shops | Generic plan | Same plan for the shop's values? | Planning ms | Execution ms | Generic / custom runs of 10 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OrderService.timeline (an order's 50 newest events) | order_events (SELLB1) | small | Index Scan on order_events_order_idx → Index Scan on order_comments_order_idx | yes | 0.17 | 0.05 | 5 / 5 |
| OrderService.timeline (an order's 50 newest events) | order_events (SELLB1) | medium | Index Scan on order_events_order_idx → Index Scan on order_comments_order_idx | yes | 0.14 | 0.05 | 5 / 5 |
| OrderService.timeline (an order's 50 newest events) | order_events (SELLB1) | large | Index Scan on order_events_order_idx → Index Scan on order_comments_order_idx | yes | 0.16 | 0.06 | 5 / 5 |

<details><summary>order_events (SELLB1)</summary>

```sql

        SELECT id, order_id, kind, message, actor_kind, actor_id, created_at, comment, edited_at
          FROM (SELECT id, order_id, kind, message, actor_kind, actor_id, created_at,
                       false AS comment, NULL::timestamptz AS edited_at
                  FROM "orders"."order_events"
                 WHERE shop_id = $1 AND order_id = $2 
                UNION ALL
                SELECT id, order_id, 'comment', message, author_kind, author_id, created_at,
                       true, edited_at
                  FROM "orders"."order_comments"
                 WHERE shop_id = $3 AND order_id = $4 ) AS entries
         ORDER BY id DESC
         LIMIT 51
```

</details>

### The application code (RLS on, medium shops)

| Operation | Callers | Connection | Calls/s | p50 ms | p95 ms | p99 ms |
| --- | --- | --- | --- | --- | --- | --- |
| OrderService.timeline (an order's 50 newest events) | 1 | direct | 3,230 | 0.28 | 0.41 | 0.59 |
| OrderService.timeline (an order's 50 newest events) | 1 | PgBouncer | 2,274 | 0.40 | 0.59 | 0.90 |

## An order and the order it was merged into (ADR-132)

Run again after an order merged into another came to name it: the statement that reads an order,
and a page of them, looks up the number of the order each joined by its primary key, a second
`orders_pkey` scan in the plan that finds nothing for orders never merged
([ADR-132](../../architecture/13-decision-log.md#adr-132--an-order-its-customer-placed-twice-is-merged-into-the-other-while-both-wait-to-be-packed-the-other-takes-its-items-and-discount-and-keeps-its-own-delivery-charge-as-one-parcel-the-order-merged-is-cancelled-as-merged-naming-it-and-counts-for-nothing-in-its-customers-history)).
Every generic plan is still the plan Postgres makes for each shop's own values, and they take as
long as before: an order 0.13–0.21 ms to run, 50 of them 1.46–1.50 ms.

### Generic plans against each shop size (RLS on, direct)

| Operation | Statement | Shops | Generic plan | Same plan for the shop's values? | Planning ms | Execution ms | Generic / custom runs of 10 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OrderService.list (50 orders) | orders (Yt1Jyp) | small | Index Scan on orders_pkey → Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.43 | 1.47 | 5 / 5 |
| OrderService.get (one order) | orders (G6xoO7) | small | Index Scan on orders_pkey → Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.42 | 0.13 | 5 / 5 |
| OrderService.list (50 orders) | orders (Yt1Jyp) | medium | Index Scan on orders_pkey → Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.45 | 1.46 | 5 / 5 |
| OrderService.get (one order) | orders (G6xoO7) | medium | Index Scan on orders_pkey → Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.46 | 0.21 | 5 / 5 |
| OrderService.list (50 orders) | orders (Yt1Jyp) | large | Index Scan on orders_pkey → Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.44 | 1.50 | 5 / 5 |
| OrderService.get (one order) | orders (G6xoO7) | large | Index Scan on orders_pkey → Index Scan on orders_pkey → Index Scan on lines_position_key → Index Scan on fulfillments_order_idx → Index Scan on fulfillment_lines_pkey → Index Scan on refunds_order_idx | yes | 0.42 | 0.14 | 5 / 5 |
