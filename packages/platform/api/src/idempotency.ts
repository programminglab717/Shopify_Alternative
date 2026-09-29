// Mutations that must not run twice for one intent, such as placing an order, by GraphQL field
// name. The Admin API refuses them without an Idempotency-Key header; see
// docs/engineering/conventions.md.
const REQUIRED = new Set<string>();

/**
 * Marks a mutation that is not safe to repeat, such as placing an order or recording a refund:
 * callers must send an `Idempotency-Key` header, and a retry with the same key gets the first
 * answer back instead of doing the work again. Put it on the resolver method, whose name must be
 * the mutation's.
 */
export function RequireIdempotencyKey(): MethodDecorator {
  return (_target, propertyKey) => {
    REQUIRED.add(String(propertyKey));
  };
}

/** The mutations marked with {@link RequireIdempotencyKey}, by field name. */
export function mutationsRequiringIdempotencyKey(): ReadonlySet<string> {
  return REQUIRED;
}
