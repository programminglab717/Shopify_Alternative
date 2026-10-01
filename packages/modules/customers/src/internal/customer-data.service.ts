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
import { Database, exactTime, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { toPublicId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { CustomerDataRegistry } from './customer-data.js';
import { toCustomerRecord } from './customer.service.js';
import {
  CustomerEvents,
  type CustomerErasedPayload,
  type CustomerErasureCancelledPayload,
  type CustomerErasureRequestedPayload,
  type CustomerMergedPayload,
} from './events.js';
import { numbersOf } from './phones.js';
import type { CustomerRecord, Page } from './records.js';
import { LIMITS, customerSearchText } from './rules.js';
import { consentEvents, customerPhones, customers, erasureRequests } from './schema.js';

/** What a customer's own file says it is, for programs that read it; a new shape, a new version. */
export const CUSTOMER_DATA_FORMAT = 'hatti.customer-data/1';

/** Days an erasure asked for ahead of time waits, while staff can cancel it (ADR-110). */
export const ERASURE_WAIT_DAYS = 10;

/** An erasure waiting to happen. */
export interface ErasureRequestRecord {
  customerId: string;
  requestedAt: Date;
  /** When the worker's sweep may erase the customer. */
  dueAt: Date;
}

/**
 * Who erases a customer: the actor, as other modules' records say it, and whoever asked, as the
 * audit log does. An erasure that waited is the system's, asked for at `requestedAt`.
 */
interface Erasure {
  actor: Actor | 'system';
  by: { actorKind: 'app' | 'staff'; actorId: string; actorRole: string | null };
  requestedAt?: Date;
}

/** An erasure waiting to happen, with its customer, as the list of them gives it (ADR-116). */
export interface WaitingErasureRecord {
  request: ErasureRequestRecord;
  customer: CustomerRecord;
  /** When it is due, to the microsecond: where the next page of the list starts. */
  dueAtExactly: string;
}

function toErasureRequest(row: typeof erasureRequests.$inferSelect): ErasureRequestRecord {
  return { customerId: row.customerId, requestedAt: row.requestedAt, dueAt: row.dueAt };
}

/** A customer's own data, as a file to give them. */
export interface CustomerDataExport {
  /** "customer-cus_….json" */
  fileName: string;
  /** The file: JSON, indented to be read. */
  json: string;
}

function actorOf(actor: Actor): { actorKind: 'app' | 'staff'; actorId: string } {
  return actor.kind === 'app'
    ? { actorKind: 'app', actorId: actor.tokenId }
    : { actorKind: 'staff', actorId: actor.userId };
}

/**
 * Merging duplicate customers, and a customer's rights over their data: erasing it, and having it
 * as a file, at their request. Other modules' data about customers, such as orders, take part
 * through {@link CustomerDataRegistry}.
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
      // Merged away, a duplicate's erasure would never happen.
      const [waiting] = await tx
        .select({ customerId: erasureRequests.customerId })
        .from(erasureRequests)
        .where(
          and(eq(erasureRequests.shopId, shopId), eq(erasureRequests.customerId, duplicate.id)),
        );
      if (waiting) {
        return failOne(
          ['duplicateId'],
          'INVALID',
          "This customer's erasure is waiting to happen; cancel it before merging them",
        );
      }

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
        await this.#eraseIn(tx, shopId, current, {
          actor: tenant.actor,
          by: actorColumnsOf(tenant.actor),
        });
        return { ok: true, value: { id } };
      }),
    );
  }

  /**
   * Asks for the customer's erasure to happen after {@link ERASURE_WAIT_DAYS} days (ADR-110):
   * time for what is under way to finish, and for staff to cancel a request made in error. The
   * worker's sweep then erases them as {@link erase} would. Asking again changes nothing.
   */
  async requestErasure(
    tenant: TenantContext,
    id: string,
  ): Promise<MutationResult<ErasureRequestRecord>> {
    const shopId = tenant.shopId;
    return this.db.tenant(shopId, async (tx) => {
      const [current] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.shopId, shopId), eq(customers.id, id)))
        .for('update');
      if (!current) return failOne(['id'], 'NOT_FOUND', 'Customer not found');
      const [existing] = await tx
        .select()
        .from(erasureRequests)
        .where(and(eq(erasureRequests.shopId, shopId), eq(erasureRequests.customerId, id)));
      if (existing) return { ok: true, value: toErasureRequest(existing) };
      const by = actorColumnsOf(tenant.actor);
      const [row] = await tx
        .insert(erasureRequests)
        .values({
          shopId,
          customerId: id,
          dueAt: sql`now() + make_interval(days => ${ERASURE_WAIT_DAYS})`,
          ...by,
        })
        .returning();
      const dueAt = row!.dueAt.toISOString();
      await appendEvent<CustomerErasureRequestedPayload>(tx, shopId, {
        type: CustomerEvents.CustomerErasureRequested,
        aggregateType: 'customer',
        aggregateId: id,
        payload: { dueAt, actorKind: by.actorKind, actorId: by.actorId },
      });
      await recordAudit(tx, shopId, {
        action: 'customer.erasure_requested',
        subjectType: 'customer',
        subjectId: id,
        ...by,
        details: { dueAt },
      });
      return { ok: true, value: toErasureRequest(row!) };
    });
  }

  /** Cancels the customer's erasure waiting to happen, which they no longer want or never asked. */
  async cancelErasure(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    const shopId = tenant.shopId;
    return this.db.tenant(shopId, async (tx) => {
      const [current] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.shopId, shopId), eq(customers.id, id)))
        .for('update');
      if (!current) return failOne(['id'], 'NOT_FOUND', 'Customer not found');
      const [cancelled] = await tx
        .delete(erasureRequests)
        .where(and(eq(erasureRequests.shopId, shopId), eq(erasureRequests.customerId, id)))
        .returning({ dueAt: erasureRequests.dueAt });
      if (!cancelled) return failOne(['id'], 'INVALID', 'No erasure is waiting for this customer');
      const by = actorColumnsOf(tenant.actor);
      await appendEvent<CustomerErasureCancelledPayload>(tx, shopId, {
        type: CustomerEvents.CustomerErasureCancelled,
        aggregateType: 'customer',
        aggregateId: id,
        payload: { actorKind: by.actorKind, actorId: by.actorId },
      });
      await recordAudit(tx, shopId, {
        action: 'customer.erasure_cancelled',
        subjectType: 'customer',
        subjectId: id,
        ...by,
        details: { dueAt: cancelled.dueAt.toISOString() },
      });
      return { ok: true, value: { id } };
    });
  }

  /** The erasures waiting to happen of those of `customerIds` that have one. */
  async erasureRequestsOf(
    tenant: TenantContext,
    customerIds: readonly string[],
  ): Promise<Map<string, ErasureRequestRecord>> {
    if (customerIds.length === 0) return new Map();
    const rows = await this.db.tenant(tenant.shopId, (tx) =>
      tx
        .select()
        .from(erasureRequests)
        .where(
          and(
            eq(erasureRequests.shopId, tenant.shopId),
            inArray(erasureRequests.customerId, [...customerIds]),
          ),
        ),
    );
    return new Map(rows.map((row) => [row.customerId, toErasureRequest(row)]));
  }

  /**
   * The erasures waiting to happen (ADR-116), the soonest due first, then by customer, with
   * their customers: `first` of them after `after`, the due time, to the microsecond, and the
   * customer of the one the previous page ended with.
   */
  async waitingErasures(
    tenant: TenantContext,
    options: { first: number; after?: { at: string; id: string } | null },
  ): Promise<Page<WaitingErasureRecord>> {
    const after = options.after ?? null;
    const rows = await this.db.tenant(tenant.shopId, (tx) =>
      tx
        .select({
          request: erasureRequests,
          customer: customers,
          dueAtExactly: exactTime(erasureRequests.dueAt).mapWith(String),
        })
        .from(erasureRequests)
        .innerJoin(
          customers,
          and(
            eq(customers.shopId, erasureRequests.shopId),
            eq(customers.id, erasureRequests.customerId),
          ),
        )
        .where(
          and(
            eq(erasureRequests.shopId, tenant.shopId),
            after
              ? sql`(${erasureRequests.dueAt}, ${erasureRequests.customerId})
                    > (${after.at}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(erasureRequests.dueAt), asc(erasureRequests.customerId))
        .limit(options.first + 1),
    );
    return {
      items: rows.slice(0, options.first).map((row) => ({
        request: toErasureRequest(row.request),
        customer: toCustomerRecord(row.customer),
        dueAtExactly: row.dueAtExactly,
      })),
      hasNextPage: rows.length > options.first,
    };
  }

  /**
   * Carries out the shop's erasures due by `at` (ADR-110), as the worker's sweep does: each
   * customer in a transaction of its own, erased as {@link erase} erases them, by the system, the
   * audit log naming who asked. One with anything still under way, such as an order not yet
   * closed, waits for a later sweep.
   */
  async eraseDue(
    shopId: string,
    at: Date = new Date(),
  ): Promise<{ erased: number; waiting: number }> {
    const due = await this.db.tenant(shopId, (tx) =>
      tx
        .select({ customerId: erasureRequests.customerId })
        .from(erasureRequests)
        .where(and(eq(erasureRequests.shopId, shopId), lte(erasureRequests.dueAt, at)))
        .orderBy(asc(erasureRequests.dueAt)),
    );
    let erased = 0;
    let waiting = 0;
    for (const { customerId } of due) {
      try {
        const done = await this.db.tenant(shopId, async (tx) => {
          const [current] = await tx
            .select({ id: customers.id, email: customers.email })
            .from(customers)
            .where(and(eq(customers.shopId, shopId), eq(customers.id, customerId)))
            .for('update');
          // Erased, or the request cancelled, since the sweep found it.
          const [request] = await tx
            .select()
            .from(erasureRequests)
            .where(
              and(
                eq(erasureRequests.shopId, shopId),
                eq(erasureRequests.customerId, customerId),
                lte(erasureRequests.dueAt, at),
              ),
            );
          if (!current || !request) return false;
          await this.#eraseIn(tx, shopId, current, {
            actor: 'system',
            by: {
              actorKind: request.actorKind,
              actorId: request.actorId,
              actorRole: request.actorRole,
            },
            requestedAt: request.requestedAt,
          });
          return true;
        });
        if (done) erased += 1;
      } catch (error) {
        if (!(error instanceof UserErrorsRollback)) throw error;
        waiting += 1;
      }
    }
    return { erased, waiting };
  }

  /**
   * Erases the customer `current`, locked in `tx`: their profile, numbers and consent history go,
   * any erasure waiting with them, and other modules strip their records. Throws
   * {@link UserErrorsRollback} while anything of theirs is still under way.
   */
  async #eraseIn(
    tx: Tx,
    shopId: string,
    current: { id: string; email: string | null },
    erasure: Erasure,
  ): Promise<void> {
    const id = current.id;
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
      await handler.erase(tx, shopId, erased, erasure.actor);
    }
    await tx.execute(sql`SELECT customers.erase_consent_history(${id})`);
    await tx.delete(customers).where(and(eq(customers.shopId, shopId), eq(customers.id, id)));
    const requestedAt = erasure.requestedAt?.toISOString();
    await appendEvent<CustomerErasedPayload>(tx, shopId, {
      type: CustomerEvents.CustomerErased,
      aggregateType: 'customer',
      aggregateId: id,
      payload: {
        actorKind: erasure.by.actorKind,
        actorId: erasure.by.actorId,
        ...(requestedAt && { requestedAt }),
      },
    });
    await recordAudit(tx, shopId, {
      action: 'customer.erased',
      subjectType: 'customer',
      subjectId: id,
      ...erasure.by,
      ...(requestedAt && { details: { requestedAt } }),
    });
  }

  /**
   * Everything the shop keeps of a customer, as a file to give them at their request (ADR-102):
   * their profile, numbers and marketing consent with its history, and what other modules keep
   * of them, such as their orders and drafts. The shop's defences against fraud, its blocklist
   * and orders' risk scores, stay out, as does which of the staff did what. Each export goes on
   * the shop's audit log.
   */
  async export(tenant: TenantContext, id: string): Promise<MutationResult<CustomerDataExport>> {
    const shopId = tenant.shopId;
    return this.db.tenant(shopId, async (tx): Promise<MutationResult<CustomerDataExport>> => {
      // Shared: a merge or erasure of theirs under way finishes first, and the next one waits.
      const [customer] = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.shopId, shopId), eq(customers.id, id)))
        .for('share');
      if (!customer) return failOne(['id'], 'NOT_FOUND', 'Customer not found');
      const phones = (await numbersOf(tx, shopId, [id])).get(id) ?? [customer.phone];
      const history = await tx
        .select()
        .from(consentEvents)
        .where(and(eq(consentEvents.shopId, shopId), eq(consentEvents.customerId, id)))
        .orderBy(asc(consentEvents.id));
      const file: Record<string, unknown> = {
        format: CUSTOMER_DATA_FORMAT,
        exportedAt: new Date(),
        customer: {
          id: toPublicId('customer', id),
          name: customer.name,
          phone: customer.phone,
          otherPhones: phones.filter((phone) => phone !== customer.phone),
          email: customer.email,
          note: customer.note,
          tags: customer.tags,
          customerSince: customer.createdAt,
          marketing: {
            whatsapp: { state: customer.whatsappConsent, since: customer.whatsappConsentAt },
            sms: { state: customer.smsConsent, since: customer.smsConsentAt },
            email: { state: customer.emailConsent, since: customer.emailConsentAt },
          },
        },
        consentHistory: history.map((event) => ({
          channel: event.channel,
          state: event.state,
          source: event.source,
          wording: event.wording,
          contact: event.contact,
          collectedAt: event.collectedAt,
        })),
      };
      const identity = { id, phones: [...phones].sort(), email: customer.email };
      for (const handler of this.registry.handlers) {
        for (const [name, section] of Object.entries(await handler.export(tx, shopId, identity))) {
          if (name in file) {
            throw new Error(`Customer data handler "${handler.key}" exports "${name}" again`);
          }
          file[name] = section;
        }
      }
      await recordAudit(tx, shopId, {
        action: 'customer.data_exported',
        subjectType: 'customer',
        subjectId: id,
        ...actorColumnsOf(tenant.actor),
      });
      return {
        ok: true,
        value: {
          fileName: `customer-${toPublicId('customer', id)}.json`,
          json: JSON.stringify(file, null, 2),
        },
      };
    });
  }
}
