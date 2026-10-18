import {
  InputChecker,
  actorColumnsOf,
  fail,
  failOne,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import {
  metafieldDefinitionsIn,
  optionNamesIn,
  type MetafieldDefinitionRecord,
} from '@hatti/catalog/public';
import { Database, type Tx } from '@hatti/db';
import { appendEvent, recordAudit } from '@hatti/events';
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { OnlineStoreEvents, type PreferencesUpdatedPayload } from './events.js';
import { shopPreferencesOf } from './preferences.service.js';
import type { StorefrontFilterKind, StorefrontFilterRecord } from './records.js';
import { preferences } from './schema.js';

// The filters a shop chooses (SRC-03, ADR-568): which of its storefront's filters its collection
// and search pages show, in what order and under what words, as Shopify's Search & Discovery app
// lets a shop choose them, and filters of its products' and variants' metafields beside them. A
// shop that chose none shows every filter the platform has, in the platform's order, as before.

export const STOREFRONT_FILTER_KINDS = [
  'availability',
  'price',
  'product_type',
  'vendor',
  'option',
  'stitching',
  'pieces',
  'fabric',
  'season',
  'product_metafield',
  'variant_metafield',
] as const satisfies readonly StorefrontFilterKind[];

export const STOREFRONT_FILTER_LIMITS = {
  /** Filters a shop's pages show at most. */
  filters: 25,
  /** Characters of a filter's own words, in either language. */
  label: 60,
  /** Characters of an option's name, as products' options may have. */
  option: 255,
} as const;

/** The metafields a filter may be of, those whose values are words: Shopify's, but numbers. */
export const FILTERABLE_METAFIELD_TYPES: readonly string[] = [
  'single_line_text_field',
  'list.single_line_text_field',
  'boolean',
];

/** The platform's filters but options, as its pages call them in English, in their order. */
const BUILT_IN: readonly { kind: StorefrontFilterKind; label: string }[] = [
  { kind: 'availability', label: 'Availability' },
  { kind: 'price', label: 'Price' },
  { kind: 'product_type', label: 'Product type' },
  { kind: 'vendor', label: 'Brand' },
  { kind: 'stitching', label: 'Stitching' },
  { kind: 'pieces', label: 'Pieces' },
  { kind: 'fabric', label: 'Fabric' },
  { kind: 'season', label: 'Season' },
];

export interface StorefrontFilterInput {
  kind: string;
  /** The option's name for `option`; the definition's `namespace.key` for a metafield's. */
  key?: string | null;
  /** Up to 60 characters; blank for the platform's words, or the option's or definition's name. */
  label?: string | null;
  /** On Urdu pages, up to 60 characters; blank for `label`. */
  labelUr?: string | null;
}

/** A filter, chosen or one the shop could choose, with what its pages call it by default. */
export interface StorefrontFilterView extends StorefrontFilterRecord {
  /**
   * The platform's English words for it; an option's name as most of the shop's products spell
   * it; a metafield definition's name; its key where the shop has no such option or definition.
   */
  defaultLabel: string;
  /** A metafield's type, as its definition fixes it; null for the others. */
  metafieldType: string | null;
}

export interface StorefrontFiltersView {
  /** Those its pages show, in their order; null while it chose none: every built-in one. */
  filters: StorefrontFilterView[] | null;
  /**
   * Those it could choose: the platform's, one for each of its products' options, the most used
   * first, and one for each of its product and variant metafield definitions that filter.
   */
  available: StorefrontFilterView[];
}

/** What a shop's pages show, by kind and key: an option's whatever its case. */
function identity(kind: string, key: string | null): string {
  return `${kind}:${kind === 'option' ? (key ?? '').toLowerCase() : (key ?? '')}`;
}

function isMetafieldKind(kind: string): kind is 'product_metafield' | 'variant_metafield' {
  return kind === 'product_metafield' || kind === 'variant_metafield';
}

@Injectable()
export class StorefrontFiltersService {
  constructor(private readonly db: Database) {}

  async get(tenant: TenantContext): Promise<StorefrontFiltersView> {
    return this.db.tenant(tenant.shopId, async (tx) =>
      viewOf(tx, tenant.shopId, (await shopPreferencesOf(tx, tenant.shopId)).storefrontFilters),
    );
  }

  /**
   * Chooses the filters the shop's pages show, in their order, up to 25, each once; null for
   * every built-in one, in the platform's order. An option's filter may name an option none of
   * its products has yet, showing nothing until one does; a metafield's must name one of its
   * definitions, of a type that filters. Records `online_store_preferences.updated` if it
   * changed, and audits it.
   */
  async update(
    tenant: TenantContext,
    filters: readonly StorefrontFilterInput[] | null,
  ): Promise<MutationResult<StorefrontFiltersView>> {
    const field = (index: number, name: string) => ['input', 'filters', String(index), name];
    if (filters && filters.length > STOREFRONT_FILTER_LIMITS.filters) {
      return failOne(
        ['input', 'filters'],
        'TOO_LONG',
        `A storefront shows ${STOREFRONT_FILTER_LIMITS.filters} filters at most`,
      );
    }
    const check = new InputChecker();
    const chosen: StorefrontFilterRecord[] = [];
    const seen = new Set<string>();
    (filters ?? []).forEach((input, index) => {
      const kind = input.kind.trim().toLowerCase();
      if (!(STOREFRONT_FILTER_KINDS as readonly string[]).includes(kind)) {
        check.addMessage(
          field(index, 'kind'),
          'INVALID',
          `Kind must be one of ${STOREFRONT_FILTER_KINDS.join(', ')}`,
        );
        return;
      }
      const key: string | null = (input.key ?? '').trim() || null;
      if (kind === 'option' || isMetafieldKind(kind)) {
        if (key === null) {
          check.addMessage(
            field(index, 'key'),
            'BLANK',
            kind === 'option'
              ? "Give the option's name, like Size"
              : "Give the metafield definition's namespace and key, like custom.material",
          );
          return;
        }
        if (kind === 'option' && key.length > STOREFRONT_FILTER_LIMITS.option) {
          check.add(
            field(index, 'key'),
            'TOO_LONG',
            `is too long (maximum is ${STOREFRONT_FILTER_LIMITS.option} characters)`,
          );
          return;
        }
        if (/\p{Cc}/u.test(key)) {
          check.addMessage(field(index, 'key'), 'INVALID', 'Key has characters it cannot show');
          return;
        }
      } else if (key !== null) {
        check.addMessage(
          field(index, 'key'),
          'INVALID',
          'Only an option or a metafield filter takes a key',
        );
        return;
      }
      const label = wordsOf(check, field(index, 'label'), input.label);
      const labelUr = wordsOf(check, field(index, 'labelUr'), input.labelUr);
      const same = identity(kind, key);
      if (seen.has(same)) {
        check.addMessage(
          field(index, key === null ? 'kind' : 'key'),
          'TAKEN',
          'This filter is chosen twice',
        );
        return;
      }
      seen.add(same);
      chosen.push({ kind: kind as StorefrontFilterKind, key, label, labelUr });
    });
    if (!check.ok) return fail(check.errors);

    return this.db.tenant(tenant.shopId, async (tx) => {
      const shopId = tenant.shopId;
      // Held while the filters change, as its other preferences are.
      await tx.select().from(preferences).where(eq(preferences.shopId, shopId)).for('update');
      const was = (await shopPreferencesOf(tx, shopId)).storefrontFilters;
      if (chosen.some((filter) => isMetafieldKind(filter.kind))) {
        const definitions = definitionsByKey(await metafieldDefinitionsIn(tx, shopId));
        const errors = chosen.flatMap((filter, index): FieldError[] => {
          if (!isMetafieldKind(filter.kind)) return [];
          const definition = definitions.get(identity(filter.kind, filter.key));
          if (!definition) {
            return [
              {
                field: field(index, 'key'),
                code: 'NOT_FOUND',
                message: `No ${filter.kind === 'product_metafield' ? 'product' : 'variant'} metafield definition of the shop has this namespace and key`,
              },
            ];
          }
          if (!FILTERABLE_METAFIELD_TYPES.includes(definition.type)) {
            return [
              {
                field: field(index, 'key'),
                code: 'INVALID',
                message:
                  'Only single line text, lists of it, and true or false metafields filter products',
              },
            ];
          }
          return [];
        });
        if (errors.length > 0) return fail(errors);
      }
      const next = filters === null ? null : chosen;
      if (JSON.stringify(next) === JSON.stringify(was)) {
        return { ok: true, value: await viewOf(tx, shopId, was) };
      }
      await tx
        .insert(preferences)
        .values({ shopId, storefrontFilters: next })
        .onConflictDoUpdate({
          target: preferences.shopId,
          set: { storefrontFilters: next, updatedAt: sql`now()` },
        });
      await appendEvent<PreferencesUpdatedPayload>(tx, shopId, {
        type: OnlineStoreEvents.PreferencesUpdated,
        aggregateType: 'online_store_preferences',
        aggregateId: shopId,
        payload: { changed: ['storefrontFilters'] },
      });
      await recordAudit(tx, shopId, {
        action: 'storefront_filters.updated',
        subjectType: 'shop',
        subjectId: shopId,
        ...actorColumnsOf(tenant.actor),
        details: {
          filters:
            next &&
            next.map((filter) => (filter.key ? `${filter.kind}:${filter.key}` : filter.kind)),
        },
      });
      return { ok: true, value: await viewOf(tx, shopId, next) };
    });
  }
}

/** A filter's own words, as given: null where blank, for the platform's. */
function wordsOf(
  check: InputChecker,
  field: string[],
  value: string | null | undefined,
): string | null {
  const words = check.text(field, value, { max: STOREFRONT_FILTER_LIMITS.label });
  if (words !== null && /\p{Cc}/u.test(words)) {
    check.addMessage(field, 'INVALID', 'Label has characters it cannot show');
  }
  return words;
}

/** The shop's product and variant definitions, by kind of filter and `namespace.key`. */
function definitionsByKey(
  definitions: readonly MetafieldDefinitionRecord[],
): Map<string, MetafieldDefinitionRecord> {
  const byKey = new Map<string, MetafieldDefinitionRecord>();
  for (const definition of definitions) {
    if (definition.ownerType === 'collection') continue;
    const kind = `${definition.ownerType}_metafield`;
    byKey.set(identity(kind, `${definition.namespace}.${definition.key}`), definition);
  }
  return byKey;
}

/** The filters chosen, and those the shop could choose, each with its words by default. */
async function viewOf(
  tx: Tx,
  shopId: string,
  chosen: readonly StorefrontFilterRecord[] | null,
): Promise<StorefrontFiltersView> {
  const options = await optionNamesIn(tx, shopId);
  const definitions = await metafieldDefinitionsIn(tx, shopId);
  const byKey = definitionsByKey(definitions);
  const spelled = new Map(options.map((name) => [name.toLowerCase(), name]));
  const builtIn = new Map(BUILT_IN.map((filter) => [filter.kind, filter.label]));
  const shown = (filter: StorefrontFilterRecord): StorefrontFilterView => {
    const definition = byKey.get(identity(filter.kind, filter.key));
    return {
      ...filter,
      defaultLabel:
        builtIn.get(filter.kind) ??
        (filter.kind === 'option' ? spelled.get((filter.key ?? '').toLowerCase()) : null) ??
        definition?.name ??
        filter.key ??
        filter.kind,
      metafieldType: isMetafieldKind(filter.kind) ? (definition?.type ?? null) : null,
    };
  };
  const none = { label: null, labelUr: null };
  const available: StorefrontFilterRecord[] = [
    ...BUILT_IN.slice(0, 4).map(({ kind }) => ({ kind, key: null, ...none })),
    ...options.map((name) => ({ kind: 'option' as const, key: name, ...none })),
    ...BUILT_IN.slice(4).map(({ kind }) => ({ kind, key: null, ...none })),
    ...definitions
      .filter(
        (definition) =>
          definition.ownerType !== 'collection' &&
          FILTERABLE_METAFIELD_TYPES.includes(definition.type),
      )
      .map((definition) => ({
        kind: `${definition.ownerType as 'product' | 'variant'}_metafield` as const,
        key: `${definition.namespace}.${definition.key}`,
        ...none,
      })),
  ];
  return { filters: chosen && chosen.map(shown), available: available.map(shown) };
}

/**
 * The filters a shop chose, in the caller's transaction `tx`, as its storefront's document holds
 * them (ADR-568): a metafield's without words of its own called by its definition's name. Null
 * while it chose none.
 */
export async function shownStorefrontFiltersIn(
  tx: Tx,
  shopId: string,
): Promise<StorefrontFilterRecord[] | null> {
  const chosen = (await shopPreferencesOf(tx, shopId)).storefrontFilters;
  if (!chosen?.some((filter) => isMetafieldKind(filter.kind) && filter.label === null)) {
    return chosen;
  }
  const byKey = definitionsByKey(await metafieldDefinitionsIn(tx, shopId));
  return chosen.map((filter) =>
    isMetafieldKind(filter.kind) && filter.label === null
      ? { ...filter, label: byKey.get(identity(filter.kind, filter.key))?.name ?? null }
      : filter,
  );
}
