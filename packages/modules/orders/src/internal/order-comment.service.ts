import {
  InputChecker,
  failOne,
  type Actor,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, toDate, toDateOrNull, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { OrderEvents, type OrderCommentPayload } from './events.js';
import type { OrderEventRecord } from './records.js';
import { LIMITS } from './rules.js';
import { orderComments, orders, type ActorKind, type CommentAuthorKind } from './schema.js';

/** A timeline entry as the timeline's statement reads it: an event or a comment (ADR-128). */
export type TimelineRow = {
  id: string;
  order_id: string;
  kind: string;
  message: string;
  actor_kind: ActorKind;
  actor_id: string | null;
  created_at: string | Date;
  comment: boolean;
  edited_at: string | Date | null;
};

type CommentRow = typeof orderComments.$inferSelect;

/**
 * Comments on an order's timeline (ORD-02, ADR-128): what staff and apps write on it for whoever
 * picks the order up next. A comment is its author's: they change it or delete it, and owners
 * and managers delete anyone's. Comments live apart from the timeline's events, which stay
 * append-only and free of contact details, and go with the customer's details in an erasure.
 * Writing one changes nothing of the order, not its version; it is an event of its own, which
 * says which comment and never what it says, so that the staff it names are told (ADR-191).
 */
@Injectable()
export class OrderCommentService {
  constructor(private readonly db: Database) {}

  /** Writes a comment on the order's timeline, as the caller. */
  async create(
    tenant: TenantContext,
    orderId: string,
    message: string,
  ): Promise<MutationResult<OrderEventRecord>> {
    const check = new InputChecker();
    const text = check.text(['message'], message, { required: true, max: LIMITS.comment });
    if (!check.ok || text === null) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<OrderEventRecord>> => {
      const [order] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.shopId, tenant.shopId), eq(orders.id, orderId)));
      if (!order) return failOne(['orderId'], 'NOT_FOUND', 'Order not found');
      const [created] = await tx
        .insert(orderComments)
        .values({
          shopId: tenant.shopId,
          id: newId(),
          orderId,
          message: text,
          ...authorOf(tenant.actor),
        })
        .returning();
      await appendEvent<OrderCommentPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderCommentCreated,
        aggregateType: 'order_comment',
        aggregateId: created!.id,
        payload: { orderId },
      });
      return { ok: true, value: toCommentEntry(created!) };
    });
  }

  /** Changes a comment's words: its author's alone. The same words again change nothing. */
  async update(
    tenant: TenantContext,
    id: string,
    message: string,
  ): Promise<MutationResult<OrderEventRecord>> {
    const check = new InputChecker();
    const text = check.text(['message'], message, { required: true, max: LIMITS.comment });
    if (!check.ok || text === null) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<OrderEventRecord>> => {
      const comment = await lockComment(tx, tenant.shopId, id);
      if (!comment) return failOne(['id'], 'NOT_FOUND', 'Comment not found');
      if (!writtenBy(comment, tenant.actor)) {
        return failOne(['id'], 'INVALID', 'Only its author changes a comment');
      }
      if (comment.message === text) return { ok: true, value: toCommentEntry(comment) };
      const [updated] = await tx
        .update(orderComments)
        .set({ message: text, editedAt: sql`now()` })
        .where(and(eq(orderComments.shopId, tenant.shopId), eq(orderComments.id, id)))
        .returning();
      // Those it names now and did not before are told (ADR-191).
      await appendEvent<OrderCommentPayload>(tx, tenant.shopId, {
        type: OrderEvents.OrderCommentUpdated,
        aggregateType: 'order_comment',
        aggregateId: id,
        payload: { orderId: comment.orderId },
      });
      return { ok: true, value: toCommentEntry(updated!) };
    });
  }

  /**
   * Deletes a comment: the caller's own, or, with `anyones`, which owners and managers have,
   * anyone's. Returns the order it was on.
   */
  async delete(
    tenant: TenantContext,
    id: string,
    options: { anyones: boolean },
  ): Promise<MutationResult<{ orderId: string }>> {
    return this.db.tenant(
      tenant.shopId,
      async (tx): Promise<MutationResult<{ orderId: string }>> => {
        const comment = await lockComment(tx, tenant.shopId, id);
        if (!comment) return failOne(['id'], 'NOT_FOUND', 'Comment not found');
        if (!options.anyones && !writtenBy(comment, tenant.actor)) {
          return failOne(
            ['id'],
            'INVALID',
            'Only its author deletes a comment, or an owner or manager',
          );
        }
        await tx
          .delete(orderComments)
          .where(and(eq(orderComments.shopId, tenant.shopId), eq(orderComments.id, id)));
        return { ok: true, value: { orderId: comment.orderId } };
      },
    );
  }
}

/** A timeline entry from the timeline's statement. */
export function toTimelineEntry(row: TimelineRow): OrderEventRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    kind: row.kind,
    message: row.message,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    createdAt: toDate(row.created_at),
    comment: row.comment,
    editedAt: toDateOrNull(row.edited_at),
  };
}

function toCommentEntry(row: CommentRow): OrderEventRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    kind: 'comment',
    message: row.message,
    actorKind: row.authorKind,
    actorId: row.authorId,
    createdAt: row.createdAt,
    comment: true,
    editedAt: row.editedAt,
  };
}

function authorOf(actor: Actor): { authorKind: CommentAuthorKind; authorId: string } {
  return actor.kind === 'app'
    ? { authorKind: 'app', authorId: actor.tokenId }
    : { authorKind: 'staff', authorId: actor.userId };
}

function writtenBy(comment: CommentRow, actor: Actor): boolean {
  const author = authorOf(actor);
  return comment.authorKind === author.authorKind && comment.authorId === author.authorId;
}

async function lockComment(tx: Tx, shopId: string, id: string): Promise<CommentRow | undefined> {
  const [comment] = await tx
    .select()
    .from(orderComments)
    .where(and(eq(orderComments.shopId, shopId), eq(orderComments.id, id)))
    .for('update');
  return comment;
}
