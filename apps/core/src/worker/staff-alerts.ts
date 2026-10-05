import { shopProfile } from '@hatti/api';
import type { Database } from '@hatti/db';
import type { DomainEvent } from '@hatti/events';
import { staffPhonesIn } from '@hatti/identity/public';
import type { MessageKind, MessagesService } from '@hatti/messaging/public';
import {
  OrderEvents,
  mentionsIn,
  orderName,
  staffAlertFactsIn,
  type OrderAssignedPayload,
  type OrderCommentPayload,
} from '@hatti/orders/public';

/** What an event tells staff of: an order given to one of them, or a comment that may name some. */
type Alert =
  | { kind: 'order_assigned'; orderId: string; assigneeId: string }
  | { kind: 'order_mentioned'; orderId: string; commentId: string };

/**
 * Tells members of staff on WhatsApp of their own work (ORD-10, ORD-02, ADR-191), at the number
 * their account signs in with, which identity gives for the shop alone (ADR-193), as the orders'
 * events are heard: an order someone else gave them,
 * unless it was given to another since; and a comment that names them as `@` and their name, but
 * not its author, once a comment however often it is changed. Nothing for those who left the shop
 * or proved no number, nor what the shop turned off; each is the shop's message, paid from its
 * credit as its other alerts are.
 */
export class StaffAlerts {
  /** The events {@link handle} reads. */
  static readonly EVENTS: readonly string[] = [
    OrderEvents.OrderAssigned,
    OrderEvents.OrderCommentCreated,
    OrderEvents.OrderCommentUpdated,
  ];

  constructor(
    private readonly database: Database,
    private readonly messages: MessagesService,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const alert = alertOf(event);
    if (!alert) return;
    const { shopId } = event;
    await this.database.tenant(shopId, async (tx) => {
      // Through identity's function for the shop of the transaction, never its tables (ADR-193).
      const staff = await staffPhonesIn(tx, shopId);
      const facts = await staffAlertFactsIn(
        tx,
        shopId,
        alert.orderId,
        alert.kind === 'order_mentioned' ? alert.commentId : null,
      );
      if (!facts) return;
      let told: string[];
      if (alert.kind === 'order_assigned') {
        // Given to another since, who is told instead.
        if (facts.assigneeId !== alert.assigneeId) return;
        told = [alert.assigneeId];
      } else {
        const comment = facts.comment;
        if (!comment) return;
        told = mentionsIn(comment.message, staff).filter((userId) => userId !== comment.authorId);
      }
      if (told.length === 0) return;
      const variables = {
        shop: (await shopProfile(tx, shopId)).name,
        order: orderName(facts.number),
      };
      for (const userId of told) {
        const member = staff.find((each) => each.userId === userId);
        if (!member?.phone) continue;
        await this.messages.queueIn(tx, shopId, {
          kind: alert.kind satisfies MessageKind,
          recipient: member.phone,
          // In their own language, which may not be the shop's (ADR-194).
          language: member.language,
          // Each assignment once; each comment once for each member it names, edited or not.
          dedupeKey:
            alert.kind === 'order_assigned'
              ? `order_assigned:${event.id}`
              : `order_mentioned:${alert.commentId}:${userId}`,
          variables,
          channel: 'whatsapp',
        });
      }
    });
  }
}

/** What `event` tells staff of, if anything. Taking an order for oneself needs no telling. */
function alertOf(event: DomainEvent): Alert | null {
  switch (event.type) {
    case OrderEvents.OrderAssigned: {
      const { assigneeId, assignedBy } = event.payload as Partial<OrderAssignedPayload>;
      if (!assigneeId || assigneeId === assignedBy) return null;
      return { kind: 'order_assigned', orderId: event.aggregateId, assigneeId };
    }
    case OrderEvents.OrderCommentCreated:
    case OrderEvents.OrderCommentUpdated: {
      const { orderId } = event.payload as Partial<OrderCommentPayload>;
      if (!orderId) return null;
      return { kind: 'order_mentioned', orderId, commentId: event.aggregateId };
    }
    default:
      return null;
  }
}
