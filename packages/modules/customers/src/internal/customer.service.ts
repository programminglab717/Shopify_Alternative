import {
  InputChecker,
  fail,
  failOne,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, isUniqueViolation, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  checkConsentChanges,
  checkEmailConsent,
  consentOf,
  contactResets,
  recordConsentChanges,
  type MarketingConsentInput,
} from './consent.js';
import {
  CustomerEvents,
  type CustomerCreatedPayload,
  type CustomerUpdatedPayload,
} from './events.js';
import { checkOtherPhones, numbersOf, ownersOf } from './phones.js';
import type { ConsentEventRecord, CustomerRecord, Page } from './records.js';
import { LIMITS, customerSearchText, displayPhone } from './rules.js';
import { consentEvents, customerPhones, customers, type CustomerRow } from './schema.js';
import { customerMatch } from './search.js';

export interface CustomerCreateInput {
  /** A Pakistani mobile number, in any common format: their main one. */
  phone: string;
  /** Numbers of theirs besides the main one, such as a second SIM. */
  otherPhones?: string[] | null;
  name?: string | null;
  email?: string | null;
  note?: string | null;
  tags?: string[] | null;
  /** Consent they gave, or withdrew, when added. */
  marketingConsent?: MarketingConsentInput[] | null;
}

/**
 * Fields left out stay as they are; null clears the name, email, note, tags or other numbers. A
 * new main number resets WhatsApp and SMS consent, and a new or removed email resets email
 * consent: consent belongs to the number or address it was given for. The old main number goes,
 * unless it is listed in `otherPhones`.
 */
export interface CustomerUpdateInput {
  phone?: string | null;
  /** Replaces their other numbers. */
  otherPhones?: string[] | null;
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

/**
 * Makes these numbers the customer's, as long as none is another customer's; the errors, one per
 * number that is, otherwise. Numbers already the customer's stay as they are.
 */
async function claimNumbers(
  tx: Tx,
  shopId: string,
  customerId: string,
  numbers: readonly { phone: string; field: string[] }[],
): Promise<FieldError[]> {
  const owners = await ownersOf(
    tx,
    shopId,
    numbers.map((number) => number.phone),
  );
  const errors = numbers
    .filter((number) => (owners.get(number.phone) ?? customerId) !== customerId)
    .map((number): FieldError => ({
      field: number.field,
      code: 'TAKEN',
      message:
        number.field.at(-1) === 'phone'
          ? PHONE_TAKEN
          : `${displayPhone(number.phone)} is another customer's number`,
    }));
  if (errors.length > 0) return errors;
  const fresh = numbers.filter((number) => !owners.has(number.phone));
  if (fresh.length > 0) {
    await tx
      .insert(customerPhones)
      .values(fresh.map((number) => ({ shopId, phone: number.phone, customerId })));
  }
  return [];
}

/** A number taken between checking it and claiming it. */
function isNumberTaken(error: unknown): boolean {
  return (
    isUniqueViolation(error, 'customer_phones_pkey') ||
    isUniqueViolation(error, 'customers_phone_key')
  );
}

export function toCustomerRecord(row: CustomerRow): CustomerRecord {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    email: row.email,
    note: row.note,
    tags: row.tags,
    consent: consentOf(row),
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
    const otherPhones =
      checkOtherPhones(check, ['input', 'otherPhones'], input.otherPhones, phone) ?? [];
    const name = check.text(['input', 'name'], input.name, { max: LIMITS.name });
    const email = check.email(['input', 'email'], input.email);
    const note = check.text(['input', 'note'], input.note, { max: LIMITS.note }) ?? '';
    const tags = check.tags(['input', 'tags'], input.tags);
    const consent = checkConsentChanges(
      check,
      ['input', 'marketingConsent'],
      input.marketingConsent,
      tenant.actor,
    );
    checkEmailConsent(check, consent, email);
    if (!check.ok || !phone) return { ok: false, errors: check.errors };

    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const id = newId();
        const taken = await claimNumbers(tx, tenant.shopId, id, [
          { phone, field: ['input', 'phone'] },
          ...otherPhones.map((other, index) => ({
            phone: other,
            field: ['input', 'otherPhones', String(index)],
          })),
        ]);
        if (taken.length > 0) return fail(taken);
        const [inserted] = await tx
          .insert(customers)
          .values({
            shopId: tenant.shopId,
            id,
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
          aggregateId: inserted!.id,
          payload: {
            source: tenant.actor.kind === 'staff' ? 'manual' : 'api',
            version: inserted!.version,
          },
        });
        let row = inserted!;
        const { set } = await recordConsentChanges(
          tx,
          tenant.shopId,
          row,
          consent,
          tenant.actor,
          row.version,
        );
        if (Object.keys(set).length > 0) {
          const [withConsent] = await tx
            .update(customers)
            .set(set)
            .where(and(eq(customers.shopId, tenant.shopId), eq(customers.id, row.id)))
            .returning();
          row = withConsent!;
        }
        return { ok: true, value: toCustomerRecord(row) };
      });
    } catch (error) {
      if (isNumberTaken(error)) return failOne(['input', 'phone'], 'TAKEN', PHONE_TAKEN);
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
    const otherPhones = checkOtherPhones(
      check,
      ['input', 'otherPhones'],
      input.otherPhones,
      phone ?? null,
    );
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

        // Their numbers: the main one, then the others, given or kept. A new main number is no
        // longer one of the others, and the old one goes unless it is listed.
        const main = changes.phone ?? current.phone;
        const numbers = (await numbersOf(tx, tenant.shopId, [id])).get(id) ?? [];
        const others =
          otherPhones ?? numbers.filter((number) => number !== current.phone && number !== main);
        const mainIndex = others.indexOf(main);
        if (mainIndex >= 0) {
          return failOne(
            ['input', 'otherPhones', String(mainIndex)],
            'INVALID',
            `${displayPhone(main)} is their main number`,
          );
        }
        const taken = await claimNumbers(tx, tenant.shopId, id, [
          { phone: main, field: ['input', 'phone'] },
          ...others.map((other, index) => ({
            phone: other,
            field: ['input', 'otherPhones', String(index)],
          })),
        ]);
        if (taken.length > 0) return fail(taken);
        const dropped = numbers.filter((number) => number !== main && !others.includes(number));
        if (dropped.length > 0) {
          await tx
            .delete(customerPhones)
            .where(
              and(
                eq(customerPhones.shopId, tenant.shopId),
                eq(customerPhones.customerId, id),
                inArray(customerPhones.phone, dropped),
              ),
            );
        }
        const before = numbers.filter((number) => number !== current.phone);
        if (before.length !== others.length || before.some((number) => !others.includes(number))) {
          changed.push('otherPhones');
        }
        if (changed.length === 0) return { ok: true, value: toCustomerRecord(current) };
        const next = { ...current, ...changes };
        if ('name' in changes || 'email' in changes) {
          changes.searchText = customerSearchText(next.name, next.email);
        }
        // A reset is recorded against the new number or address, or the old one if removed.
        const { set: consent } = await recordConsentChanges(
          tx,
          tenant.shopId,
          { ...current, phone: next.phone, email: next.email ?? current.email },
          contactResets(current, changes),
          tenant.actor,
          current.version + 1,
        );

        const set: PgUpdateSetSource<typeof customers> = {
          ...changes,
          ...consent,
          version: sql`${customers.version} + 1`,
          updatedAt: sql`now()`,
        };
        const [row] = await tx
          .update(customers)
          .set(set)
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
      if (isNumberTaken(error)) return failOne(['input', 'phone'], 'TAKEN', PHONE_TAKEN);
      throw error;
    }
  }

  /**
   * Records that a customer agreed to marketing on some channels, or withdrew. Each change goes
   * into the consent ledger with its wording, source and time; a channel already in the state
   * asked for is left as it is.
   */
  async updateMarketingConsent(
    tenant: TenantContext,
    id: string,
    inputs: readonly MarketingConsentInput[],
  ): Promise<MutationResult<CustomerRecord>> {
    const check = new InputChecker();
    const consent = checkConsentChanges(check, ['marketingConsent'], inputs, tenant.actor);
    if (!check.ok) return { ok: false, errors: check.errors };

    return this.db.tenant(tenant.shopId, async (tx) => {
      const [current] = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.shopId, tenant.shopId), eq(customers.id, id)))
        .for('update');
      if (!current) return failOne(['id'], 'NOT_FOUND', 'Customer not found');
      checkEmailConsent(check, consent, current.email);
      if (!check.ok) return { ok: false, errors: check.errors };

      const { set, changed } = await recordConsentChanges(
        tx,
        tenant.shopId,
        current,
        consent,
        tenant.actor,
        current.version + 1,
      );
      if (changed.length === 0) return { ok: true, value: toCustomerRecord(current) };
      const [row] = await tx
        .update(customers)
        .set({ ...set, version: sql`${customers.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(customers.shopId, tenant.shopId), eq(customers.id, id)))
        .returning();
      return { ok: true, value: toCustomerRecord(row!) };
    });
  }

  /** A customer's consent ledger, newest first. */
  async consentHistory(
    tenant: TenantContext,
    customerId: string,
    options: { first: number; after?: string | null },
  ): Promise<Page<ConsentEventRecord>> {
    const conditions: SQL[] = [
      eq(consentEvents.shopId, tenant.shopId),
      eq(consentEvents.customerId, customerId),
    ];
    if (options.after) conditions.push(lt(consentEvents.id, options.after));
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select()
        .from(consentEvents)
        .where(and(...conditions))
        .orderBy(desc(consentEvents.id))
        .limit(options.first + 1);
      return {
        items: rows.slice(0, options.first).map(({ shopId: _shop, ...event }) => event),
        hasNextPage: rows.length > options.first,
      };
    });
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

  /**
   * Customers by mobile number (E.164), their main one or another; numbers of no customer are
   * left out.
   */
  async byPhones(
    tenant: TenantContext,
    phones: readonly string[],
  ): Promise<Map<string, CustomerRecord>> {
    if (phones.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const rows = await tx
        .select({ phone: customerPhones.phone, customer: customers })
        .from(customerPhones)
        .innerJoin(
          customers,
          and(
            eq(customers.shopId, customerPhones.shopId),
            eq(customers.id, customerPhones.customerId),
          ),
        )
        .where(
          and(eq(customerPhones.shopId, tenant.shopId), inArray(customerPhones.phone, [...phones])),
        );
      return new Map(rows.map((row) => [row.phone, toCustomerRecord(row.customer)]));
    });
  }

  /** Every number of each customer, the main one first, then the others, oldest first. */
  async phonesOf(
    tenant: TenantContext,
    customerIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    if (customerIds.length === 0) return new Map();
    return this.db.tenant(tenant.shopId, async (tx) => {
      const mains = await tx
        .select({ id: customers.id, phone: customers.phone })
        .from(customers)
        .where(and(eq(customers.shopId, tenant.shopId), inArray(customers.id, [...customerIds])));
      const numbers = await numbersOf(tx, tenant.shopId, customerIds);
      return new Map(
        mains.map(({ id, phone }) => [
          id,
          [phone, ...(numbers.get(id) ?? []).filter((number) => number !== phone)],
        ]),
      );
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
   * customer with the order's number, main or other, created from the order's name and email if
   * the number is new. An existing customer's profile is left as it is.
   *
   * The number stays locked until the order's transaction ends, so a merge or erasure touching it
   * waits for the order and then sees it.
   */
  async findOrCreate(tx: Tx, shopId: string, details: OrderCustomerDetails): Promise<string> {
    // A second pass only if the number's customer was erased between the two statements.
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = newId();
      const [claimed] = await tx
        .insert(customerPhones)
        .values({ shopId, phone: details.phone, customerId: id })
        // Waits for another transaction adding the same number, then finds its customer below.
        .onConflictDoNothing({ target: [customerPhones.shopId, customerPhones.phone] })
        .returning({ customerId: customerPhones.customerId });
      if (claimed) {
        const [created] = await tx
          .insert(customers)
          .values({
            shopId,
            id,
            phone: details.phone,
            name: details.name,
            email: details.email,
            searchText: customerSearchText(details.name, details.email),
          })
          .returning({ version: customers.version });
        await appendEvent<CustomerCreatedPayload>(tx, shopId, {
          type: CustomerEvents.CustomerCreated,
          aggregateType: 'customer',
          aggregateId: id,
          payload: { source: 'order', version: created!.version },
        });
        return id;
      }
      const [existing] = await tx
        .select({ customerId: customerPhones.customerId })
        .from(customerPhones)
        .where(and(eq(customerPhones.shopId, shopId), eq(customerPhones.phone, details.phone)))
        .for('share');
      if (existing) return existing.customerId;
    }
    throw new Error('The number was claimed and released twice while placing an order');
  }
}
