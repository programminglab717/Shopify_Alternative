import { InputChecker, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { Database, type Tx } from '@hatti/db';
import type { CurrencyCode } from '@hatti/money';
import { appendEvent } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// A product's personalisation fields (CAT-15, ADR-689): what its page asks the shopper for when it
// is made to order, the name to embroider or a choice of thread. Each answer goes with the cart
// line as one of its properties, named as the field is, which the order's line keeps (ADR-687).
// A field may add to the line's price when it is answered, as embroidery costs (ADR-697).

/** Events of a product's personalisation fields. Payloads are thin. */
export const PersonalisationEvents = {
  /** A product's fields were set, changed or taken away. */
  Updated: 'product_personalisation.updated',
} as const;

/** What a field asks for: words the shopper writes, or one of the shop's choices. */
export const PERSONALISATION_KINDS = ['text', 'choice'] as const;
export type PersonalisationKindValue = (typeof PERSONALISATION_KINDS)[number];

/**
 * How many fields a product asks for, how long a field's name may be, how long an answer may be at
 * most and when the shop says nothing, and how many choices a field offers and how long each is.
 * An answer is a cart line's property, whose value checkout takes up to 1,000 characters.
 */
export const PERSONALISATION_LIMITS = {
  fields: 5,
  name: 40,
  maxLength: 250,
  defaultMaxLength: 50,
  choices: 20,
  choice: 40,
} as const;

/** A field as its product's page asks for it. */
export interface PersonalisationField {
  /** What the page calls it, and the name of the property its answer goes in. */
  name: string;
  kind: PersonalisationKindValue;
  /** Whether the page asks for an answer before adding to the cart. */
  required: boolean;
  /** The longest answer a text field takes; null for a choice. */
  maxLength: number | null;
  /** What a choice offers, in order; none for a text field. */
  choices: string[];
  /** What an answer adds to the price of each unit, in minor units; 0 for nothing (ADR-697). */
  price: number;
}

/** A field as the shop gives it. */
export interface PersonalisationFieldInput {
  name: string;
  kind: PersonalisationKindValue;
  required?: boolean | null;
  maxLength?: number | null;
  choices?: readonly string[] | null;
  /** What an answer adds to each unit's price, in major units, as "500"; nothing unless given. */
  price?: string | null;
}

/** The fields checked: each named once, not as apps' properties are, with what its kind takes. */
function checkFields(
  check: InputChecker,
  given: readonly PersonalisationFieldInput[],
  currency: CurrencyCode,
): PersonalisationField[] {
  if (given.length > PERSONALISATION_LIMITS.fields) {
    check.addMessage(
      ['fields'],
      'TOO_MANY',
      `A product asks for ${PERSONALISATION_LIMITS.fields} fields at most`,
    );
  }
  const names = new Set<string>();
  return given.map((input, index) => {
    const field = ['fields', String(index)];
    const name =
      check.text([...field, 'name'], input.name, {
        required: true,
        max: PERSONALISATION_LIMITS.name,
      }) ?? '';
    if (name.startsWith('_')) {
      // A property whose name begins "_" is an app's, hidden from the shopper (ADR-687).
      check.addMessage([...field, 'name'], 'INVALID', "A field's name can't begin with _");
    } else if (name !== '' && names.has(name.toLowerCase())) {
      check.addMessage([...field, 'name'], 'TAKEN', `${name} is a field of this product already`);
    }
    names.add(name.toLowerCase());
    if (!PERSONALISATION_KINDS.includes(input.kind)) {
      check.add([...field, 'kind'], 'INVALID', 'must be text or choice');
    }
    const required = input.required === true;
    const price = Number(check.price([...field, 'price'], input.price, currency) ?? 0n);
    if (input.kind === 'choice') {
      const choices: string[] = [];
      const seen = new Set<string>();
      (input.choices ?? []).forEach((raw, at) => {
        const choice = raw.trim();
        const choiceField = [...field, 'choices', String(at)];
        if (choice === '') return;
        if (choice.length > PERSONALISATION_LIMITS.choice) {
          check.addMessage(
            choiceField,
            'TOO_LONG',
            `A choice is too long (maximum is ${PERSONALISATION_LIMITS.choice} characters)`,
          );
        } else if (seen.has(choice.toLowerCase())) {
          check.addMessage(choiceField, 'TAKEN', `${choice} is a choice already`);
        }
        seen.add(choice.toLowerCase());
        choices.push(choice);
      });
      if (choices.length < 2) {
        check.addMessage([...field, 'choices'], 'TOO_FEW', 'A choice offers two at least');
      } else if (choices.length > PERSONALISATION_LIMITS.choices) {
        check.addMessage(
          [...field, 'choices'],
          'TOO_MANY',
          `A choice offers ${PERSONALISATION_LIMITS.choices} at most`,
        );
      }
      return { name, kind: 'choice', required, maxLength: null, choices, price };
    }
    const maxLength =
      check.integer([...field, 'maxLength'], input.maxLength, {
        min: 1,
        max: PERSONALISATION_LIMITS.maxLength,
      }) ?? PERSONALISATION_LIMITS.defaultMaxLength;
    return { name, kind: 'text', required, maxLength, choices: [], price };
  });
}

/** Whether two lists ask for the same, whatever the order of each field's keys, as jsonb keeps it. */
function sameFields(a: readonly PersonalisationField[], b: readonly PersonalisationField[]) {
  const canonical = (fields: readonly PersonalisationField[]) =>
    JSON.stringify(
      fields.map((field) => [
        field.name,
        field.kind,
        field.required,
        field.maxLength,
        field.choices,
        field.price,
      ]),
    );
  return canonical(a) === canonical(b);
}

/**
 * Each of `productIds`' personalisation fields, in the caller's transaction `tx`, in the order its
 * page asks for them. A product that asks for none has none in the map.
 */
export async function personalisationIn(
  tx: Tx,
  shopId: string,
  productIds: readonly string[],
): Promise<Map<string, PersonalisationField[]>> {
  if (productIds.length === 0) return new Map();
  const { rows } = await tx.execute<{ product_id: string; fields: PersonalisationField[] }>(sql`
    SELECT product_id, fields FROM catalog.product_personalisation
     WHERE shop_id = ${shopId} AND product_id = ANY(${sql.param([...productIds])}::uuid[])`);
  // Fields kept before a field could add to the price add nothing.
  return new Map(
    rows
      .filter((row) => row.fields.length > 0)
      .map((row) => [
        row.product_id,
        row.fields.map((field) => ({ ...field, price: field.price ?? 0 })),
      ]),
  );
}

/**
 * What the answers in `properties` add to each unit's price, in minor units, for the `fields` its
 * product asks for (ADR-697): each field answered, not blank, adds its price.
 */
export function personalisationPrice(
  fields: readonly PersonalisationField[],
  properties: Readonly<Record<string, string>>,
): bigint {
  let added = 0n;
  for (const field of fields) {
    if (field.price > 0 && (properties[field.name] ?? '').trim() !== '') {
      added += BigInt(field.price);
    }
  }
  return added;
}

/** What a shop asks shoppers for on the products it makes to order (CAT-15, ADR-689). */
@Injectable()
export class PersonalisationService {
  constructor(private readonly db: Database) {}

  /** Each of `productIds`' fields, in order. */
  async of(
    tenant: TenantContext,
    productIds: readonly string[],
  ): Promise<Map<string, PersonalisationField[]>> {
    return this.db.tenant(tenant.shopId, (tx) => personalisationIn(tx, tenant.shopId, productIds));
  }

  /**
   * Asks for `fields` on a product, in their order, in place of those it asked for; none, and its
   * page asks for nothing. Its fields as they are now.
   */
  async set(
    tenant: TenantContext,
    productId: string,
    fields: readonly PersonalisationFieldInput[],
  ): Promise<MutationResult<PersonalisationField[]>> {
    const check = new InputChecker();
    const kept = checkFields(check, fields, tenant.currency);
    if (!check.ok) return { ok: false, errors: check.errors };
    return this.db.tenant(tenant.shopId, async (tx) => {
      const shopId = tenant.shopId;
      const { rows: product } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM catalog.products WHERE shop_id = ${shopId} AND id = ${productId}
           FOR UPDATE`);
      if (!product[0]) return failOne(['productId'], 'NOT_FOUND', 'Product not found');
      const before = (await personalisationIn(tx, shopId, [productId])).get(productId) ?? [];
      if (sameFields(before, kept)) return { ok: true, value: before };
      if (kept.length === 0) {
        await tx.execute(sql`
          DELETE FROM catalog.product_personalisation
           WHERE shop_id = ${shopId} AND product_id = ${productId}`);
      } else {
        await tx.execute(sql`
          INSERT INTO catalog.product_personalisation (shop_id, product_id, fields)
          VALUES (${shopId}, ${productId}, ${JSON.stringify(kept)}::jsonb)
          ON CONFLICT (shop_id, product_id) DO UPDATE
            SET fields = EXCLUDED.fields, updated_at = now()`);
      }
      await appendEvent(tx, shopId, {
        type: PersonalisationEvents.Updated,
        aggregateType: 'product',
        aggregateId: productId,
        payload: { fields: kept.length },
      });
      return { ok: true, value: kept };
    });
  }
}
