import { InputChecker, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, isUniqueViolation, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import {
  CustomerEvents,
  type CustomerCreatedPayload,
  type CustomerUpdatedPayload,
} from './events.js';
import type { CustomerRecord, Page } from './records.js';
import { LIMITS, customerSearchText } from './rules.js';
import { customers, type CustomerRow } from './schema.js';
import { customerMatch } from './search.js';

export interface CustomerCreateInput {
  /** A Pakistani mobile number, in any common format. */
  phone: string;
  name?: string | null;
  email?: string | null;
  note?: string | null;
  tags?: string[] | null;
}

/** Fields left out stay as they are; null clears the name, email, note or tags. */
export interface CustomerUpdateInput {
  phone?: string | null;
  name?: string | null;
  email?: string | null;
  note?: string | null;
  tags?: string[] | null;
}

export interface ListCustomersOptions {
  first: number;
  after?: string | null;
  /** A mobile number in any format, four or more of its digits, or words of the name or email. */
  query?: string | null;
}

/** What an order says about its customer. */
export interface OrderCustomerDetails {
  /** Mobile number in E.164 form. */
  phone: string;
  name: string;
  email: string | null;
}

const PHONE_TAKEN = 'A customer with this mobile number already exists';

export function toCustomerRecord(row: CustomerRow): CustomerRecord {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    email: row.email,
    note: row.note,
    tags: row.tags,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Customer profiles. A customer is whoever a mobile number belongs to: orders find or create
 * theirs by number (see {@link findOrCreate}), and staff and apps add and edit profiles.
 */
@Injectable()
export class CustomerService {
  constructor(private readonly db: Database) {}

  async create(
    tenant: TenantContext,
    input: CustomerCreateInput,
  ): Promise<MutationResult<CustomerRecord>> {
    const check = new InputChecker();
    const phone = check.mobile(['input', 'phone'], input.phone, { required: true });
    const name = check.text(['input', 'name'], input.name, { max: LIMITS.name });
    const email = check.email(['input', 'email'], input.email);
    const note = check.text(['input', 'note'], input.note, { max: LIMITS.note }) ?? '';
    const tags = check.tags(['input', 'tags'], input.tags);
    if (!check.ok || !phone) return { ok: false, errors: check.errors };

    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const [row] = await tx
          .insert(customers)
          .values({
            shopId: tenant.shopId,
            id: newId(),
            phone,
            name,
            email,
            note,
            tags,
            searchText: customerSearchText(name, email),
          })
          .returning();
        await appendEvent<CustomerCreatedPayload>(tx, tenant.shopId, {
          type: CustomerEvents.CustomerCreated,
          aggregateType: 'customer',
          aggregateId: row!.id,
          payload: {
            source: tenant.actor.kind === 'staff' ? 'manual' : 'api',
            version: row!.version,
          },
        });
        return { ok: true, value: toCustomerRecord(row!) };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'customers_phone_key')) {
        return failOne(['input', 'phone'], 'TAKEN', PHONE_TAKEN);
      }
      throw error;
    }
  }

  /**
   * Changes a profile. A new number must not belong to another customer; the customer's orders
   * stay theirs, each keeping the number it was placed with.
   */
  async update(
    tenant: TenantContext,
    id: string,
    input: CustomerUpdateInput,
  ): Promise<MutationResult<CustomerRecord>> {
    const check = new InputChecker();
    const phone =
      input.phone === undefined
        ? undefined
        : check.mobile(['input', 'phone'], input.phone, { required: true });
    const name =
      input.name === undefined
        ? undefined
        : check.text(['input', 'name'], input.name, { max: LIMITS.name });
    const email =
      input.email === undefined ? undefined : check.email(['input', 'email'], input.email);
    const note =
      input.note === undefined
        ? undefined
        : (check.text(['input', 'note'], input.note, { max: LIMITS.note }) ?? '');
    const tags = input.tags === undefined ? undefined : check.tags(['input', 'tags'], input.tags);
    if (!check.ok) return { ok: false, errors: check.errors };

    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const [current] = await tx
          .select()
          .from(customers)
          .where(and(eq(customers.shopId, tenant.shopId), eq(customers.id, id)))
          .for('update');
        if (!current) return failOne(['id'], 'NOT_FOUND', 'Customer not found');

        const changes: Partial<CustomerRow> = {};
        if (phone && phone !== current.phone) changes.phone = phone;
        if (name !== undefined && name !== current.name) changes.name = name;
        if (email !== undefined && email !== current.email) changes.email = email;
        if (note !== undefined && note !== current.note) changes.note = note;
        if (tags !== undefined && JSON.stringify(tags) !== JSON.stringify(current.tags)) {
          changes.tags = tags;
        }
        const changed = Object.keys(changes);
        if (changed.length === 0) return { ok: true, value: toCustomerRecord(current) };
        if ('name' in changes || 'email' in changes) {
          const next = { ...current, ...changes };
          changes.searchText = customerSearchText(next.name, next.email);
        }

        const [row] = await tx
          .update(customers)
          .set({ ...changes, version: sql`${customers.version} + 1`, updatedAt: sql`now()` })
          .where(and(eq(customers.shopId, tenant.shopId), eq(customers.id, id)))
          .returning();
        await appendEvent<CustomerUpdatedPayload>(tx, tenant.shopId, {
          type: CustomerEvents.CustomerUpdated,
          aggregateType: 'customer',
          aggregateId: id,
          payload: { changed, version: row!.version },
        });
        return { ok: true, value: toCustomerRecord(row!) };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'customers_phone_key')) {
        return failOne(['input', 'phone'], 'TAKEN', PHONE_TAKEN);
      }
      throw error;
    }
  }

  async get(tenant: TenantContext, id: string): Promise<CustomerRecord | null> {
    return (await this.getMany(tenant, [id])).get(id) ?? null;
  }

  /** Customers by ID; IDs of no customer are left out. */
  async getMany(
    tenant: TenantContext,
    ids: readonly string[],
  ): Promise<Map<string, CustomerRecord>> {
    if (ids.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.shopId, tenant.shopId), inArray(customers.id, [...ids])));
      return new Map(rows.map((row) => [row.id, toCustomerRecord(row)]));
    });
  }

  /** Customers by mobile number (E.164); numbers of no customer are left out. */
  async byPhones(
    tenant: TenantContext,
    phones: readonly string[],
  ): Promise<Map<string, CustomerRecord>> {
    if (phones.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.shopId, tenant.shopId), inArray(customers.phone, [...phones])));
      return new Map(rows.map((row) => [row.phone, toCustomerRecord(row)]));
    });
  }

  /** Customers, newest first. */
  async list(tenant: TenantContext, options: ListCustomersOptions): Promise<Page<CustomerRecord>> {
    const conditions: SQL[] = [eq(customers.shopId, tenant.shopId)];
    if (options.after) conditions.push(lt(customers.id, options.after));
    const query = options.query?.trim() ?? '';
    if (query !== '') conditions.push(customerMatch(query));
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(customers)
        .where(and(...conditions))
        .orderBy(desc(customers.id))
        .limit(options.first + 1);
      return {
        items: rows.slice(0, options.first).map(toCustomerRecord),
        hasNextPage: rows.length > options.first,
      };
    });
  }

  /**
   * For the orders module, inside the transaction that places or changes an order: the ID of the
   * customer with the order's number, created from the order's name and email if the number is
   * new. An existing customer's profile is left as it is.
   */
  async findOrCreate(tx: Tx, shopId: string, details: OrderCustomerDetails): Promise<string> {
    const [created] = await tx
      .insert(customers)
      .values({
        shopId,
        id: newId(),
        phone: details.phone,
        name: details.name,
        email: details.email,
        searchText: customerSearchText(details.name, details.email),
      })
      // Waits for another transaction adding the same number, then finds its customer below.
      .onConflictDoNothing({ target: [customers.shopId, customers.phone] })
      .returning({ id: customers.id, version: customers.version });
    if (created) {
      await appendEvent<CustomerCreatedPayload>(tx, shopId, {
        type: CustomerEvents.CustomerCreated,
        aggregateType: 'customer',
        aggregateId: created.id,
        payload: { source: 'order', version: created.version },
      });
      return created.id;
    }
    const [existing] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.shopId, shopId), eq(customers.phone, details.phone)));
    return existing!.id;
  }
}
