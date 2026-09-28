import {
  InputChecker,
  failOne,
  type Actor,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import {
  CustomerEvents,
  type BlocklistEntryCreatedPayload,
  type BlocklistEntryDeletedPayload,
  type BlocklistEntryUpdatedPayload,
} from './events.js';
import type { BlocklistEntryRecord, Page } from './records.js';
import { LIMITS, displayPhone } from './rules.js';
import {
  blocklistEntries,
  type BlockReasonValue,
  type BlockerKind,
  type BlocklistEntryRow,
} from './schema.js';
import { phoneMatch } from './search.js';

export interface BlocklistAddInput {
  /** A Pakistani mobile number, in any common format. */
  phone: string;
  reason: BlockReasonValue;
  /** What happened, for staff. */
  note?: string | null;
}

export interface ListBlocklistOptions {
  first: number;
  after?: string | null;
  /** A mobile number in any format, or four or more of its digits. */
  query?: string | null;
}

function toEntryRecord(row: BlocklistEntryRow): BlocklistEntryRecord {
  return {
    id: row.id,
    phone: row.phone,
    reason: row.reason,
    note: row.note,
    actorKind: row.actorKind,
    actorId: row.actorId,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function blockerOf(actor: Actor): { actorKind: BlockerKind; actorId: string } {
  return actor.kind === 'app'
    ? { actorKind: 'app', actorId: actor.tokenId }
    : { actorKind: 'staff', actorId: actor.userId };
}

/**
 * The merchant's blocklist: mobile numbers whose orders are held for staff to review, such as
 * numbers that placed fake orders or refused parcels. The orders module checks it with
 * {@link entryOf} when an order is placed or its number changes.
 */
@Injectable()
export class BlocklistService {
  constructor(private readonly db: Database) {}

  /** Blocks a number. Blocking a number again replaces why: its reason and note. */
  async add(
    tenant: TenantContext,
    input: BlocklistAddInput,
  ): Promise<MutationResult<BlocklistEntryRecord>> {
    const check = new InputChecker();
    const phone = check.mobile(['input', 'phone'], input.phone, { required: true });
    const note = check.text(['input', 'note'], input.note, { max: LIMITS.blocklistNote }) ?? '';
    if (!check.ok || !phone) return { ok: false, errors: check.errors };
    const blocker = blockerOf(tenant.actor);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const [created] = await tx
        .insert(blocklistEntries)
        .values({
          shopId: tenant.shopId,
          id: newId(),
          phone,
          reason: input.reason,
          note,
          ...blocker,
        })
        // Waits for another transaction blocking the same number, then updates its entry below.
        .onConflictDoNothing({ target: [blocklistEntries.shopId, blocklistEntries.phone] })
        .returning();
      if (created) {
        await appendEvent<BlocklistEntryCreatedPayload>(tx, tenant.shopId, {
          type: CustomerEvents.BlocklistEntryCreated,
          aggregateType: 'blocklist_entry',
          aggregateId: created.id,
          payload: { phone, reason: created.reason, version: created.version },
        });
        return { ok: true, value: toEntryRecord(created) };
      }

      const [current] = await tx
        .select()
        .from(blocklistEntries)
        .where(and(eq(blocklistEntries.shopId, tenant.shopId), eq(blocklistEntries.phone, phone)))
        .for('update');
      const changed = [
        ...(current!.reason === input.reason ? [] : ['reason']),
        ...(current!.note === note ? [] : ['note']),
      ];
      if (changed.length === 0) return { ok: true, value: toEntryRecord(current!) };
      const [row] = await tx
        .update(blocklistEntries)
        .set({
          reason: input.reason,
          note,
          ...blocker,
          version: sql`${blocklistEntries.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(blocklistEntries.shopId, tenant.shopId), eq(blocklistEntries.id, current!.id)),
        )
        .returning();
      await appendEvent<BlocklistEntryUpdatedPayload>(tx, tenant.shopId, {
        type: CustomerEvents.BlocklistEntryUpdated,
        aggregateType: 'blocklist_entry',
        aggregateId: row!.id,
        payload: { phone, reason: row!.reason, changed, version: row!.version },
      });
      return { ok: true, value: toEntryRecord(row!) };
    });
  }

  /** Takes a number off the blocklist. Orders already held for review stay held. */
  async remove(
    tenant: TenantContext,
    phoneInput: string,
  ): Promise<MutationResult<{ id: string; phone: string }>> {
    const check = new InputChecker();
    const phone = check.mobile(['phone'], phoneInput, { required: true });
    if (!check.ok || !phone) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const [removed] = await tx
        .delete(blocklistEntries)
        .where(and(eq(blocklistEntries.shopId, tenant.shopId), eq(blocklistEntries.phone, phone)))
        .returning({ id: blocklistEntries.id, phone: blocklistEntries.phone });
      if (!removed) {
        return failOne(['phone'], 'NOT_FOUND', `${displayPhone(phone)} is not on the blocklist`);
      }
      await appendEvent<BlocklistEntryDeletedPayload>(tx, tenant.shopId, {
        type: CustomerEvents.BlocklistEntryDeleted,
        aggregateType: 'blocklist_entry',
        aggregateId: removed.id,
        payload: { phone },
      });
      return { ok: true, value: removed };
    });
  }

  /** Blocked numbers, most recently blocked first. */
  async list(
    tenant: TenantContext,
    options: ListBlocklistOptions,
  ): Promise<Page<BlocklistEntryRecord>> {
    const conditions: SQL[] = [eq(blocklistEntries.shopId, tenant.shopId)];
    if (options.after) conditions.push(lt(blocklistEntries.id, options.after));
    const query = options.query?.trim() ?? '';
    if (query !== '') conditions.push(phoneMatch(blocklistEntries.phone, query) ?? sql`false`);
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(blocklistEntries)
        .where(and(...conditions))
        .orderBy(desc(blocklistEntries.id))
        .limit(options.first + 1);
      return {
        items: rows.slice(0, options.first).map(toEntryRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /** Blocklist entries by mobile number (E.164); numbers not blocked are left out. */
  async entriesOf(
    tenant: TenantContext,
    phones: readonly string[],
  ): Promise<Map<string, BlocklistEntryRecord>> {
    if (phones.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(blocklistEntries)
        .where(
          and(
            eq(blocklistEntries.shopId, tenant.shopId),
            inArray(blocklistEntries.phone, [...phones]),
          ),
        );
      return new Map(rows.map((row) => [row.phone, toEntryRecord(row)]));
    });
  }

  /** For the orders module, inside its transaction: the number's entry, if it is blocked. */
  async entryOf(tx: Tx, shopId: string, phone: string): Promise<BlocklistEntryRecord | null> {
    const [row] = await tx
      .select()
      .from(blocklistEntries)
      .where(and(eq(blocklistEntries.shopId, shopId), eq(blocklistEntries.phone, phone)));
    return row ? toEntryRecord(row) : null;
  }
}
