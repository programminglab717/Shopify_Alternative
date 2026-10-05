import type { Tx } from '@hatti/db';
import { sql } from 'drizzle-orm';
import type { CommentAuthorKind } from './schema.js';

/**
 * What a member of staff is told of an order (ORD-10, ORD-02, ADR-191): its number, whom it is
 * given to now and, where asked for, a comment on it.
 */
export interface StaffAlertFacts {
  number: number;
  /** The account it is given to now; null while no one has it. */
  assigneeId: string | null;
  /** Null where none was asked for, or it was deleted since. */
  comment: {
    message: string;
    /** Its author's account; null for an app's. */
    authorId: string | null;
  } | null;
}

/** The order `orderId`, and its comment `commentId`, as staff's alerts tell of them; null if gone. */
export async function staffAlertFactsIn(
  tx: Tx,
  shopId: string,
  orderId: string,
  commentId: string | null = null,
): Promise<StaffAlertFacts | null> {
  const { rows } = await tx.execute<{
    number: number;
    assignee_id: string | null;
    message: string | null;
    author_kind: CommentAuthorKind | null;
    author_id: string | null;
  }>(sql`
    SELECT o.number, o.assignee_id, c.message, c.author_kind, c.author_id
      FROM orders.orders o
      LEFT JOIN orders.order_comments c
        ON c.shop_id = o.shop_id AND c.order_id = o.id AND c.id = ${commentId}::uuid
     WHERE o.shop_id = ${shopId} AND o.id = ${orderId}`);
  const row = rows[0];
  if (!row) return null;
  return {
    number: row.number,
    assigneeId: row.assignee_id,
    comment:
      row.message === null
        ? null
        : { message: row.message, authorId: row.author_kind === 'staff' ? row.author_id : null },
  };
}

/** What ends a name, and what may not come before its `@`: letters, digits and their marks. */
const WORD = /[\p{L}\p{N}\p{M}]/u;
/** What comes before an `@` within an email address, which names no one. */
const ADDRESS = /[\p{L}\p{N}\p{M}._%+-]/u;

/** Text as names are matched in it: in one form, lower case, its spaces one each. */
function fold(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The members of staff a comment names (ADR-191): each `@` followed by a member's name, in any
 * letter case or spacing, and then by no letter or digit. Where several names fit, the longest,
 * so "@Ali Raza" names Ali Raza and not Ali; members with the same name are each named. An `@`
 * within a word, as in an email address, names no one. Their accounts, in the order the comment
 * first names them.
 */
export function mentionsIn(
  message: string,
  members: readonly { userId: string; name: string }[],
): string[] {
  const names = members
    .map((member) => ({ userId: member.userId, name: fold(member.name).trim() }))
    .filter((member) => member.name.length > 0);
  const text = fold(message);
  const named: string[] = [];
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    if (at > 0 && ADDRESS.test(text[at - 1]!)) continue;
    const rest = text.slice(at + 1);
    let longest = 0;
    let found: string[] = [];
    for (const member of names) {
      const after = rest[member.name.length];
      if (!rest.startsWith(member.name) || (after !== undefined && WORD.test(after))) continue;
      if (member.name.length > longest) {
        longest = member.name.length;
        found = [member.userId];
      } else if (member.name.length === longest) {
        found.push(member.userId);
      }
    }
    for (const userId of found) if (!named.includes(userId)) named.push(userId);
  }
  return named;
}
