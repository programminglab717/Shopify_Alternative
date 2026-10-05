import type { StatusUpdate } from './messages.service.js';

/**
 * What SES says became of an email Hatti sent (ADR-197), as its notifications or a configuration
 * set's events say it, naming the email by the ID SES gave it when it was sent: delivered, or
 * failed for good, by a bounce for good or SES refusing it. Null for anything else: a bounce that
 * may yet pass, as a full mailbox's, a complaint, which comes once an email was delivered, or what
 * is no word of SES's.
 */
export function emailStatusOf(message: string): StatusUpdate | null {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.mail)) return null;
  const { mail } = value;
  if (typeof mail.messageId !== 'string' || !mail.messageId) return null;
  const providerMessageId = mail.messageId.slice(0, 200);
  const sentAt = timeOf(mail.timestamp);
  switch (value.eventType ?? value.notificationType) {
    case 'Delivery': {
      const at = (isRecord(value.delivery) ? timeOf(value.delivery.timestamp) : null) ?? sentAt;
      return at ? { providerMessageId, status: 'delivered', at } : null;
    }
    case 'Bounce': {
      const { bounce } = value;
      if (!isRecord(bounce) || bounce.bounceType !== 'Permanent') return null;
      const at = timeOf(bounce.timestamp) ?? sentAt;
      if (!at) return null;
      const said = recordsOf(bounce.bouncedRecipients).find(
        (recipient) => typeof recipient.diagnosticCode === 'string',
      )?.diagnosticCode;
      const why = typeof said === 'string' ? said : bounce.bounceSubType;
      return {
        providerMessageId,
        status: 'failed',
        at,
        error: `The email bounced: ${typeof why === 'string' && why.trim() ? why.trim() : 'for good'}`,
      };
    }
    case 'Reject': {
      if (!sentAt) return null;
      const reason = isRecord(value.reject) ? value.reject.reason : null;
      return {
        providerMessageId,
        status: 'failed',
        at: sentAt,
        error: `SES refused to send it: ${typeof reason === 'string' && reason.trim() ? reason.trim() : 'no reason given'}`,
      };
    }
    default:
      return null;
  }
}

function timeOf(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
