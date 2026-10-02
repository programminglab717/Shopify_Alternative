/**
 * Events the messaging module publishes. Payloads are thin: fetch current state through the API.
 */
export const MessagingEvents = {
  MessagingSettingsUpdated: 'messaging_settings.updated',
} as const;

/** The shop changed how its customers are told about their orders. */
export interface MessagingSettingsUpdatedPayload {
  /** What changed: "routing", "language" or "disabled". */
  changed: string[];
  actorKind: 'app' | 'staff';
  actorId: string;
}
