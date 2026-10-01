// Mutations that would hurt most in the wrong hands, by GraphQL field name: staff must have proved
// who they are lately to run them (ADR-103). See docs/engineering/conventions.md.
const SENSITIVE = new Set<string>();

/**
 * Marks a mutation that would hurt most in the wrong hands, such as letting staff go, changing
 * where transfers are paid or giving out customers' data: staff who have not proved who they are
 * within `REAUTHENTICATION_WINDOW_MS` are refused with `REAUTHENTICATION_REQUIRED`, and
 * re-authenticate. Apps are not asked. Put it on the resolver method, whose name must be the
 * mutation's.
 */
export function RequireRecentAuthentication(): MethodDecorator {
  return (_target, propertyKey) => {
    SENSITIVE.add(String(propertyKey));
  };
}

/** The mutations marked with {@link RequireRecentAuthentication}, by field name. */
export function mutationsRequiringRecentAuthentication(): ReadonlySet<string> {
  return SENSITIVE;
}
