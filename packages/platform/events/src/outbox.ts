import type { Tx } from '@hatti/db';
import { newId } from '@hatti/ids';
import { context, propagation } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';
import { currentActor } from './activity.js';
import type { DomainEvent, NewDomainEvent } from './event.js';

/**
 * Records an event in the caller's transaction, so it is published if and only if the change it
 * describes commits. Call it inside a tenant transaction for `shopId`; row-level security rejects
 * events for any other shop. Appended while a request's actor is set ({@link actingAs}), it is
 * on the shop's activity log too, by them (ADR-256).
 */
export async function appendEvent<TPayload extends object>(
  tx: Tx,
  shopId: string,
  event: NewDomainEvent<TPayload>,
): Promise<DomainEvent<TPayload>> {
  const [recorded] = await appendEvents(tx, shopId, [event]);
  return recorded!;
}

/**
 * Records several events with one statement, in order. See {@link appendEvent}. Use it when one
 * change touches many aggregates, such as a stock count across a hundred variants.
 */
export async function appendEvents<TPayload extends object>(
  tx: Tx,
  shopId: string,
  events: readonly NewDomainEvent<TPayload>[],
): Promise<DomainEvent<TPayload>[]> {
  if (events.length === 0) return [];
  const traceparent = currentTraceparent();
  const actor = currentActor();
  const occurredAt = new Date().toISOString();
  const recorded = events.map((event): DomainEvent<TPayload> => ({
    id: newId(),
    shopId,
    occurredAt,
    ...event,
    ...(traceparent ? { traceparent } : {}),
  }));
  const rows = sql`
    select *
      from unnest(${sql.param(recorded.map((event) => event.id))}::uuid[],
                  ${sql.param(recorded.map((event) => event.aggregateType))}::text[],
                  ${sql.param(recorded.map((event) => event.aggregateId))}::uuid[],
                  ${sql.param(recorded.map((event) => event.type))}::text[],
                  ${sql.param(recorded.map((event) => JSON.stringify(event.payload)))}::text[])
           as e(id, aggregate_type, aggregate_id, event_type, payload)`;
  // No RETURNING: request code may append to the outbox but not read it.
  const outbox = sql`
    insert into platform.outbox_events
      (id, shop_id, aggregate_type, aggregate_id, event_type, payload, occurred_at, trace_context)
    select e.id, ${shopId}, e.aggregate_type, e.aggregate_id, e.event_type, e.payload::jsonb,
           ${occurredAt}, ${traceparent ?? null}
      from e`;
  // A request's events go on the shop's activity log too, in the same statement.
  await tx.execute(
    actor
      ? sql`
          with e as (${rows}), outbox as (${outbox})
          insert into platform.activity_log
            (shop_id, id, event_type, aggregate_type, aggregate_id, actor_kind, actor_id,
             actor_role, occurred_at)
          select ${shopId}::uuid, e.id, e.event_type, e.aggregate_type, e.aggregate_id,
                 ${actor.kind}::text, ${actor.id}::uuid, ${actor.role}::text,
                 ${occurredAt}::timestamptz
            from e`
      : sql`with e as (${rows}) ${outbox}`,
  );
  return recorded;
}

/** The active trace as a W3C traceparent, or undefined when tracing is off. */
function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}
