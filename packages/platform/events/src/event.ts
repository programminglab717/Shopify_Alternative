/**
 * A fact about something that happened in one shop, e.g. `product.created`. Payloads are thin:
 * IDs and the changed fields, not full documents. Delivery is at least once and not strictly
 * ordered, so consumers deduplicate on `id` and compare versions where order matters.
 */
export interface DomainEvent<TPayload extends object = Record<string, unknown>> {
  /** UUIDv7, unique per event. */
  id: string;
  /** `<aggregate>.<past-tense verb>`, e.g. "order.confirmed". */
  type: string;
  shopId: string;
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
  /** ISO 8601. */
  occurredAt: string;
}

export type NewDomainEvent<TPayload extends object = Record<string, unknown>> = Pick<
  DomainEvent<TPayload>,
  'type' | 'aggregateType' | 'aggregateId' | 'payload'
>;

/** Structured logger subset; a pino logger fits. */
export interface EventsLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const silentLogger: EventsLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
