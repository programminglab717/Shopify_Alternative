import {
  INPUT_LIMITS,
  UserErrorsRollback,
  actorColumnsOf,
  failOne,
  rollbackResult,
  type Actor,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { toPublicId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { CustomerDataRegistry } from './customer-data.js';
import { toCustomerRecord } from './customer.service.js';
import {
  CustomerEvents,
  type CustomerErasedPayload,
  type CustomerMergedPayload,
} from './events.js';
import { numbersOf } from './phones.js';
import type { CustomerRecord } from './records.js';
import { LIMITS, customerSearchText } from './rules.js';
import { customerPhones, customers } from './schema.js';

function actorOf(actor: Actor): { actorKind: 'app' | 'staff'; actorId: string } {
  return actor.kind === 'app'
    ? { actorKind: 'app', actorId: actor.tokenId }
    : { actorKind: 'staff', actorId: actor.userId };
}

/**
 * Merging duplicate customers, and erasing a customer's personal data at their request. Other
 * modules' data about customers, such as orders, take part through {@link CustomerDataRegistry}.
 */
@Injectable()
export class CustomerDataService {
  constructor(
    private readonly db: Database,
    private readonly registry: CustomerDataRegistry,
  ) {}

  /**
   * Merges a duplicate into a customer: the duplicate's numbers, orders, tags, note and consent
   * history become the customer's, and the duplicate is deleted. Where both have a name or an
   * email, the customer's stays; the duplicate's fills a gap, an email with its consent. Marketing
   * consent stays with the customer's main number.
   */
  async merge(
    tenant: TenantContext,
    customerId: string,
    duplicateId: string,
  ): Promise<MutationResult<CustomerRecord>> {
    if (customerId === duplicateId) {
      return failOne(['duplicateId'], 'INVALID', "A customer can't be merged into themselves");
    }
    const shopId = tenant.shopId;
    return this.db.tenant(shopId, async (tx) => {
      // Both, always in the same order, so two merges of the same customers wait for each other.
      const rows = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.shopId, shopId), inArray(customers.id, [customerId, duplicateId])))
        .orderBy(asc(customers.id))
        .for('update');
      const keep = rows.find((row) => row.id === customerId);
      const duplicate = rows.find((row) => row.id === duplicateId);
      if (!keep) return failOne(['customerId'], 'NOT_FOUND', 'Customer not found');
      if (!duplicate) return failOne(['duplicateId'], 'NOT_FOUND', 'Customer not found');

      const seen = new Set(keep.tags.map((tag) => tag.toLowerCase()));
      const tags = [...keep.tags, ...duplicate.tags.filter((tag) => !seen.has(tag.toLowerCase()))];
      if (tags.length > INPUT_LIMITS.tags) {
        return failOne(
          ['duplicateId'],
          'TOO_MANY',
          `Together they have more than ${INPUT_LIMITS.tags} tags; remove some first`,
        );
      }
      const note = [keep.note, duplicate.note].filter((text) => text !== '').join('\n\n');
      if (note.length > LIMITS.note) {
        return failOne(
          ['duplicateId'],
          'TOO_LONG',
          `Together their notes are longer than ${LIMITS.note} characters; shorten one first`,
        );
      }
      const numbers = await numbersOf(tx, shopId, [keep.id, duplicate.id]);
      const count = (numbers.get(keep.id)?.length ?? 0) + (numbers.get(duplicate.id)?.length ?? 0);
      if (count > LIMITS.otherPhones + 1) {
        return failOne(
          ['duplicateId'],
          'TOO_MANY',
          `Together they have more than ${LIMITS.otherPhones + 1} numbers; remove some first`,
        );
      }

      // Their orders and the like first, then their numbers. Moving the numbers waits for any
      // order being placed with one of them, so a second pass moves those orders as well.
      for (const handler of this.registry.handlers) {
        await handler.merge(tx, shopId, duplicate.id, keep.id);
      }
      await tx
        .update(customerPhones)
        .set({ customerId: keep.id })
        .where(and(eq(customerPhones.shopId, shopId), eq(customerPhones.customerId, duplicate.id)));
      for (const handler of this.registry.handlers) {
        await handler.merge(tx, shopId, duplicate.id, keep.id);
      }
      await tx.execute(sql`SELECT customers.move_consent_history(${duplicate.id}, ${keep.id})`);
      await tx
        .delete(customers)
        .where(and(eq(customers.shopId, shopId), eq(customers.id, duplicate.id)));

      const name = keep.name ?? duplicate.name;
      const email = keep.email ?? duplicate.email;
      const set: PgUpdateSetSource<typeof customers> = {
        name,
        note,
        tags,
        searchText: customerSearchText(name, email),
        // A customer since whichever of them came first.
        createdAt: keep.createdAt < duplicate.createdAt ? keep.createdAt : duplicate.createdAt,
        version: sql`${customers.version} + 1`,
        updatedAt: sql`now()`,
      };
      if (keep.email === null && duplicate.email !== null) {
        Object.assign(set, {
          email: duplicate.email,
          emailConsent: duplicate.emailConsent,
          emailConsentAt: duplicate.emailConsentAt,
        });
      }
      const [row] = await tx
        .update(customers)
        .set(set)
        .where(and(eq(customers.shopId, shopId), eq(customers.id, keep.id)))
        .returning();
      await appendEvent<CustomerMergedPayload>(tx, shopId, {
        type: CustomerEvents.CustomerMerged,
        aggregateType: 'customer',
        aggregateId: keep.id,
        payload: {
          mergedCustomerId: duplicate.id,
          version: row!.version,
          ...actorOf(tenant.actor),
        },
      });
      await recordAudit(tx, shopId, {
        action: 'customer.merged',
        subjectType: 'customer',
        subjectId: keep.id,
        ...actorColumnsOf(tenant.actor),
        details: { mergedCustomerId: toPublicId('customer', duplicate.id) },
      });
      return { ok: true, value: toCustomerRecord(row!) };
    });
  }

  /**
   * Erases a customer's personal data, at their request: their profile, numbers and consent
   * history are deleted, and other modules strip their records of it, keeping what the shop must
   * keep, such as orders for its accounts. Refused while anything of theirs is still under way.
   * Cannot be undone. A later order from one of their numbers starts a new customer.
   */
  async erase(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    const shopId = tenant.shopId;
    return rollbackResult(() =>
      this.db.tenant(shopId, async (tx) => {
        const [current] = await tx
          .select({ id: customers.id, email: customers.email })
          .from(customers)
          .where(and(eq(customers.shopId, shopId), eq(customers.id, id)))
          .for('update');
        if (!current) return failOne(['id'], 'NOT_FOUND', 'Customer not found');

        // Their numbers first: this waits for any order being placed with one of them, which the
        // checks below then see.
        const numbers = await tx
          .delete(customerPhones)
          .where(and(eq(customerPhones.shopId, shopId), eq(customerPhones.customerId, id)))
          .returning({ phone: customerPhones.phone });
        const blockers: string[] = [];
        for (const handler of this.registry.handlers) {
          blockers.push(...(await handler.erasureBlockers(tx, shopId, id)));
        }
        if (blockers.length > 0) {
          throw new UserErrorsRollback(
            blockers.map((message) => ({ field: ['id'], code: 'IN_USE', message })),
          );
        }
        const erased = { id, phones: numbers.map((row) => row.phone).sort(), email: current.email };
        for (const handler of this.registry.handlers) {
          await handler.erase(tx, shopId, erased, tenant.actor);
        }
        await tx.execute(sql`SELECT customers.erase_consent_history(${id})`);
        await tx.delete(customers).where(and(eq(customers.shopId, shopId), eq(customers.id, id)));
        await appendEvent<CustomerErasedPayload>(tx, shopId, {
          type: CustomerEvents.CustomerErased,
          aggregateType: 'customer',
          aggregateId: id,
          payload: actorOf(tenant.actor),
        });
        await recordAudit(tx, shopId, {
          action: 'customer.erased',
          subjectType: 'customer',
          subjectId: id,
          ...actorColumnsOf(tenant.actor),
        });
        return { ok: true, value: { id } };
      }),
    );
  }
}
