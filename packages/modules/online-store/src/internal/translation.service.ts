import { InputChecker, fail, failOne, type MutationResult, type TenantContext } from '@hatti/api';
import { CollectionService, ProductService } from '@hatti/catalog/public';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { searchKey } from '@hatti/pk';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ArticleService } from './article.service.js';
import { BlogService } from './blog.service.js';
import { contentSearchText } from './content-search.js';
import { OnlineStoreEvents, type TranslationsUpdatedPayload } from './events.js';
import { MenuService } from './menu.service.js';
import { PageService } from './page.service.js';
import type { MenuItemRecord, Page } from './records.js';
import { articles, pages, policies, translations } from './schema.js';
import {
  TRANSLATABLE_FIELDS,
  TRANSLATION_LIMITS,
  TRANSLATION_LOCALES,
  checkTranslation,
  isTranslationLocale,
  translatableContent,
  translationValue,
  type TranslatableContentRecord,
  type TranslatableKind,
  type TranslatableSource,
  type TranslationKey,
} from './translation-content.js';

/** A translation as the API gives it, as Shopify's Translation. */
export interface TranslationRecord {
  key: TranslationKey;
  value: string;
  locale: string;
  /** Whether the shop's own words have changed since it was written for them. */
  outdated: boolean;
  updatedAt: Date;
}

/**
 * Something of the shop's that may be translated (ADR-238), as Shopify's TranslatableResource:
 * its fields with words, and their translations in every language.
 */
export interface TranslatableResourceRecord {
  kind: TranslatableKind;
  id: string;
  content: TranslatableContentRecord[];
  translations: TranslationRecord[];
}

/** A translation as given, as Shopify's TranslationInput. */
export interface TranslationInputValue {
  locale: string;
  key: string;
  value: string;
  /** The digest of the words it translates, as the API gave it. */
  translatableContentDigest: string;
}

/** Translations as the storefront's documents take them: words by language, then field. */
export type TranslatedFields = Partial<Record<string, Partial<Record<TranslationKey, string>>>>;

/** The tables of the kinds whose IDs are paged through in the database. */
const TABLES: Partial<Record<TranslatableKind, string>> = {
  page: 'online_store.pages',
  blog: 'online_store.blogs',
  article: 'online_store.articles',
};

/** The aggregate types of kinds whose names differ from them in events. */
const AGGREGATE_TYPES: Partial<Record<TranslatableKind, string>> = {
  menuItem: 'menu_item',
  shopPolicy: 'shop_policy',
  productOption: 'product_option',
  productOptionValue: 'product_option_value',
};

/** What a kind is called in messages. */
const NAMES: Readonly<Record<TranslatableKind, string>> = {
  product: 'product',
  collection: 'collection',
  page: 'page',
  blog: 'blog',
  article: 'article',
  menu: 'menu',
  menuItem: 'menu item',
  shopPolicy: 'policy',
  productOption: 'product option',
  productOptionValue: 'option value',
};

/** What a kind is called, with "a" or "an" before it. */
function aName(kind: TranslatableKind): string {
  return `${/^[aeiou]/.test(NAMES[kind]) ? 'an' : 'a'} ${NAMES[kind]}`;
}

/** The catalog's name for an option kind's rows. */
const OPTION_ROWS = { productOption: 'option', productOptionValue: 'value' } as const;

function isOptionKind(kind: TranslatableKind): kind is keyof typeof OPTION_ROWS {
  return kind === 'productOption' || kind === 'productOptionValue';
}

/**
 * A shop's own words for its content in another of the storefront's languages (OS-06, ADR-238),
 * as Shopify's translations API keeps them: a product's, collection's, page's, blog's, article's,
 * menu's or menu item's fields, a policy's, and a product option's or option value's name
 * (ADR-241), each in Urdu, written for the shop's own words as they were then. The storefront
 * shows each in its Urdu pages; where the shop gave none, its own.
 */
@Injectable()
export class TranslationService {
  constructor(
    private readonly db: Database,
    private readonly products: ProductService,
    private readonly collections: CollectionService,
    private readonly pageService: PageService,
    private readonly blogService: BlogService,
    private readonly articleService: ArticleService,
    private readonly menus: MenuService,
  ) {}

  /** One resource's fields and their translations; null when the shop has none by the ID. */
  async resource(
    tenant: TenantContext,
    kind: TranslatableKind,
    id: string,
  ): Promise<TranslatableResourceRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const [record] = await this.#records(tx, tenant.shopId, kind, [id]);
      return record ?? null;
    });
  }

  /** The shop's resources of a kind, the newest first. */
  async resources(
    tenant: TenantContext,
    kind: TranslatableKind,
    options: { first: number; after?: string | null },
  ): Promise<Page<TranslatableResourceRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const ids = await this.#idsAfter(
        tx,
        tenant.shopId,
        kind,
        options.after ?? null,
        options.first + 1,
      );
      const items = await this.#records(tx, tenant.shopId, kind, ids.slice(0, options.first));
      return { items, hasNextPage: ids.length > options.first };
    });
  }

  /**
   * Keeps translations of the resource's fields, as Shopify's `translationsRegister`: each for a
   * field with words, naming the digest of those words as the API gave them, so one written for
   * words since changed is refused. One already kept for the field in the language is replaced.
   */
  async register(
    tenant: TenantContext,
    kind: TranslatableKind,
    id: string,
    inputs: readonly TranslationInputValue[],
  ): Promise<MutationResult<TranslationRecord[]>> {
    if (inputs.length === 0)
      return failOne(['translations'], 'BLANK', "Translations can't be blank");
    if (inputs.length > TRANSLATION_LIMITS.perCall) {
      return failOne(
        ['translations'],
        'TOO_MANY',
        `Translations can have at most ${TRANSLATION_LIMITS.perCall} at once`,
      );
    }
    return this.db.tenant(
      tenant.shopId,
      async (tx): Promise<MutationResult<TranslationRecord[]>> => {
        const [content] = (await this.#contents(tx, tenant.shopId, kind, [id])).values();
        if (!content) return failOne(['resourceId'], 'NOT_FOUND', `No such ${NAMES[kind]}`);
        const byKey = new Map(content.map((field) => [field.key, field]));
        const check = new InputChecker();
        const rows: (typeof translations.$inferInsert)[] = [];
        const given = new Set<string>();
        inputs.forEach((input, index) => {
          const at = ['translations', String(index)];
          const key = input.key as TranslationKey;
          if (!isTranslationLocale(input.locale)) {
            check.addMessage(
              [...at, 'locale'],
              'INVALID',
              `Locale ${input.locale.slice(0, 20)} is not one the storefront shows besides the ` +
                `shop's own: ${TRANSLATION_LOCALES.join(', ')}`,
            );
          }
          const own = byKey.get(key);
          if (!TRANSLATABLE_FIELDS[kind].includes(key)) {
            check.addMessage(
              [...at, 'key'],
              'INVALID',
              `Key ${input.key.slice(0, 40)} is not a field of ${aName(kind)} that can be ` +
                `translated: ${TRANSLATABLE_FIELDS[kind].join(', ')}`,
            );
          } else if (!own) {
            check.addMessage(
              [...at, 'key'],
              'INVALID',
              `The ${NAMES[kind]} has no ${input.key} to translate`,
            );
          } else if (input.translatableContentDigest !== own.digest) {
            check.addMessage(
              [...at, 'translatableContentDigest'],
              'STALE',
              `The ${NAMES[kind]}'s ${input.key} has changed since it was read: read it again`,
            );
          }
          const pair = JSON.stringify([input.locale, input.key]);
          if (given.has(pair)) {
            check.addMessage(at, 'INVALID', `${input.key} in ${input.locale} is given twice`);
          }
          given.add(pair);
          if (!own) return;
          const value = checkTranslation(check, [...at, 'value'], kind, key, input.value);
          rows.push({
            shopId: tenant.shopId,
            resourceId: id,
            locale: input.locale,
            key,
            value,
            digest: own.digest,
          });
        });
        if (!check.ok) return fail(check.errors);
        const kept = await tx
          .insert(translations)
          .values(rows)
          .onConflictDoUpdate({
            target: [
              translations.shopId,
              translations.resourceId,
              translations.locale,
              translations.key,
            ],
            set: {
              value: sql`excluded.value`,
              digest: sql`excluded.digest`,
              updatedAt: sql`now()`,
            },
          })
          .returning();
        await this.#changed(tx, tenant.shopId, kind, id, kept);
        await this.#searchable(tx, tenant.shopId, kind, id);
        return {
          ok: true,
          value: kept.map((row) => ({
            key: row.key as TranslationKey,
            value: translationValue(kind, row.key as TranslationKey, row.value),
            locale: row.locale,
            outdated: false,
            updatedAt: row.updatedAt,
          })),
        };
      },
    );
  }

  /**
   * Forgets the resource's translations of `keys` in `locales`, as Shopify's
   * `translationsRemove`: the storefront shows the shop's own words for them again.
   */
  async remove(
    tenant: TenantContext,
    kind: TranslatableKind,
    id: string,
    keys: readonly string[],
    locales: readonly string[],
  ): Promise<MutationResult<TranslationRecord[]>> {
    const check = new InputChecker();
    keys.forEach((key, index) => {
      if (!TRANSLATABLE_FIELDS[kind].includes(key as TranslationKey)) {
        check.addMessage(
          ['translationKeys', String(index)],
          'INVALID',
          `Key ${key.slice(0, 40)} is not a field of ${aName(kind)} that can be translated`,
        );
      }
    });
    locales.forEach((locale, index) => {
      if (!isTranslationLocale(locale)) {
        check.addMessage(
          ['locales', String(index)],
          'INVALID',
          `Locale ${locale.slice(0, 20)} is not one the storefront shows besides the shop's own`,
        );
      }
    });
    if (!check.ok) return fail(check.errors);
    return this.db.tenant(
      tenant.shopId,
      async (tx): Promise<MutationResult<TranslationRecord[]>> => {
        const [content] = (await this.#contents(tx, tenant.shopId, kind, [id])).values();
        if (!content) return failOne(['resourceId'], 'NOT_FOUND', `No such ${NAMES[kind]}`);
        const digests = new Map(content.map((field) => [field.key, field.digest]));
        if (keys.length === 0 || locales.length === 0) return { ok: true, value: [] };
        const removed = await tx
          .delete(translations)
          .where(
            and(
              eq(translations.shopId, tenant.shopId),
              eq(translations.resourceId, id),
              inArray(translations.key, [...keys]),
              inArray(translations.locale, [...locales]),
            ),
          )
          .returning();
        await this.#changed(tx, tenant.shopId, kind, id, removed);
        if (removed.length > 0) await this.#searchable(tx, tenant.shopId, kind, id);
        return {
          ok: true,
          value: removed.map((row) => ({
            key: row.key as TranslationKey,
            value: translationValue(kind, row.key as TranslationKey, row.value),
            locale: row.locale,
            outdated: digests.get(row.key as TranslationKey) !== row.digest,
            updatedAt: row.updatedAt,
          })),
        };
      },
    );
  }

  /** Tells the storefront the resource's translations changed, if any did. */
  async #changed(
    tx: Tx,
    shopId: string,
    kind: TranslatableKind,
    id: string,
    rows: readonly { key: string; locale: string }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    // An option's or value's product, whose document shows it (ADR-241).
    const productId = isOptionKind(kind)
      ? (await this.products.optionNamesOf(tx, shopId, OPTION_ROWS[kind], [id])).get(id)?.productId
      : undefined;
    await appendEvent<TranslationsUpdatedPayload>(tx, shopId, {
      type: OnlineStoreEvents.TranslationsUpdated,
      aggregateType: AGGREGATE_TYPES[kind] ?? kind,
      aggregateId: id,
      payload: {
        kind,
        locales: [...new Set(rows.map((row) => row.locale))].sort(),
        keys: [...new Set(rows.map((row) => row.key))].sort(),
        ...(productId ? { productId } : {}),
      },
    });
  }

  /**
   * Keeps the words of a product's, page's or article's translations for storefronts' search
   * (ADR-240), folded as its own are: a product's titles and types, a page's or an article's
   * titles and text.
   */
  async #searchable(tx: Tx, shopId: string, kind: TranslatableKind, id: string): Promise<void> {
    if (kind !== 'product' && kind !== 'page' && kind !== 'article') return;
    const fields = (await shopTranslationsOf(tx, shopId, [id])).get(id) ?? {};
    const words = Object.values(fields)
      .map((each) =>
        kind === 'product'
          ? searchKey(`${each?.title ?? ''} ${each?.product_type ?? ''}`)
          : contentSearchText(
              each?.title ?? '',
              [],
              each?.summary_html ?? '',
              each?.body_html ?? '',
            ),
      )
      .filter(Boolean)
      .join(' ');
    if (kind === 'product') await this.products.setTranslatedText(tx, shopId, id, words);
    else if (kind === 'page') {
      await tx
        .update(pages)
        .set({ translatedText: words })
        .where(and(eq(pages.shopId, shopId), eq(pages.id, id)));
    } else {
      await tx
        .update(articles)
        .set({ translatedText: words })
        .where(and(eq(articles.shopId, shopId), eq(articles.id, id)));
    }
  }

  /** Resources of a kind by their IDs, in that order, with their fields and translations. */
  async #records(
    tx: Tx,
    shopId: string,
    kind: TranslatableKind,
    ids: readonly string[],
  ): Promise<TranslatableResourceRecord[]> {
    const contents = await this.#contents(tx, shopId, kind, ids);
    const kept = await keptTranslations(tx, shopId, [...contents.keys()]);
    return ids.flatMap((id) => {
      const content = contents.get(id);
      if (!content) return [];
      const digests = new Map(content.map((field) => [field.key, field.digest]));
      return [
        {
          kind,
          id,
          content,
          translations: (kept.get(id) ?? []).map((row) => ({
            key: row.key as TranslationKey,
            value: translationValue(kind, row.key as TranslationKey, row.value),
            locale: row.locale,
            outdated: digests.get(row.key as TranslationKey) !== row.digest,
            updatedAt: row.updatedAt,
          })),
        },
      ];
    });
  }

  /** The fields with words of the shop's resources of a kind among `ids`, by ID. */
  async #contents(
    tx: Tx,
    shopId: string,
    kind: TranslatableKind,
    ids: readonly string[],
  ): Promise<Map<string, TranslatableContentRecord[]>> {
    const sources = new Map<string, TranslatableSource>();
    if (ids.length === 0) return new Map();
    if (kind === 'product') {
      for (const record of await this.products.recordsOf(tx, shopId, ids)) {
        sources.set(record.id, record);
      }
    } else if (kind === 'collection') {
      for (const record of await this.collections.recordsOf(tx, shopId, { ids })) {
        sources.set(record.id, record);
      }
    } else if (kind === 'page') {
      for (const record of await this.pageService.pagesOf(tx, shopId, { ids })) {
        sources.set(record.id, record);
      }
    } else if (kind === 'blog') {
      for (const record of await this.blogService.blogsOf(tx, shopId, { ids })) {
        sources.set(record.id, { title: record.title });
      }
    } else if (kind === 'article') {
      for (const record of await this.articleService.articlesOf(tx, shopId, { ids })) {
        sources.set(record.id, record);
      }
    } else if (kind === 'shopPolicy') {
      const rows = await tx
        .select({ id: policies.id, body: policies.body })
        .from(policies)
        .where(and(eq(policies.shopId, shopId), inArray(policies.id, [...ids])));
      for (const row of rows) sources.set(row.id, { body: row.body });
    } else if (isOptionKind(kind)) {
      const names = await this.products.optionNamesOf(tx, shopId, OPTION_ROWS[kind], ids);
      for (const [id, { name }] of names) sources.set(id, { name });
    } else {
      const wanted = new Set(ids);
      const menus = await this.menus.menusOf(tx, shopId);
      const each = kind === 'menu' ? menus : menus.flatMap((menu) => itemsIn(menu.items));
      for (const record of each) {
        if (wanted.has(record.id)) sources.set(record.id, { title: record.title });
      }
    }
    return new Map([...sources].map(([id, source]) => [id, translatableContent(kind, source)]));
  }

  /** Up to `limit` IDs of the shop's resources of a kind, the newest first, after `after`. */
  async #idsAfter(
    tx: Tx,
    shopId: string,
    kind: TranslatableKind,
    after: string | null,
    limit: number,
  ): Promise<string[]> {
    if (kind === 'product') return this.products.idsOf(tx, shopId, { after, limit });
    if (isOptionKind(kind)) {
      return this.products.optionIdsOf(tx, shopId, OPTION_ROWS[kind], { after, limit });
    }
    const table = TABLES[kind];
    if (table) {
      const { rows } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM ${sql.raw(table)}
         WHERE shop_id = ${shopId} ${after ? sql`AND id < ${after}` : sql``}
         ORDER BY id DESC
         LIMIT ${limit}`);
      return rows.map((row) => row.id);
    }
    let all: string[];
    if (kind === 'collection') {
      all = (await this.collections.recordsOf(tx, shopId)).map((record) => record.id);
    } else if (kind === 'shopPolicy') {
      const rows = await tx
        .select({ id: policies.id })
        .from(policies)
        .where(eq(policies.shopId, shopId));
      all = rows.map((row) => row.id);
    } else {
      const menus = await this.menus.menusOf(tx, shopId);
      all = (kind === 'menu' ? menus : menus.flatMap((menu) => itemsIn(menu.items))).map(
        (record) => record.id,
      );
    }
    // UUIDv7s: their order is when they were made.
    return all
      .sort()
      .reverse()
      .filter((id) => after === null || id < after)
      .slice(0, limit);
  }
}

/** A menu's items at every level. */
function itemsIn(items: readonly MenuItemRecord[]): MenuItemRecord[] {
  return items.flatMap((item) => [item, ...itemsIn(item.items)]);
}

/** The translations kept for `ids`, by resource. */
async function keptTranslations(
  tx: Tx,
  shopId: string,
  ids: readonly string[],
): Promise<Map<string, (typeof translations.$inferSelect)[]>> {
  const byId = new Map<string, (typeof translations.$inferSelect)[]>();
  if (ids.length === 0) return byId;
  const rows = await tx
    .select()
    .from(translations)
    .where(and(eq(translations.shopId, shopId), inArray(translations.resourceId, [...ids])))
    .orderBy(translations.locale, translations.key);
  for (const row of rows) byId.set(row.resourceId, [...(byId.get(row.resourceId) ?? []), row]);
  return byId;
}

/**
 * The translations of `ids`, as the storefront's documents take them (ADR-238): their words as
 * kept, by language and field, a product's or collection's description as text. In the caller's
 * transaction.
 */
export async function shopTranslationsOf(
  tx: Tx,
  shopId: string,
  ids: readonly string[],
): Promise<Map<string, TranslatedFields>> {
  const kept = await keptTranslations(tx, shopId, ids);
  return new Map(
    [...kept].map(([id, rows]) => {
      const fields: TranslatedFields = {};
      for (const row of rows) {
        fields[row.locale] = { ...fields[row.locale], [row.key]: row.value };
      }
      return [id, fields];
    }),
  );
}
