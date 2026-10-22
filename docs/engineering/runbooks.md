# Runbooks

What to do when one of Hatti's alerts fires ([ADR-725](../architecture/13-decision-log.md#adr-725--the-admins-objectives-the-outbox-and-sign-ins-are-watched-by-prometheus-rules-kept-in-the-repository-burn-rate-alerts-with-unit-tests-and-a-runbook-each-and-a-grafana-dashboard-whose-queries-ci-parses)). The
alerts are in `ops/prometheus/hatti.rules.yml`, each naming its section here; the dashboard they
point at is `ops/grafana/hatti-core.json` ("Hatti core and storefront"). The storefront's and
checkout's alerts came with [ADR-726](../architecture/13-decision-log.md#adr-726--the-storefronts-and-checkouts-objectives-are-watched-too-the-storefront-sends-its-telemetry-and-the-request-durations-buckets-include-800-ms). The webhooks', confirmations' and bookings'
came with [ADR-727](../architecture/13-decision-log.md#adr-727--webhooks-order-confirmations-and-courier-bookings-are-watched-by-how-long-they-wait-histograms-the-worker-records-with-burn-rate-alerts-against-12-1s-minute-minute-and-five-minutes). A page wants someone now; a ticket wants
someone today.

The objectives are [12 §1](../architecture/12-scalability-and-reliability.md)'s. A surface that has
spent more than half its month's budget freezes risky deploys until the budget recovers.

## HattiAdminGraphqlLatencyBudgetBurn

Admin GraphQL requests are taking over 500 ms often enough to spend the month's latency budget
(5% of requests) early. The `…Slow` alert is the same burn, slower, as a ticket.

1. On the dashboard, see whether the p95 rose for everyone at once (a deploy, the database) or
   climbs with traffic (capacity).
2. In Tempo, find the slow traces of `POST /graphql`: their spans name the resolver and the SQL.
   A statement that plans slowly or scans wants an index or `pnpm bench:db prepared`
   (ADR-111, ADR-122).
3. A deploy within the hour is the first suspect: roll it back, then look.
4. Database saturation (connections, CPU): see whether PgBouncer's pool is full before adding pods,
   which only adds waiting.

## HattiAdminApiErrorBudgetBurn

More than 0.1% of the Admin API's requests end in a server error, fast enough to spend the month's
budget early. The `…Slow` alert is the same, as a ticket.

1. The dashboard's requests by status shows which codes; the API's logs carry each error with its
   request's trace.
2. `503`s with `/readyz` failing mean Postgres or Valkey is unreachable: see their health first.
3. Errors from one module after a deploy: roll it back.

## HattiOutboxLagging

Events have waited over two minutes in the outbox (`HattiOutboxSlow`: over 30 seconds for a
quarter of an hour). Everything the worker does after a change waits with them: order
confirmations, bookings, storefront updates, webhooks.

1. Is the worker running? `HattiCoreMetricsMissing` would say it is not reporting.
2. The relay's log says whether batches fail (`HattiOutboxRelayCannotPublish` pages for that).
3. If the relay publishes but the lag grows, the outbox fills faster than it drains: an import or
   a bulk action. It catches up by itself unless the rate holds. Each worker relays batches of its
   own (`for update skip locked`), so more worker pods drain it faster while Postgres keeps up.

## HattiOutboxEventsParked

Events failed to publish ten times and are parked, published by nothing until someone looks.

1. `select id, event_type, attempts, last_error from platform.outbox_events where published_at is null
   and attempts >= 10` names them and why.
2. Fix the cause (an event too large for the queue, say), then set their `attempts` back to 0 for
   the relay to try again.

## HattiOutboxRelayCannotPublish

The relay has failed to hand batches to the queue in Valkey for ten minutes; events wait in the
outbox meanwhile and nothing is lost.

1. Check Valkey: memory (`maxmemory` reached refuses writes), connections, failover.
2. When it answers again, the relay catches up by itself; watch the lag fall.

## HattiSignInFailuresSpike

Most sign-in attempts are failing, more than one every five seconds: credential stuffing looks like
this.

1. The dashboard's sign-ins by outcome show which step: passwords, codes or passkeys.
2. The identity module's rate limits already slow repeated attempts; the API's logs, by trace,
   say where the attempts come from.
3. If it comes from few networks, block them at the edge. Tell the owners of accounts whose
   passwords were right but stopped at the second step: their passwords are known.

## HattiCoreMetricsMissing

The core's API or worker has sent no metrics for ten minutes. Every other alert is blind to it
meanwhile.

1. Are its pods running and ready? `kubectl get pods`, and their last logs.
2. If they run, their telemetry cannot reach the collector: check `OTEL_EXPORTER_OTLP_ENDPOINT`
   and the collector's health.

## HattiStorefrontErrorBudgetBurn

More than 0.05% of the storefront's requests end in a server error, fast enough to spend the
month's budget early. Shoppers see an error page instead of a shop. The `…Slow` alert is the same,
as a ticket.

1. The dashboard's storefront requests by status show whether it is every shop or a few: the
   storefront's logs carry each error with its host and its request's trace.
2. `/readyz` failing means Valkey is unreachable: the storefront renders from the read models kept
   there, so see Valkey's health first (memory, connections, failover).
3. One shop's errors alone usually mean its theme: a section that fails to render. Its theme's
   last change is the first suspect; taking the theme back to its previous version (ADR-694)
   puts it right.
4. A deploy of the storefront within the hour: roll it back, then look.

## HattiCheckoutErrorBudgetBurn

More than 0.05% of the core's cart, checkout and payment-link calls end in a server error. Shoppers
cannot add to their carts or place orders: this costs shops sales directly. The `…Slow` alert is
the same, as a ticket.

1. The dashboard's checkout panels, and the core API's logs filtered to `/storefront/shops/` and
   `/checkouts/`, name the route and the error.
2. Errors only when sending the checkout form point at what placing an order touches: stock
   reservations, discounts, shipping rates, or a payment gateway that is down. Traces show which
   span failed.
3. Postgres saturated (connections, locks on stock during a drop): see whether PgBouncer's pool
   is full before adding pods. A drop's hot product contending on its stock is what Drop Mode is
   for ([12 §5](../architecture/12-scalability-and-reliability.md#5-drop-mode-flash-sales-and-lawn-launches),
   ADR-019), not built yet.
4. A deploy within the hour: roll it back, then look.

## HattiCheckoutPlacementLatencyBudgetBurn

More than 5% of checkout forms sent take over 800 ms to place the order. Shoppers wait, and some
send the form again or leave. The `…Slow` alert is the same burn, slower, as a ticket.

1. On the dashboard, see whether the checkout p95 rose at once (a deploy, the database, a
   provider) or climbs with traffic (a drop or a sale).
2. In Tempo, find the slow traces of `POST /storefront/shops/:shopId/checkouts/:token`: a slow
   span to a courier's rates or a gateway is the provider's; a slow SQL statement wants its plan
   looked at (`pnpm bench:db prepared`, ADR-111).
3. Contention on one product's stock during a drop looks like this: traces show orders waiting on
   the same rows. Drop Mode's waiting room (12 §5) is the answer, and not built yet.

## HattiStorefrontMetricsMissing

The storefront has sent no metrics for ten minutes. The storefront's alerts are blind to it
meanwhile.

1. Are its pods running and ready? `kubectl get pods`, and their last logs. The storefront refuses
   to start in production without `STOREFRONT_URL`, `REDIS_URL`, `CORE_API_URL` and
   `STOREFRONT_SERVICE_KEY`, and says which is missing.
2. If they run, their telemetry cannot reach the collector: check `OTEL_EXPORTER_OTLP_ENDPOINT`
   and the collector's health.

## HattiWebhookFirstTryBudgetBurn

More than 1% of apps' webhook deliveries are first tried over a minute after they were made, fast
enough to spend the month's budget early. Apps learn of orders and stock late. The `…Slow` alert is
the same, as a ticket. How the apps answer does not count here: this is the worker falling behind.

1. Is the worker running, and is its webhook sweep (every `WEBHOOK_INTERVAL_MS`, 10 seconds) keeping
   up? The dashboard's webhook tries show its pace.
2. Each sweep posts a batch of deliveries in turn: an app answering slowly holds the rest of its
   batch. The worker's traces of the sweep show which address is slow.
3. Many deliveries at once (an import, a bulk action) catch up by themselves; more worker pods take
   batches of their own (`for update skip locked`).

## HattiConfirmationMessageBudgetBurn

More than 1% of order confirmations (the message asking a customer to confirm a cash order, or
saying it was placed) go over a minute after they were due. Customers confirm later, or not at all,
and shops call them instead. The `…Slow` alert is the same, as a ticket.

1. The outbox comes first: a confirmation's minute starts with the order (ADR-728), but it is
   queued only when the worker hears of it, so see `HattiOutboxLagging` and the outbox lag.
2. The messages' sender runs every `MESSAGES_INTERVAL_MS` (5 seconds). Its logs say whether
   WhatsApp's Cloud API or the SMS gateway is refusing or slow; tries put off for a provider count
   as late.
3. A provider's rate limit holds a shop's messages back: the `error` of its pending messages in
   `messaging.messages` says so.

## HattiCourierBookingBudgetBurn

More than 1% of courier bookings take over five minutes from being asked for, at their first try.
Parcels miss the day's pickup. The `…Slow` alert is the same, as a ticket. Bookings that a courier
refused and that were tried again are left out: the courier was not healthy.

1. The dashboard's bookings p95 by courier shows whether one courier is slow or all are.
2. One courier slow: its API answers slowly; the worker's traces of the bookings sweep show its
   calls. Nothing to fix on our side but to tell the shops booking with it.
3. All slow: is the worker's bookings sweep (every `COURIER_BOOKINGS_INTERVAL_MS`, 30 seconds)
   running and keeping up? A large batch booked at once queues behind itself.
