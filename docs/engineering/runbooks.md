# Runbooks

What to do when one of Hatti's alerts fires ([ADR-725](../architecture/13-decision-log.md#adr-725--the-admins-objectives-the-outbox-and-sign-ins-are-watched-by-prometheus-rules-kept-in-the-repository-burn-rate-alerts-with-unit-tests-and-a-runbook-each-and-a-grafana-dashboard-whose-queries-ci-parses)). The
alerts are in `ops/prometheus/hatti.rules.yml`, each naming its section here; the dashboard they
point at is `ops/grafana/hatti-core.json` ("Hatti core"). A page wants someone now; a ticket wants
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
