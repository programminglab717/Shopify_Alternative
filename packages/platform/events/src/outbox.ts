import type { Tx } from '@hatti/db';
import { newId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import type { DomainEvent, NewDomainEvent } from './event.js';

/**
 * Records an event in the caller's transaction, so it is published if and only if the change it
 * describes commits. Call it inside a tenant transaction for `shopId`; row-level security rejects
 * events for any other shop.
 */
export async function appendEvent<TPayload extends object>(
  tx: Tx,
  shopId: string,
  event: NewDomainEvent<TPayload>,
): Promise<DomainEvent<TPayload>> {
  const recorded: DomainEvent<TPayload> = {
    id: newId(),
    shopId,
    occurredAt: new Date().toISOString(),
    ...event,
  };
  // No RETURNING: request code may append to the outbox but not read it.
  await tx.execute(sql`
    insert into platform.outbox_events
      (id, shop_id, aggregate_type, aggregate_id, event_type, payload, occurred_at)
    values
      (${recorded.id}, ${shopId}, ${recorded.aggregateType}, ${recorded.aggregateId},
       ${recorded.type}, ${JSON.stringify(recorded.payload)}::jsonb, ${recorded.occurredAt})
  `);
  return recorded;
}
