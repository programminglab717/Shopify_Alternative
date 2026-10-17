import {
  UserErrorsRollback,
  failOne,
  rollbackResult,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { Database, isUniqueViolation, toDate, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

// Metafields (CAT-06, ADR-489): custom data a shop keeps on its products, variants and
// collections, as Shopify's: a namespace, a key, a type and a value kept as a string. Definitions
// name the shop's own fields and fix their types. Themes read them in Liquid, and apps through the
// Admin API, as they read Shopify's.

/** Events of metafields. Payloads name the products and collections whose pages show others. */
export const MetafieldEvents = {
  Updated: 'metafields.updated',
} as const;

export interface MetafieldsChangedPayload {
  productIds: string[];
  collectionIds: string[];
}

export const METAFIELD_TYPES = [
  'single_line_text_field',
  'multi_line_text_field',
  'number_integer',
  'number_decimal',
  'boolean',
  'date',
  'date_time',
  'url',
  'color',
  'json',
  'list.single_line_text_field',
] as const;
export type MetafieldType = (typeof METAFIELD_TYPES)[number];

export const METAFIELD_OWNER_TYPES = ['product', 'variant', 'collection'] as const;
export type MetafieldOwnerType = (typeof METAFIELD_OWNER_TYPES)[number];

export const METAFIELD_LIMITS = {
  /** Metafields one product, variant or collection keeps. */
  perOwner: 100,
  /** Metafields one call sets or deletes, as Shopify's metafieldsSet. */
  perCall: 25,
  /** Definitions a shop keeps for each kind of owner. */
  definitions: 100,
  /** Characters of a single line of text, and of each in a list. */
  singleLine: 1_000,
  /** Characters of the other text types. */
  text: 16_384,
  /** Characters of a JSON value. */
  json: 65_536,
  /** Items of a list. */
  listItems: 128,
  url: 2_048,
} as const;

/** Namespaces Hatti writes itself, from what the shop keeps elsewhere: none sets them. */
export const RESERVED_NAMESPACES = new Set(['hatti', 'reviews']);

const NAME = /^[A-Za-z0-9_-]{2,64}$/;

export interface MetafieldOwner {
  type: MetafieldOwnerType;
  id: string;
}

export interface MetafieldRecord {
  id: string;
  owner: MetafieldOwner;
  namespace: string;
  key: string;
  type: MetafieldType;
  value: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MetafieldSetInput {
  owner: MetafieldOwner;
  namespace: string;
  key: string;
  /** Its type; the definition's where one names the field, which it must then agree with. */
  type?: string | null;
  value: string;
}

export interface MetafieldIdentifier {
  owner: MetafieldOwner;
  namespace: string;
  key: string;
}

export interface MetafieldDefinitionRecord {
  id: string;
  ownerType: MetafieldOwnerType;
  namespace: string;
  key: string;
  type: MetafieldType;
  name: string;
  description: string | null;
  /** How many of the shop's owners of its kind have a value for it. */
  valuesCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MetafieldDefinitionInput {
  ownerType: MetafieldOwnerType;
  namespace: string;
  key: string;
  type: string;
  name: string;
  description?: string | null;
}

/** A metafield as a storefront document keeps it: its type and value, as the Admin API's. */
export interface ShownMetafield {
  type: MetafieldType;
  value: string;
}

/** By namespace, then key. */
export type ShownMetafields = Record<string, Record<string, ShownMetafield>>;

export function isMetafieldType(type: string): type is MetafieldType {
  return (METAFIELD_TYPES as readonly string[]).includes(type);
}

/**
 * A value checked for its type and kept as Shopify keeps it: numbers and dates in a standard
 * form, JSON compact, colours in lower case. Why not, where it is not one of its type.
 */
export function metafieldValueOf(
  type: MetafieldType,
  given: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const fail = (message: string) => ({ ok: false as const, message });
  const value = type === 'multi_line_text_field' || type === 'json' ? given : given.trim();
  if (value.trim() === '') return fail("can't be blank");
  switch (type) {
    case 'single_line_text_field':
      if (/[\r\n]/.test(value)) return fail('must be one line');
      if (value.length > METAFIELD_LIMITS.singleLine) {
        return fail(`must be ${METAFIELD_LIMITS.singleLine} characters or fewer`);
      }
      return { ok: true, value };
    case 'multi_line_text_field':
      if (value.length > METAFIELD_LIMITS.text) {
        return fail(`must be ${METAFIELD_LIMITS.text} characters or fewer`);
      }
      return { ok: true, value };
    case 'number_integer': {
      if (!/^[+-]?\d{1,16}$/.test(value)) return fail('must be a whole number');
      const number = Number(value);
      if (!Number.isSafeInteger(number)) return fail('is too large');
      return { ok: true, value: String(number) };
    }
    case 'number_decimal': {
      if (!/^[+-]?\d{1,16}(\.\d{1,9})?$/.test(value)) return fail('must be a decimal number');
      const [whole, fraction] = value.replace(/^\+/, '').split('.');
      const integer = whole!.replace(/^(-?)0+(?=\d)/, '$1');
      const decimals = fraction?.replace(/0+$/, '');
      return { ok: true, value: decimals ? `${integer}.${decimals}` : `${integer}.0` };
    }
    case 'boolean':
      if (value !== 'true' && value !== 'false') return fail('must be true or false');
      return { ok: true, value };
    case 'date': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail('must be a date: YYYY-MM-DD');
      const date = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        return fail('must be a date: YYYY-MM-DD');
      }
      return { ok: true, value };
    }
    case 'date_time': {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return fail('must be a date and time');
      const time = new Date(value);
      if (Number.isNaN(time.getTime())) return fail('must be a date and time');
      return { ok: true, value: time.toISOString() };
    }
    case 'url': {
      if (value.length > METAFIELD_LIMITS.url) {
        return fail(`must be ${METAFIELD_LIMITS.url} characters or fewer`);
      }
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
        return { ok: true, value: url.href };
      } catch {
        return fail('must be a web address starting https://');
      }
    }
    case 'color':
      if (!/^#[0-9A-Fa-f]{6}$/.test(value)) return fail('must be a colour such as #0F766E');
      return { ok: true, value: value.toLowerCase() };
    case 'json': {
      if (value.length > METAFIELD_LIMITS.json) {
        return fail(`must be ${METAFIELD_LIMITS.json} characters or fewer`);
      }
      try {
        return { ok: true, value: JSON.stringify(JSON.parse(value)) };
      } catch {
        return fail('must be JSON');
      }
    }
    case 'list.single_line_text_field': {
      let items: unknown;
      try {
        items = JSON.parse(value);
      } catch {
        return fail('must be a JSON list of lines: ["Lawn", "Chiffon"]');
      }
      if (!Array.isArray(items) || items.some((item) => typeof item !== 'string')) {
        return fail('must be a JSON list of lines: ["Lawn", "Chiffon"]');
      }
      const lines = (items as string[]).map((item) => item.trim());
      if (lines.length === 0) return fail("can't be an empty list");
      if (lines.length > METAFIELD_LIMITS.listItems) {
        return fail(`may hold ${METAFIELD_LIMITS.listItems} items at most`);
      }
      if (lines.some((line) => line === '' || /[\r\n]/.test(line))) {
        return fail('must hold lines, none blank');
      }
      if (lines.some((line) => line.length > METAFIELD_LIMITS.singleLine)) {
        return fail(`must hold lines of ${METAFIELD_LIMITS.singleLine} characters or fewer`);
      }
      return { ok: true, value: JSON.stringify(lines) };
    }
  }
}

/** Why a namespace or key is refused at `field`; null when it is one. */
function nameProblem(field: string[], namespace: string, key: string): FieldError | null {
  if (!NAME.test(namespace)) {
    return {
      field: [...field, 'namespace'],
      code: 'INVALID',
      message: 'Namespace must be 2 to 64 letters, digits, - or _',
    };
  }
  if (!NAME.test(key)) {
    return {
      field: [...field, 'key'],
      code: 'INVALID',
      message: 'Key must be 2 to 64 letters, digits, - or _',
    };
  }
  if (RESERVED_NAMESPACES.has(namespace.toLowerCase())) {
    return {
      field: [...field, 'namespace'],
      code: 'INVALID',
      message: `The ${namespace} namespace is Hatti's own`,
    };
  }
  return null;
}

const COLUMN: Record<MetafieldOwnerType, SQL> = {
  product: sql.raw('product_id'),
  variant: sql.raw('variant_id'),
  collection: sql.raw('collection_id'),
};

const TABLE: Record<MetafieldOwnerType, SQL> = {
  product: sql.raw('catalog.products'),
  variant: sql.raw('catalog.variants'),
  collection: sql.raw('catalog.collections'),
};

type MetafieldRow = {
  id: string;
  product_id: string | null;
  variant_id: string | null;
  collection_id: string | null;
  namespace: string;
  key: string;
  type: MetafieldType;
  value: string;
  created_at: string | Date;
  updated_at: string | Date;
};

function toRecord(row: MetafieldRow): MetafieldRecord {
  const owner: MetafieldOwner = row.product_id
    ? { type: 'product', id: row.product_id }
    : row.variant_id
      ? { type: 'variant', id: row.variant_id }
      : { type: 'collection', id: row.collection_id! };
  return {
    id: row.id,
    owner,
    namespace: row.namespace,
    key: row.key,
    type: row.type,
    value: row.value,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

type DefinitionRow = {
  id: string;
  owner_type: MetafieldOwnerType;
  namespace: string;
  key: string;
  type: MetafieldType;
  name: string;
  description: string | null;
  values_count: number | string;
  created_at: string | Date;
  updated_at: string | Date;
};

const DEFINITION_COLUMNS = sql.raw(
  'd.id, d.owner_type, d.namespace, d.key, d.type, d.name, d.description, d.created_at, ' +
    'd.updated_at, (SELECT count(*) FROM catalog.metafields m WHERE m.shop_id = d.shop_id ' +
    '  AND m.namespace = d.namespace AND m.key = d.key AND CASE d.owner_type ' +
    "  WHEN 'product' THEN m.product_id IS NOT NULL WHEN 'variant' THEN m.variant_id IS NOT NULL " +
    '  ELSE m.collection_id IS NOT NULL END) AS values_count',
);

function toDefinition(row: DefinitionRow): MetafieldDefinitionRecord {
  return {
    id: row.id,
    ownerType: row.owner_type,
    namespace: row.namespace,
    key: row.key,
    type: row.type,
    name: row.name,
    description: row.description,
    valuesCount: Number(row.values_count),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

/** The products whose pages show the owners' metafields: their own, or their variants'. */
async function touched(
  tx: Tx,
  shopId: string,
  owners: readonly MetafieldOwner[],
): Promise<MetafieldsChangedPayload> {
  const products = new Set(owners.filter((o) => o.type === 'product').map((o) => o.id));
  const variants = owners.filter((o) => o.type === 'variant').map((o) => o.id);
  if (variants.length > 0) {
    const { rows } = await tx.execute<{ product_id: string }>(sql`
      SELECT DISTINCT product_id FROM catalog.variants
       WHERE shop_id = ${shopId} AND id = ANY(${sql.param(variants)}::uuid[])`);
    for (const row of rows) products.add(row.product_id);
  }
  return {
    productIds: [...products].sort(),
    collectionIds: [
      ...new Set(owners.filter((o) => o.type === 'collection').map((o) => o.id)),
    ].sort(),
  };
}

async function changed(tx: Tx, shopId: string, owners: readonly MetafieldOwner[]): Promise<void> {
  const payload = await touched(tx, shopId, owners);
  if (payload.productIds.length === 0 && payload.collectionIds.length === 0) return;
  await appendEvent<MetafieldsChangedPayload>(tx, shopId, {
    type: MetafieldEvents.Updated,
    aggregateType: 'metafields',
    aggregateId: payload.productIds[0] ?? payload.collectionIds[0]!,
    payload,
  });
}

/**
 * The metafields of the owners of a kind among `ids`, by owner, in the caller's transaction `tx`,
 * each owner's by namespace and key: what their storefront documents hold (ADR-489).
 */
export async function shownMetafieldsIn(
  tx: Tx,
  shopId: string,
  type: MetafieldOwnerType,
  ids: readonly string[],
): Promise<Map<string, ShownMetafields>> {
  if (ids.length === 0) return new Map();
  const column = COLUMN[type];
  const { rows } = await tx.execute<{
    owner_id: string;
    namespace: string;
    key: string;
    type: MetafieldType;
    value: string;
  }>(sql`
    SELECT ${column} AS owner_id, namespace, key, type, value FROM catalog.metafields
     WHERE shop_id = ${shopId} AND ${column} = ANY(${sql.param([...ids])}::uuid[])
     ORDER BY namespace, key`);
  const shown = new Map<string, ShownMetafields>();
  for (const row of rows) {
    const fields = shown.get(row.owner_id) ?? {};
    (fields[row.namespace] ??= {})[row.key] = { type: row.type, value: row.value };
    shown.set(row.owner_id, fields);
  }
  return shown;
}

/**
 * The shop's metafields and their definitions (CAT-06, ADR-489): set many at once, all or none,
 * each checked against its type and its definition's; deleted; read for the owners of a kind.
 */
@Injectable()
export class MetafieldService {
  constructor(private readonly db: Database) {}

  /** The metafields of the owners of a kind among `ids`, by owner; in one namespace, if given. */
  async ofOwners(
    tenant: TenantContext,
    type: MetafieldOwnerType,
    ids: readonly string[],
    namespace: string | null = null,
  ): Promise<Map<string, MetafieldRecord[]>> {
    if (ids.length === 0) return new Map();
    const column = COLUMN[type];
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<MetafieldRow>(sql`
        SELECT id, product_id, variant_id, collection_id, namespace, key, type, value,
               created_at, updated_at
          FROM catalog.metafields
         WHERE shop_id = ${tenant.shopId} AND ${column} = ANY(${sql.param([...ids])}::uuid[])
           ${namespace === null ? sql`` : sql`AND namespace = ${namespace}`}
         ORDER BY namespace, key`),
    );
    const byOwner = new Map<string, MetafieldRecord[]>();
    for (const record of rows.map(toRecord)) {
      byOwner.set(record.owner.id, [...(byOwner.get(record.owner.id) ?? []), record]);
    }
    return byOwner;
  }

  /**
   * Sets metafields, up to 25, all or none: each made or changed in place, its type the one
   * given, or its definition's, which a type given must agree with. Owners keep 100 each.
   */
  async set(
    tenant: TenantContext,
    inputs: readonly MetafieldSetInput[],
  ): Promise<MutationResult<MetafieldRecord[]>> {
    if (inputs.length === 0) return failOne(['metafields'], 'BLANK', 'Give a metafield to set');
    if (inputs.length > METAFIELD_LIMITS.perCall) {
      return failOne(
        ['metafields'],
        'TOO_MANY',
        `At most ${METAFIELD_LIMITS.perCall} metafields are set at once`,
      );
    }
    return rollbackResult(() =>
      this.db.tenant(tenant.shopId, async (tx): Promise<MutationResult<MetafieldRecord[]>> => {
        const shopId = tenant.shopId;
        const errors: FieldError[] = [];
        const definitions = await this.definitionTypes(tx, shopId);
        const found = await this.ownersFound(
          tx,
          shopId,
          inputs.map((input) => input.owner),
        );
        const seen = new Set<string>();
        const ready: { input: MetafieldSetInput; type: MetafieldType; value: string }[] = [];
        inputs.forEach((input, index) => {
          const field = ['metafields', String(index)];
          if (!found.has(`${input.owner.type}:${input.owner.id}`)) {
            errors.push({
              field: [...field, 'ownerId'],
              code: 'NOT_FOUND',
              message: 'No product, variant or collection of the shop has this ID',
            });
            return;
          }
          const named = nameProblem(field, input.namespace, input.key);
          if (named) {
            errors.push(named);
            return;
          }
          const same = `${input.owner.type}:${input.owner.id}:${input.namespace}:${input.key}`;
          if (seen.has(same)) {
            errors.push({ field, code: 'TAKEN', message: 'This metafield is set twice' });
            return;
          }
          seen.add(same);
          const defined = definitions.get(`${input.owner.type}:${input.namespace}:${input.key}`);
          const type = input.type ?? defined;
          if (!type) {
            errors.push({
              field: [...field, 'type'],
              code: 'BLANK',
              message: 'Type must be given for a metafield with no definition',
            });
            return;
          }
          if (!isMetafieldType(type)) {
            errors.push({
              field: [...field, 'type'],
              code: 'INVALID',
              message: `Type must be one of ${METAFIELD_TYPES.join(', ')}`,
            });
            return;
          }
          if (defined && type !== defined) {
            errors.push({
              field: [...field, 'type'],
              code: 'INVALID',
              message: `Its definition makes it ${defined}`,
            });
            return;
          }
          const value = metafieldValueOf(type, input.value);
          if (!value.ok) {
            errors.push({
              field: [...field, 'value'],
              code: 'INVALID',
              message: `Value ${value.message}`,
            });
            return;
          }
          ready.push({ input, type, value: value.value });
        });
        if (errors.length > 0) return { ok: false, errors };

        const ids: string[] = [];
        for (const { input, type, value } of ready) {
          const column = COLUMN[input.owner.type];
          const { rows } = await tx.execute<{ id: string }>(sql`
          INSERT INTO catalog.metafields (shop_id, ${column}, namespace, key, type, value)
          VALUES (${shopId}, ${input.owner.id}, ${input.namespace}, ${input.key}, ${type},
                  ${value})
          ON CONFLICT (shop_id, ${column}, namespace, key) WHERE ${column} IS NOT NULL
          DO UPDATE SET type = EXCLUDED.type, value = EXCLUDED.value,
                        updated_at = CASE WHEN catalog.metafields.value = EXCLUDED.value
                                          AND catalog.metafields.type = EXCLUDED.type
                                     THEN catalog.metafields.updated_at ELSE now() END
          RETURNING id`);
          ids.push(rows[0]!.id);
        }
        const owners = ready.map(({ input }) => input.owner);
        const over = await this.overLimit(tx, shopId, owners);
        if (over !== null) {
          const index = inputs.findIndex(
            (input) => `${input.owner.type}:${input.owner.id}` === over,
          );
          // Nothing stands: the transaction is rolled back with the error.
          throw new UserErrorsRollback([
            {
              field: ['metafields', String(index), 'ownerId'],
              code: 'TOO_MANY',
              message: `A product, variant or collection keeps ${METAFIELD_LIMITS.perOwner} metafields at most`,
            },
          ]);
        }
        await changed(tx, shopId, owners);
        const { rows } = await tx.execute<MetafieldRow>(sql`
        SELECT id, product_id, variant_id, collection_id, namespace, key, type, value,
               created_at, updated_at
          FROM catalog.metafields
         WHERE shop_id = ${shopId} AND id = ANY(${sql.param(ids)}::uuid[])`);
        const byId = new Map(rows.map((row) => [row.id, toRecord(row)]));
        return { ok: true, value: ids.map((id) => byId.get(id)!) };
      }),
    );
  }

  /** Deletes metafields, up to 25: those it found. */
  async delete(
    tenant: TenantContext,
    identifiers: readonly MetafieldIdentifier[],
  ): Promise<MutationResult<MetafieldIdentifier[]>> {
    if (identifiers.length > METAFIELD_LIMITS.perCall) {
      return failOne(
        ['metafields'],
        'TOO_MANY',
        `At most ${METAFIELD_LIMITS.perCall} metafields are deleted at once`,
      );
    }
    return this.db.tenant(tenant.shopId, async (tx) => {
      const deleted: MetafieldIdentifier[] = [];
      for (const each of identifiers) {
        const column = COLUMN[each.owner.type];
        const { rows } = await tx.execute<{ id: string }>(sql`
          DELETE FROM catalog.metafields
           WHERE shop_id = ${tenant.shopId} AND ${column} = ${each.owner.id}
             AND namespace = ${each.namespace} AND key = ${each.key}
          RETURNING id`);
        if (rows[0]) deleted.push(each);
      }
      await changed(
        tx,
        tenant.shopId,
        deleted.map((each) => each.owner),
      );
      return { ok: true, value: deleted };
    });
  }

  /** The shop's definitions for owners of a kind, or all, by name. */
  async definitions(
    tenant: TenantContext,
    ownerType: MetafieldOwnerType | null = null,
  ): Promise<MetafieldDefinitionRecord[]> {
    const { rows } = await this.db.tenant(tenant.shopId, (tx) =>
      tx.execute<DefinitionRow>(sql`
        SELECT ${DEFINITION_COLUMNS} FROM catalog.metafield_definitions d
         WHERE d.shop_id = ${tenant.shopId}
           ${ownerType === null ? sql`` : sql`AND d.owner_type = ${ownerType}`}
         ORDER BY d.owner_type, lower(d.name), d.id`),
    );
    return rows.map(toDefinition);
  }

  /**
   * Defines a field of the shop's: its name for the admin, and the type its values take. Values
   * set before it must be of that type already.
   */
  async createDefinition(
    tenant: TenantContext,
    input: MetafieldDefinitionInput,
  ): Promise<MutationResult<MetafieldDefinitionRecord>> {
    const named = nameProblem([], input.namespace, input.key);
    if (named) return { ok: false, errors: [named] };
    if (!isMetafieldType(input.type)) {
      return failOne(['type'], 'INVALID', `Type must be one of ${METAFIELD_TYPES.join(', ')}`);
    }
    const name = input.name.trim();
    if (name.length < 1 || name.length > 100) {
      return failOne(['name'], 'INVALID', 'Name must be 1 to 100 characters');
    }
    const description = input.description?.trim() || null;
    if (description && description.length > 300) {
      return failOne(['description'], 'TOO_LONG', 'Description must be 300 characters or fewer');
    }
    try {
      return await this.db.tenant(tenant.shopId, async (tx) => {
        const shopId = tenant.shopId;
        const { rows: counted } = await tx.execute<{ count: string | number }>(sql`
          SELECT count(*) FROM catalog.metafield_definitions
           WHERE shop_id = ${shopId} AND owner_type = ${input.ownerType}`);
        if (Number(counted[0]?.count ?? 0) >= METAFIELD_LIMITS.definitions) {
          return failOne(
            ['ownerType'],
            'TOO_MANY',
            `A shop keeps ${METAFIELD_LIMITS.definitions} definitions of each kind at most`,
          );
        }
        const column = COLUMN[input.ownerType];
        const { rows: other } = await tx.execute<{ type: string }>(sql`
          SELECT DISTINCT type FROM catalog.metafields
           WHERE shop_id = ${shopId} AND ${column} IS NOT NULL
             AND namespace = ${input.namespace} AND key = ${input.key} AND type <> ${input.type}`);
        if (other[0]) {
          return failOne(
            ['type'],
            'INVALID',
            `Values of this field are ${other[0].type} already: define it so, or change them`,
          );
        }
        const { rows } = await tx.execute<{ id: string }>(sql`
          INSERT INTO catalog.metafield_definitions
                 (shop_id, owner_type, namespace, key, type, name, description)
          VALUES (${shopId}, ${input.ownerType}, ${input.namespace}, ${input.key}, ${input.type},
                  ${name}, ${description})
          RETURNING id`);
        return { ok: true, value: (await this.loadDefinition(tx, shopId, rows[0]!.id))! };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return failOne(['key'], 'TAKEN', 'This namespace and key are defined already');
      }
      throw error;
    }
  }

  /** Renames a definition or changes its description; its type and key stay. */
  async updateDefinition(
    tenant: TenantContext,
    id: string,
    input: { name?: string | null; description?: string | null },
  ): Promise<MutationResult<MetafieldDefinitionRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const current = await this.loadDefinition(tx, tenant.shopId, id);
      if (!current) return failOne(['id'], 'NOT_FOUND', 'No definition of the shop has this ID');
      const name = input.name === undefined ? current.name : (input.name ?? '').trim();
      if (name.length < 1 || name.length > 100) {
        return failOne(['name'], 'INVALID', 'Name must be 1 to 100 characters');
      }
      const description =
        input.description === undefined ? current.description : input.description?.trim() || null;
      if (description && description.length > 300) {
        return failOne(['description'], 'TOO_LONG', 'Description must be 300 characters or fewer');
      }
      await tx.execute(sql`
        UPDATE catalog.metafield_definitions
           SET name = ${name}, description = ${description}, updated_at = now()
         WHERE shop_id = ${tenant.shopId} AND id = ${id}`);
      return { ok: true, value: (await this.loadDefinition(tx, tenant.shopId, id))! };
    });
  }

  /**
   * Deletes a definition; with `deleteValues`, its values on every owner of its kind too, whose
   * pages show them no more.
   */
  async deleteDefinition(
    tenant: TenantContext,
    id: string,
    deleteValues: boolean,
  ): Promise<MutationResult<string>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const shopId = tenant.shopId;
      const { rows } = await tx.execute<{
        owner_type: MetafieldOwnerType;
        namespace: string;
        key: string;
      }>(sql`
        DELETE FROM catalog.metafield_definitions WHERE shop_id = ${shopId} AND id = ${id}
        RETURNING owner_type, namespace, key`);
      const definition = rows[0];
      if (!definition) return failOne(['id'], 'NOT_FOUND', 'No definition of the shop has this ID');
      if (deleteValues) {
        const column = COLUMN[definition.owner_type];
        const { rows: gone } = await tx.execute<{ owner_id: string }>(sql`
          DELETE FROM catalog.metafields
           WHERE shop_id = ${shopId} AND ${column} IS NOT NULL
             AND namespace = ${definition.namespace} AND key = ${definition.key}
          RETURNING ${column} AS owner_id`);
        await changed(
          tx,
          shopId,
          gone.map((row) => ({ type: definition.owner_type, id: row.owner_id })),
        );
      }
      return { ok: true, value: id };
    });
  }

  private async loadDefinition(
    tx: Tx,
    shopId: string,
    id: string,
  ): Promise<MetafieldDefinitionRecord | null> {
    const { rows } = await tx.execute<DefinitionRow>(sql`
      SELECT ${DEFINITION_COLUMNS} FROM catalog.metafield_definitions d
       WHERE d.shop_id = ${shopId} AND d.id = ${id}`);
    return rows[0] ? toDefinition(rows[0]) : null;
  }

  /** The types the shop's definitions fix, by owner type, namespace and key. */
  private async definitionTypes(tx: Tx, shopId: string): Promise<Map<string, MetafieldType>> {
    const { rows } = await tx.execute<{
      owner_type: string;
      namespace: string;
      key: string;
      type: MetafieldType;
    }>(sql`
      SELECT owner_type, namespace, key, type FROM catalog.metafield_definitions
       WHERE shop_id = ${shopId}`);
    return new Map(rows.map((row) => [`${row.owner_type}:${row.namespace}:${row.key}`, row.type]));
  }

  /** Which of the owners are the shop's, as `type:id`. */
  private async ownersFound(
    tx: Tx,
    shopId: string,
    owners: readonly MetafieldOwner[],
  ): Promise<Set<string>> {
    const found = new Set<string>();
    for (const type of METAFIELD_OWNER_TYPES) {
      const ids = [...new Set(owners.filter((o) => o.type === type).map((o) => o.id))];
      if (ids.length === 0) continue;
      const { rows } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM ${TABLE[type]}
         WHERE shop_id = ${shopId} AND id = ANY(${sql.param(ids)}::uuid[])`);
      for (const row of rows) found.add(`${type}:${row.id}`);
    }
    return found;
  }

  /** The first owner past its limit of metafields, as `type:id`; null when none is. */
  private async overLimit(
    tx: Tx,
    shopId: string,
    owners: readonly MetafieldOwner[],
  ): Promise<string | null> {
    for (const type of METAFIELD_OWNER_TYPES) {
      const ids = [...new Set(owners.filter((o) => o.type === type).map((o) => o.id))];
      if (ids.length === 0) continue;
      const column = COLUMN[type];
      const { rows } = await tx.execute<{ owner_id: string }>(sql`
        SELECT ${column} AS owner_id FROM catalog.metafields
         WHERE shop_id = ${shopId} AND ${column} = ANY(${sql.param(ids)}::uuid[])
         GROUP BY ${column} HAVING count(*) > ${METAFIELD_LIMITS.perOwner}
         LIMIT 1`);
      if (rows[0]) return `${type}:${rows[0].owner_id}`;
    }
    return null;
  }
}
