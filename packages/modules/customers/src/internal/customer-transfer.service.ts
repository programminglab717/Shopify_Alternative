import {
  InputChecker,
  failOne,
  type Actor,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { CsvError, parseCsv, toCsv } from '@hatti/csv';
import { Database, type Tx } from '@hatti/db';
import { appendEvent, appendEvents } from '@hatti/events';
import { newId, toPublicId } from '@hatti/ids';
import { money, toMajorString } from '@hatti/money';
import { parsePkMobile } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { consentOf, contactResets, recordConsentChanges, type ConsentChange } from './consent.js';
import {
  CustomerEvents,
  type CustomerCreatedPayload,
  type CustomerExportCreatedPayload,
  type CustomerImportCreatedPayload,
  type CustomerUpdatedPayload,
  type MarketingConsentUpdatedPayload,
} from './events.js';
import { ownersOf } from './phones.js';
import { LIMITS, SEGMENT_TIME_ZONE, customerSearchText, displayPhone } from './rules.js';
import {
  MARKETING_CHANNELS,
  consentEvents,
  customerPhones,
  customers,
  type CustomerRow,
  type MarketingChannelValue,
} from './schema.js';
import {
  SegmentFieldRegistry,
  type SegmentFactSource,
  type SegmentField,
} from './segment-fields.js';
import { SegmentQueryError } from './segment-query.js';
import { sourceJoins } from './segment-sql.js';
import { SegmentService } from './segment.service.js';

export const TRANSFER_LIMITS = {
  /** Characters in an imported file. */
  csv: 1_500_000,
  importRows: 5_000,
  exportRows: 10_000,
  /** Row errors an import reports; it counts them all. */
  rowErrors: 100,
} as const;

export interface CustomerImportOptions {
  /**
   * Customers already here take the file's name, email, note, tags and consent, where the file
   * has them. Without it they are left as they are.
   */
  overwrite?: boolean;
  /** Check the file and count what would happen, writing nothing. */
  dryRun?: boolean;
}

/** A row the import could not take: its number in the file (the header is row 1), and why. */
export interface CustomerImportRowError {
  row: number;
  /** The column at fault, as the file names it. */
  column: string | null;
  message: string;
}

export interface CustomerImportResult {
  /** Rows after the header. */
  rows: number;
  created: number;
  updated: number;
  /** Customers already here, left as they were. */
  skipped: number;
  /** The first {@link TRANSFER_LIMITS.rowErrors} problems. */
  rowErrors: CustomerImportRowError[];
  rowErrorCount: number;
  dryRun: boolean;
}

export interface CustomerExportFilter {
  /** In the segment query language, e.g. "whatsapp_subscription_status = subscribed". */
  query?: string | null;
  segmentId?: string | null;
}

/**
 * Column names the import understands: Hatti's own export, Shopify's customer export, and common
 * spreadsheet headings. Matched ignoring case, spaces and underscores.
 */
const COLUMNS = {
  phone: ['phone', 'mobile', 'mobile number', 'phone number', 'whatsapp number', 'contact number'],
  addressPhone: ['default address phone', 'address phone'],
  name: ['name', 'full name', 'customer name'],
  firstName: ['first name'],
  lastName: ['last name'],
  email: ['email', 'email address'],
  tags: ['tags'],
  note: ['note', 'notes'],
  whatsapp: ['whatsapp marketing', 'accepts whatsapp marketing'],
  sms: ['sms marketing', 'accepts sms marketing'],
  emailMarketing: ['email marketing', 'accepts email marketing', 'accepts marketing'],
} as const;

type ColumnKey = keyof typeof COLUMNS;

const CONSENT_COLUMNS: Record<MarketingChannelValue, ColumnKey> = {
  whatsapp: 'whatsapp',
  sms: 'sms',
  email: 'emailMarketing',
};

function normalizeHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

/** yes/subscribed → subscribed; unsubscribed → unsubscribed; blank, no → no change. */
function consentValue(text: string): 'subscribed' | 'unsubscribed' | null | undefined {
  const value = text
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['', 'no', 'false', 'not_subscribed'].includes(value)) return null;
  if (['yes', 'true', 'subscribed'].includes(value)) return 'subscribed';
  if (value === 'unsubscribed') return 'unsubscribed';
  return undefined;
}

interface ImportRow {
  row: number;
  phone: string;
  name: string | null;
  email: string | null;
  note: string | null;
  tags: string[] | null;
  consent: ConsentChange[];
}

function actorColumns(actor: Actor): { actorKind: 'app' | 'staff'; actorId: string } {
  return actor.kind === 'app'
    ? { actorKind: 'app', actorId: actor.tokenId }
    : { actorKind: 'staff', actorId: actor.userId };
}

/**
 * Customers in and out as CSV. Imports take Hatti's own export, Shopify's customer export or a
 * spreadsheet, a row per customer found by mobile number; rows that fail are reported and the
 * rest go in. Exports are for owners and managers, and each one is recorded as an event.
 */
@Injectable()
export class CustomerTransferService {
  constructor(
    private readonly db: Database,
    private readonly registry: SegmentFieldRegistry,
    private readonly segments: SegmentService,
  ) {}

  async import(
    tenant: TenantContext,
    csv: string,
    options: CustomerImportOptions = {},
  ): Promise<MutationResult<CustomerImportResult>> {
    if (csv.trim() === '') return failOne(['csv'], 'BLANK', 'The file is empty');
    if (csv.length > TRANSFER_LIMITS.csv) {
      return failOne(
        ['csv'],
        'TOO_LONG',
        `The file can be at most ${TRANSFER_LIMITS.csv.toLocaleString('en')} characters; split it`,
      );
    }
    let table: string[][];
    try {
      table = parseCsv(csv);
    } catch (error) {
      if (error instanceof CsvError) return failOne(['csv'], 'INVALID', error.message);
      throw error;
    }
    const [header = [], ...body] = table;
    if (body.length === 0)
      return failOne(['csv'], 'BLANK', 'The file has no rows after its header');
    if (body.length > TRANSFER_LIMITS.importRows) {
      return failOne(
        ['csv'],
        'TOO_MANY',
        `The file can have at most ${TRANSFER_LIMITS.importRows.toLocaleString('en')} customers; ` +
          'split it',
      );
    }
    const headings = header.map(normalizeHeading);
    const columns = new Map<ColumnKey, number>();
    for (const [key, names] of Object.entries(COLUMNS) as [ColumnKey, readonly string[]][]) {
      const index = headings.findIndex((heading) => names.includes(heading));
      if (index >= 0) columns.set(key, index);
    }
    if (!columns.has('phone') && !columns.has('addressPhone')) {
      return failOne(
        ['csv'],
        'INVALID',
        'The file needs a Phone column: customers are found by their mobile number',
      );
    }

    const rowErrors: CustomerImportRowError[] = [];
    let rowErrorCount = 0;
    const reject = (row: number, column: ColumnKey | null, message: string) => {
      rowErrorCount += 1;
      if (rowErrors.length < TRANSFER_LIMITS.rowErrors) {
        const index = column === null ? undefined : columns.get(column);
        rowErrors.push({
          row,
          column: index === undefined ? null : (header[index] ?? null),
          message,
        });
      }
    };

    const firstRowOf = new Map<string, number>();
    const rows: ImportRow[] = [];
    body.forEach((cells, index) => {
      const row = index + 2;
      const cell = (key: ColumnKey) => {
        const at = columns.get(key);
        return at === undefined ? '' : (cells[at] ?? '').trim();
      };
      const check = new InputChecker();
      const phoneColumn: ColumnKey =
        cell('phone') !== '' || !columns.has('addressPhone') ? 'phone' : 'addressPhone';
      const phoneText = cell(phoneColumn);
      const mobile = phoneText === '' ? null : parsePkMobile(phoneText);
      if (!mobile) {
        reject(
          row,
          columns.has(phoneColumn) ? phoneColumn : 'addressPhone',
          phoneText === ''
            ? 'The phone number is missing: customers are found by their mobile number'
            : `"${phoneText}" is not a Pakistani mobile number, like 0300 1234567`,
        );
        return;
      }
      const earlier = firstRowOf.get(mobile.e164);
      if (earlier !== undefined) {
        reject(row, phoneColumn, `The same number as row ${earlier}`);
        return;
      }
      firstRowOf.set(mobile.e164, row);

      const fullName =
        cell('name') || [cell('firstName'), cell('lastName')].filter(Boolean).join(' ');
      const name = check.text(['name'], fullName, { max: LIMITS.name });
      const email = check.email(['email'], cell('email'));
      const note = check.text(['note'], cell('note'), { max: LIMITS.note });
      const tagText = cell('tags');
      const tags = tagText === '' ? null : check.tags(['tags'], tagText.split(','));
      const keys: Record<string, ColumnKey> = {
        name: 'name',
        email: 'email',
        note: 'note',
        tags: 'tags',
      };
      for (const error of check.errors) {
        reject(row, keys[error.field[0]!] ?? null, error.message);
      }
      const consent: ConsentChange[] = [];
      let consentOk = true;
      for (const channel of MARKETING_CHANNELS) {
        const key = CONSENT_COLUMNS[channel];
        const raw = cell(key);
        const state = consentValue(raw);
        if (state === undefined) {
          reject(row, key, `"${raw}" is not yes, no, subscribed or unsubscribed`);
          consentOk = false;
        } else if (state !== null) {
          consent.push({
            field: [],
            channel,
            state,
            source: 'import',
            wording: `Imported from a file: ${header[columns.get(key)!]} = ${raw}`,
            collectedAt: null,
          });
        }
      }
      if (check.ok && consentOk) {
        rows.push({ row, phone: mobile.e164, name, email, note, tags, consent });
      }
    });

    return this.db.tenant(tenant.shopId, async (tx) => {
      const existing = new Map<string, CustomerRow>();
      const phones = rows.map((row) => row.phone);
      for (let start = 0; start < phones.length; start += 1_000) {
        const found = await tx
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.shopId, tenant.shopId),
              inArray(customers.phone, phones.slice(start, start + 1_000)),
            ),
          );
        for (const customer of found) existing.set(customer.phone, customer);
      }
      // A customer's other number is theirs: rows go by main numbers.
      const owned = await ownersOf(
        tx,
        tenant.shopId,
        phones.filter((phone) => !existing.has(phone)),
      );

      // Email consent needs an address, from the file or the customer. Customers left as they
      // are need nothing.
      const accepted = rows.filter((row) => {
        if (owned.has(row.phone)) {
          reject(
            row.row,
            columns.has('phone') ? 'phone' : 'addressPhone',
            `${displayPhone(row.phone)} is another number of a customer here; ` +
              'use their main number',
          );
          return false;
        }
        const current = existing.get(row.phone);
        if (current && !options.overwrite) return true;
        const email = row.email ?? current?.email ?? null;
        if (email === null && row.consent.some((change) => change.channel === 'email')) {
          reject(row.row, 'emailMarketing', 'Email consent needs an email address');
          return false;
        }
        return true;
      });
      const fresh = accepted.filter((row) => !existing.has(row.phone));
      const known = accepted.filter((row) => existing.has(row.phone));
      const result: CustomerImportResult = {
        rows: body.length,
        created: fresh.length,
        updated: 0,
        skipped: options.overwrite ? 0 : known.length,
        rowErrors,
        rowErrorCount,
        dryRun: options.dryRun ?? false,
      };
      if (options.overwrite) {
        for (const row of known) {
          const changed = this.#overwrite(existing.get(row.phone)!, row);
          if (changed.profile.length > 0 || changed.consent) result.updated += 1;
          else result.skipped += 1;
        }
      }
      if (options.dryRun) return { ok: true, value: result };

      await this.#create(tx, tenant, fresh);
      if (options.overwrite) {
        for (const row of known) await this.#update(tx, tenant, existing.get(row.phone)!, row);
      }
      await appendEvent<CustomerImportCreatedPayload>(tx, tenant.shopId, {
        type: CustomerEvents.CustomerImportCreated,
        aggregateType: 'customer_import',
        aggregateId: newId(),
        payload: {
          rows: result.rows,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
          rowErrors: result.rowErrorCount,
          ...actorColumns(tenant.actor),
        },
      });
      return { ok: true, value: result };
    });
  }

  /** What an overwrite would change for a customer already here. */
  #overwrite(
    current: CustomerRow,
    row: ImportRow,
  ): { profile: (keyof CustomerRow)[]; changes: Partial<CustomerRow>; consent: boolean } {
    const changes: Partial<CustomerRow> = {};
    if (row.name !== null && row.name !== current.name) changes.name = row.name;
    if (row.email !== null && row.email !== current.email) changes.email = row.email;
    if (row.note !== null && row.note !== current.note) changes.note = row.note;
    if (row.tags !== null && JSON.stringify(row.tags) !== JSON.stringify(current.tags)) {
      changes.tags = row.tags;
    }
    // As recordConsentChanges will apply them: in order, each against the state before it.
    const states = new Map(
      Object.entries(consentOf(current)).map(([channel, { state }]) => [channel, state]),
    );
    let consent = false;
    for (const change of [...contactResets(current, changes), ...row.consent]) {
      if (states.get(change.channel) === change.state) continue;
      states.set(change.channel, change.state);
      consent = true;
    }
    return { profile: Object.keys(changes) as (keyof CustomerRow)[], changes, consent };
  }

  async #create(tx: Tx, tenant: TenantContext, rows: ImportRow[]): Promise<void> {
    const actor = actorColumns(tenant.actor);
    for (let start = 0; start < rows.length; start += 500) {
      const chunk = rows.slice(start, start + 500).map((row) => ({ ...row, id: newId() }));
      await tx
        .insert(customerPhones)
        .values(
          chunk.map((row) => ({ shopId: tenant.shopId, phone: row.phone, customerId: row.id })),
        );
      const inserted = await tx
        .insert(customers)
        .values(
          chunk.map((row) => {
            const state = (channel: MarketingChannelValue) =>
              row.consent.find((change) => change.channel === channel)?.state ?? null;
            return {
              shopId: tenant.shopId,
              id: row.id,
              phone: row.phone,
              name: row.name,
              email: row.email,
              note: row.note ?? '',
              tags: row.tags ?? [],
              searchText: customerSearchText(row.name, row.email),
              whatsappConsent: state('whatsapp') ?? 'not_subscribed',
              whatsappConsentAt: state('whatsapp') ? sql`now()` : null,
              smsConsent: state('sms') ?? 'not_subscribed',
              smsConsentAt: state('sms') ? sql`now()` : null,
              emailConsent: state('email') ?? 'not_subscribed',
              emailConsentAt: state('email') ? sql`now()` : null,
            };
          }),
        )
        .returning({ id: customers.id, phone: customers.phone, email: customers.email });
      const byPhone = new Map(inserted.map((customer) => [customer.phone, customer]));
      const ledger = chunk.flatMap((row) => {
        const customer = byPhone.get(row.phone)!;
        return row.consent.map((change) => ({
          shopId: tenant.shopId,
          id: newId(),
          customerId: customer.id,
          channel: change.channel,
          state: change.state,
          source: change.source,
          wording: change.wording,
          contact: change.channel === 'email' ? customer.email! : customer.phone,
          ...actor,
          collectedAt: sql`now()`,
        }));
      });
      if (ledger.length > 0) await tx.insert(consentEvents).values(ledger);
      await appendEvents<CustomerCreatedPayload>(
        tx,
        tenant.shopId,
        inserted.map((customer) => ({
          type: CustomerEvents.CustomerCreated,
          aggregateType: 'customer',
          aggregateId: customer.id,
          payload: { source: 'import', version: 1 },
        })),
      );
      await appendEvents<MarketingConsentUpdatedPayload>(
        tx,
        tenant.shopId,
        chunk.flatMap((row) =>
          row.consent.map((change) => ({
            type: CustomerEvents.MarketingConsentUpdated,
            aggregateType: 'customer',
            aggregateId: byPhone.get(row.phone)!.id,
            payload: { channel: change.channel, state: change.state, source: 'import', version: 1 },
          })),
        ),
      );
    }
  }

  async #update(
    tx: Tx,
    tenant: TenantContext,
    current: CustomerRow,
    row: ImportRow,
  ): Promise<void> {
    const { profile, changes } = this.#overwrite(current, row);
    const next = { ...current, ...changes };
    if ('name' in changes || 'email' in changes) {
      changes.searchText = customerSearchText(next.name, next.email);
    }
    const { set: consent, changed } = await recordConsentChanges(
      tx,
      tenant.shopId,
      { ...current, email: next.email ?? current.email },
      [...contactResets(current, changes), ...row.consent],
      tenant.actor,
      current.version + 1,
    );
    if (profile.length === 0 && changed.length === 0) return;
    const set: PgUpdateSetSource<typeof customers> = {
      ...changes,
      ...consent,
      version: sql`${customers.version} + 1`,
      updatedAt: sql`now()`,
    };
    await tx
      .update(customers)
      .set(set)
      .where(and(eq(customers.shopId, tenant.shopId), eq(customers.id, current.id)));
    if (profile.length > 0) {
      await appendEvent<CustomerUpdatedPayload>(tx, tenant.shopId, {
        type: CustomerEvents.CustomerUpdated,
        aggregateType: 'customer',
        aggregateId: current.id,
        payload: { changed: profile, version: current.version + 1 },
      });
    }
  }

  /**
   * Customers as CSV, oldest first: every customer, a saved segment's members, or a query's.
   * Columns: the profile, consent per channel, every labelled segment field, such as orders and
   * amount spent, and a watermark on each row naming who exported it and when. Each export is
   * recorded as a `customer_export.created` event.
   */
  async export(
    tenant: TenantContext,
    filter: CustomerExportFilter,
  ): Promise<MutationResult<{ csv: string; rowCount: number }>> {
    if (filter.query && filter.segmentId) {
      return failOne(['query'], 'INVALID', 'Give a segment or a query, not both');
    }
    let query = filter.query?.trim() || null;
    const filterField = filter.segmentId ? ['segmentId'] : ['query'];
    if (filter.segmentId) {
      const segment = await this.segments.get(tenant, filter.segmentId);
      if (!segment) return failOne(['segmentId'], 'NOT_FOUND', 'Segment not found');
      query = segment.query;
    }
    let where: SQL = sql`true`;
    const sources = new Map<string, SegmentFactSource>();
    if (query) {
      try {
        const compiled = this.segments.compile(tenant, query);
        where = compiled.where;
        for (const source of compiled.sources) sources.set(source.key, source);
      } catch (error) {
        if (error instanceof SegmentQueryError)
          return failOne(filterField, 'INVALID', error.message);
        throw error;
      }
    }
    const fields: SegmentField[] = [];
    for (const field of this.registry.fields()) {
      if (!field.label) continue;
      fields.push(field);
      const source = this.registry.get(field.name)?.source;
      if (source) sources.set(source.key, source);
    }
    const joins = sourceJoins(sources.values(), tenant.shopId);

    return this.db.tenant(
      tenant.shopId,
      async (tx): Promise<MutationResult<{ csv: string; rowCount: number }>> => {
        const { rows: counted } = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM customers.customers c ${joins}
         WHERE c.shop_id = ${tenant.shopId} AND ${where}`);
        const total = counted[0]!.count;
        if (total > TRANSFER_LIMITS.exportRows) {
          return failOne(
            filterField,
            'TOO_MANY',
            `${total.toLocaleString('en')} customers match; export at most ` +
              `${TRANSFER_LIMITS.exportRows.toLocaleString('en')} at a time. Narrow it down with a ` +
              'segment.',
          );
        }
        const values = fields.map(
          (field, index) => sql`${this.#exportValue(field)} AS ${sql.raw(`f${index}`)}`,
        );
        const { rows } = await tx.execute<Record<string, string | null> & { tags: string[] }>(sql`
        SELECT c.id, c.phone, c.name, c.email, c.tags, c.note, c.whatsapp_consent,
               c.sms_consent, c.email_consent
               ${values.length > 0 ? sql`, ${sql.join(values, sql`, `)}` : sql``}
          FROM customers.customers c ${joins}
         WHERE c.shop_id = ${tenant.shopId} AND ${where}
         ORDER BY c.id`);
        // On every row, so rows copied out of the file still say where they came from.
        const exporter =
          tenant.actor.kind === 'app'
            ? toPublicId('accessToken', tenant.actor.tokenId)
            : toPublicId('user', tenant.actor.userId);
        const watermark = `${exporter} ${new Date().toISOString()}`;
        const csv = toCsv([
          [
            'Customer ID',
            'Phone',
            'Name',
            'Email',
            'Tags',
            'Note',
            'WhatsApp marketing',
            'SMS marketing',
            'Email marketing',
            ...fields.map((field) => field.label!),
            'Exported',
          ],
          ...rows.map((row) => [
            toPublicId('customer', row.id!),
            displayPhone(row.phone!),
            row.name,
            row.email,
            row.tags.join(', '),
            row.note,
            row.whatsapp_consent,
            row.sms_consent,
            row.email_consent,
            ...fields.map((field, index) => {
              const value = row[`f${index}`] ?? null;
              return field.type === 'money' && value !== null
                ? toMajorString(money(BigInt(value), tenant.currency))
                : value;
            }),
            watermark,
          ]),
        ]);
        await appendEvent<CustomerExportCreatedPayload>(tx, tenant.shopId, {
          type: CustomerEvents.CustomerExportCreated,
          aggregateType: 'customer_export',
          aggregateId: newId(),
          payload: {
            rows: rows.length,
            query: filter.segmentId ? null : query,
            segmentId: filter.segmentId ?? null,
            ...actorColumns(tenant.actor),
          },
        });
        return { ok: true, value: { csv, rowCount: rows.length } };
      },
    );
  }

  /** A field's value as text for a CSV cell. */
  #exportValue(field: SegmentField): SQL {
    switch (field.type) {
      case 'date':
        return sql`to_char((${field.sql} AT TIME ZONE ${SEGMENT_TIME_ZONE})::date, 'YYYY-MM-DD')`;
      case 'boolean':
        return sql`CASE WHEN ${field.sql} THEN 'yes' ELSE 'no' END`;
      case 'text_list':
        return sql`array_to_string(${field.sql}, ', ')`;
      default:
        return sql`(${field.sql})::text`;
    }
  }
}
