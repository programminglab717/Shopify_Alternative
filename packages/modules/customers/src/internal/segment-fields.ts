import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { MARKETING_CHANNELS, MARKETING_STATES } from './schema.js';

/** What a segment field holds, which decides the conditions it takes. */
export const SEGMENT_FIELD_TYPES = [
  'number',
  'money',
  'date',
  'text',
  'text_list',
  'boolean',
] as const;
export type SegmentFieldType = (typeof SEGMENT_FIELD_TYPES)[number];

/** The operators each type of field takes, as written in queries. */
export const SEGMENT_OPERATORS: Readonly<Record<SegmentFieldType, readonly string[]>> = {
  number: ['=', '!=', '>', '>=', '<', '<=', 'BETWEEN'],
  money: ['=', '!=', '>', '>=', '<', '<=', 'BETWEEN'],
  date: ['=', '!=', '>', '>=', '<', '<=', 'BETWEEN'],
  text: ['=', '!=', 'IN', 'NOT IN'],
  text_list: ['CONTAINS', 'NOT CONTAINS'],
  boolean: ['=', '!='],
};

/** A field segment queries can use. */
export interface SegmentField {
  /** As written in queries: lower case letters, digits and underscores, e.g. "number_of_orders". */
  name: string;
  type: SegmentFieldType;
  description: string;
  /** A condition using it, e.g. "number_of_orders >= 2". */
  example: string;
  /**
   * Its value for the customer `c` (a row of customers.customers), as SQL. Fields of a fact
   * source read that source's columns through its key, e.g.
   * sql`coalesce(order_facts.number_of_orders, 0)`.
   */
  sql: SQL;
  /** Text fields: the stored form of a value, e.g. a city's standard spelling; null if invalid. */
  normalize?: (value: string) => string | null;
  /** Text fields: why a value `normalize` rejected is wrong, e.g. "is not a province". */
  invalidValue?: string;
}

/**
 * Facts another module keeps about customers, for segments: what they ordered, for instance. The
 * module registers it with {@link SegmentFieldRegistry}, so segments can use its fields without
 * the customers module knowing its tables.
 */
export interface SegmentFactSource {
  /** Names the facts in queries, e.g. "order_facts": lower case letters and underscores. */
  key: string;
  /**
   * One row per customer that has facts, with a `customer_id` column. Customers without a row
   * have none: its fields' SQL says what that reads as, e.g. no orders.
   */
  query(shopId: string): SQL;
  fields: SegmentField[];
}

const CHANNEL_NAMES = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'email' } as const;

/** Marketing consent per channel: whatsapp_subscription_status = subscribed. */
const CONSENT_FIELDS: SegmentField[] = MARKETING_CHANNELS.map((channel) => ({
  name: `${channel}_subscription_status`,
  type: 'text',
  description:
    `Whether they agreed to marketing on ${CHANNEL_NAMES[channel]}: subscribed, ` +
    'not_subscribed (never asked) or unsubscribed.',
  example: `${channel}_subscription_status = subscribed`,
  sql: sql.raw(`c.${channel}_consent`),
  normalize: (value) => {
    const state = value.toLowerCase();
    return (MARKETING_STATES as readonly string[]).includes(state) ? state : null;
  },
  invalidValue: 'is not subscribed, not_subscribed or unsubscribed',
}));

/** The customers module's own fields. `c` is the customer's row. */
const CUSTOMER_FIELDS: SegmentField[] = [
  {
    name: 'customer_tags',
    type: 'text_list',
    description: "The customer's tags.",
    example: "customer_tags CONTAINS 'wholesale'",
    sql: sql`c.tags`,
  },
  {
    name: 'customer_added_date',
    type: 'date',
    description: 'When they became a customer: their first order, or when staff added them.',
    example: 'customer_added_date > -30d',
    sql: sql`c.created_at`,
  },
  {
    name: 'blocked',
    type: 'boolean',
    description: 'Their number is on the blocklist.',
    example: 'blocked = false',
    sql: sql`EXISTS (SELECT 1 FROM customers.blocklist_entries b
                      WHERE b.shop_id = c.shop_id AND b.phone = c.phone)`,
  },
  ...CONSENT_FIELDS,
];

const NAME = /^[a-z][a-z0-9_]*$/;

export interface RegisteredSegmentField {
  field: SegmentField;
  /** Null for the customers module's own fields. */
  source: SegmentFactSource | null;
}

/**
 * The fields segment queries can use: the customers module's own, and those other modules
 * register. Modules register at start-up, before any request.
 */
@Injectable()
export class SegmentFieldRegistry {
  readonly #fields = new Map<string, RegisteredSegmentField>();
  readonly #sources = new Set<string>();

  constructor() {
    for (const field of CUSTOMER_FIELDS) this.#add(field, null);
  }

  register(source: SegmentFactSource): void {
    if (!NAME.test(source.key) || this.#sources.has(source.key)) {
      throw new Error(`Invalid or duplicate segment fact source "${source.key}"`);
    }
    this.#sources.add(source.key);
    for (const field of source.fields) this.#add(field, source);
  }

  get(name: string): RegisteredSegmentField | undefined {
    return this.#fields.get(name);
  }

  /** Every field, in the order registered. */
  fields(): SegmentField[] {
    return [...this.#fields.values()].map((entry) => entry.field);
  }

  #add(field: SegmentField, source: SegmentFactSource | null): void {
    if (!NAME.test(field.name) || this.#fields.has(field.name)) {
      throw new Error(`Invalid or duplicate segment field "${field.name}"`);
    }
    this.#fields.set(field.name, { field, source });
  }
}
