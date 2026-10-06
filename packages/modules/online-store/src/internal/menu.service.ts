import {
  InputChecker,
  fail,
  failOne,
  type FieldError,
  type MutationResult,
  type TenantContext,
} from '@hatti/api';
import { CollectionService, ProductService } from '@hatti/catalog/public';
import { Database, type Tx } from '@hatti/db';
import { appendEvent } from '@hatti/events';
import { newId } from '@hatti/ids';
import { Injectable } from '@nestjs/common';
import { and, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { OnlineStoreEvents, type MenuChangedPayload } from './events.js';
import {
  DEFAULT_MENUS,
  MENU_HANDLE,
  MENU_LIMITS,
  allItems,
  checkMenuItems,
  defaultMenuItems,
  type MenuItemInput,
} from './menu-items.js';
import type { MenuItemRecord, MenuItemValue, MenuRecord, Page } from './records.js';
import { articles, blogs, menus, pages, type MenuRow } from './schema.js';

export interface MenuInput {
  title: string;
  /** Required for a new menu; left as it is when not given on an update. */
  handle?: string | null;
  /** All of the menu's items: those not given go. */
  items: readonly MenuItemInput[];
}

/**
 * A shop's menus (ADR-040): links to its home page, all its products, a collection, a product, a
 * page (ADR-045) or an address, three levels deep. Every shop has a main menu and a footer menu, made the first time
 * it looks at its menus from what its storefront showed until then; until then its storefront's
 * follow its collections. A menu's items are saved whole, as Shopify's `menuUpdate` does.
 */
@Injectable()
export class MenuService {
  constructor(
    private readonly db: Database,
    private readonly collections: CollectionService,
    private readonly products: ProductService,
  ) {}

  /** The shop's menus: the main menu, the footer menu, then the others by title. */
  async list(
    tenant: TenantContext,
    options: { first: number; after?: string | null },
  ): Promise<Page<MenuRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      await this.#ensureDefaults(tx, tenant.shopId);
      const rows = await tx
        .select()
        .from(menus)
        .where(eq(menus.shopId, tenant.shopId))
        .orderBy(
          sql`${menus.handle} = 'main-menu' DESC`,
          sql`${menus.isDefault} DESC`,
          sql`lower(${menus.title})`,
          menus.id,
        );
      const start = options.after ? rows.findIndex((row) => row.id === options.after) + 1 : 0;
      const page = rows.slice(start, start + options.first);
      return {
        items: await this.#records(tx, tenant.shopId, page),
        hasNextPage: rows.length > start + page.length,
      };
    });
  }

  async get(tenant: TenantContext, id: string): Promise<MenuRecord | null> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const row = await this.#find(tx, tenant.shopId, id);
      return row ? (await this.#records(tx, tenant.shopId, [row]))[0]! : null;
    });
  }

  async create(tenant: TenantContext, input: MenuInput): Promise<MutationResult<MenuRecord>> {
    const check = new InputChecker();
    const title = check.text(['title'], input.title, { required: true, max: MENU_LIMITS.title });
    const handle = checkHandle(check, input.handle);
    const items = checkMenuItems(check, input.items, new Set());
    if (!check.ok || title === null) return fail(check.errors);
    return this.db.tenant(tenant.shopId, async (tx) => {
      await this.#ensureDefaults(tx, tenant.shopId);
      const [counts] = await tx
        .select({ total: count() })
        .from(menus)
        .where(eq(menus.shopId, tenant.shopId));
      if ((counts?.total ?? 0) >= MENU_LIMITS.menus) {
        return failOne([], 'TOO_MANY', `A shop can keep at most ${MENU_LIMITS.menus} menus`);
      }
      const missing = await this.#missing(tx, tenant.shopId, items);
      if (missing.length > 0) return fail(missing);
      const [row] = await tx
        .insert(menus)
        .values({ shopId: tenant.shopId, id: newId(), handle, title, items })
        .onConflictDoNothing()
        .returning();
      if (!row) return failOne(['handle'], 'TAKEN', `Handle "${handle}" is another menu's`);
      await this.#recordEvent(tx, OnlineStoreEvents.MenuCreated, row);
      return { ok: true, value: (await this.#records(tx, tenant.shopId, [row]))[0]! };
    });
  }

  /** Changes a menu's title, handle and items; the items given replace all of its items. */
  async update(
    tenant: TenantContext,
    id: string,
    input: MenuInput,
  ): Promise<MutationResult<MenuRecord>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const menu = await this.#find(tx, tenant.shopId, id, { lock: true });
      if (!menu) return failOne(['id'], 'NOT_FOUND', 'Menu not found');
      const check = new InputChecker();
      const title = check.text(['title'], input.title, { required: true, max: MENU_LIMITS.title });
      const handle =
        input.handle === undefined || input.handle === null
          ? menu.handle
          : checkHandle(check, input.handle);
      if (menu.isDefault && handle !== menu.handle) {
        check.addMessage(['handle'], 'INVALID', `This menu keeps its handle, ${menu.handle}`);
      }
      const known = new Set(allItems(menu.items).map((item) => item.id));
      const items = checkMenuItems(check, input.items, known);
      if (!check.ok || title === null) return fail(check.errors);
      if (handle !== menu.handle) {
        const [taken] = await tx
          .select({ id: menus.id })
          .from(menus)
          .where(and(eq(menus.shopId, tenant.shopId), eq(menus.handle, handle), ne(menus.id, id)));
        if (taken) return failOne(['handle'], 'TAKEN', `Handle "${handle}" is another menu's`);
      }
      const missing = await this.#missing(tx, tenant.shopId, items);
      if (missing.length > 0) return fail(missing);
      const [row] = await tx
        .update(menus)
        .set({ title, handle, items, updatedAt: sql`now()` })
        .where(and(eq(menus.shopId, tenant.shopId), eq(menus.id, id)))
        .returning();
      await this.#recordEvent(tx, OnlineStoreEvents.MenuUpdated, row!);
      return { ok: true, value: (await this.#records(tx, tenant.shopId, [row!]))[0]! };
    });
  }

  /** Deletes a menu other than the main and footer menus, which every shop has. */
  async delete(tenant: TenantContext, id: string): Promise<MutationResult<{ id: string }>> {
    return this.db.tenant(tenant.shopId, async (tx) => {
      const menu = await this.#find(tx, tenant.shopId, id, { lock: true });
      if (!menu) return failOne(['id'], 'NOT_FOUND', 'Menu not found');
      if (menu.isDefault) {
        return failOne(
          ['id'],
          'INVALID',
          `Every shop has a ${menu.handle} menu: it can't be deleted`,
        );
      }
      await tx.delete(menus).where(and(eq(menus.shopId, tenant.shopId), eq(menus.id, id)));
      await this.#recordEvent(tx, OnlineStoreEvents.MenuDeleted, menu);
      return { ok: true, value: { id } };
    });
  }

  /**
   * The shop's menus with where their items lead, in the caller's transaction `tx`: for read
   * models built outside the module, such as the storefront's. A shop that never looked at its
   * menus has the default ones, made from its collections as they are now.
   */
  async menusOf(tx: Tx, shopId: string): Promise<MenuRecord[]> {
    const rows = await tx
      .select()
      .from(menus)
      .where(eq(menus.shopId, shopId))
      .orderBy(menus.handle);
    return this.#records(tx, shopId, rows.length > 0 ? rows : await this.#defaults(tx, shopId));
  }

  /** Makes the main and footer menus, as the storefront showed them, if the shop has not. */
  async #ensureDefaults(tx: Tx, shopId: string): Promise<void> {
    const present = await tx
      .select({ handle: menus.handle })
      .from(menus)
      .where(and(eq(menus.shopId, shopId), eq(menus.isDefault, true)));
    if (present.length === DEFAULT_MENUS.length) return;
    const have = new Set(present.map((row) => row.handle));
    for (const menu of await this.#defaults(tx, shopId)) {
      if (have.has(menu.handle)) continue;
      // Safe to race: the unique handle decides.
      const [row] = await tx.insert(menus).values(menu).onConflictDoNothing().returning();
      if (row) await this.#recordEvent(tx, OnlineStoreEvents.MenuCreated, row);
    }
  }

  /** The main and footer menus a shop has before it changes them, not yet kept. */
  async #defaults(tx: Tx, shopId: string): Promise<MenuRow[]> {
    const items = defaultMenuItems(await this.collections.recordsOf(tx, shopId));
    const now = new Date();
    return DEFAULT_MENUS.map(({ handle, title }) => ({
      shopId,
      id: newId(),
      handle,
      title,
      isDefault: true,
      items: items[handle],
      createdAt: now,
      updatedAt: now,
    }));
  }

  /** Menus with where each item leads now, reading the collections and products they name. */
  async #records(tx: Tx, shopId: string, rows: readonly MenuRow[]): Promise<MenuRecord[]> {
    const items = rows.flatMap((row) => allItems(row.items));
    const named = (type: string) => [
      ...new Set(items.filter((item) => item.type === type).map((item) => item.resourceId!)),
    ];
    const [collectionIds, productIds, pageIds, blogIds, articleIds] = [
      named('collection'),
      named('product'),
      named('page'),
      named('blog'),
      named('article'),
    ];
    const collections = new Map(
      (collectionIds.length > 0
        ? await this.collections.recordsOf(tx, shopId, { ids: collectionIds })
        : []
      ).map((collection) => [collection.id, collection.handle]),
    );
    const products = new Map(
      (productIds.length > 0 ? await this.products.recordsOf(tx, shopId, productIds) : []).map(
        (product) => [product.id, product],
      ),
    );
    const linkedPages = new Map(
      (pageIds.length > 0
        ? await tx
            .select({ id: pages.id, handle: pages.handle, publishedAt: pages.publishedAt })
            .from(pages)
            .where(and(eq(pages.shopId, shopId), inArray(pages.id, pageIds)))
        : []
      ).map((page) => [page.id, page]),
    );
    // An article's address has its blog's handle.
    const linkedArticles = new Map(
      (articleIds.length > 0
        ? await tx
            .select({
              id: articles.id,
              handle: articles.handle,
              blogHandle: blogs.handle,
              publishedAt: articles.publishedAt,
            })
            .from(articles)
            .innerJoin(blogs, and(eq(blogs.shopId, articles.shopId), eq(blogs.id, articles.blogId)))
            .where(and(eq(articles.shopId, shopId), inArray(articles.id, articleIds)))
        : []
      ).map((article) => [article.id, article]),
    );
    const linkedBlogs = new Map(
      (blogIds.length > 0
        ? await tx
            .select({ id: blogs.id, handle: blogs.handle })
            .from(blogs)
            .where(and(eq(blogs.shopId, shopId), inArray(blogs.id, blogIds)))
        : []
      ).map((blog) => [blog.id, blog.handle]),
    );
    const resolve = (item: MenuItemValue): MenuItemRecord => {
      const where = (): { url: string | null; shown: boolean } => {
        switch (item.type) {
          case 'frontpage':
            return { url: '/', shown: true };
          case 'catalog':
            return { url: '/collections/all', shown: true };
          case 'collection': {
            const handle = collections.get(item.resourceId!);
            return handle ? { url: `/collections/${handle}`, shown: true } : GONE;
          }
          case 'product': {
            const product = products.get(item.resourceId!);
            if (!product) return GONE;
            return { url: `/products/${product.handle}`, shown: product.status === 'active' };
          }
          case 'page': {
            const page = linkedPages.get(item.resourceId!);
            if (!page) return GONE;
            return { url: `/pages/${page.handle}`, shown: page.publishedAt !== null };
          }
          case 'blog': {
            const handle = linkedBlogs.get(item.resourceId!);
            return handle ? { url: `/blogs/${handle}`, shown: true } : GONE;
          }
          case 'article': {
            const article = linkedArticles.get(item.resourceId!);
            if (!article) return GONE;
            return {
              url: `/blogs/${article.blogHandle}/${article.handle}`,
              // Published, and its time come (ADR-215).
              shown: article.publishedAt !== null && article.publishedAt.getTime() <= Date.now(),
            };
          }
          case 'http':
            return { url: item.url, shown: true };
        }
      };
      return { ...item, ...where(), items: item.items.map(resolve) };
    };
    return rows.map((row) => ({
      id: row.id,
      handle: row.handle,
      title: row.title,
      isDefault: row.isDefault,
      items: row.items.map(resolve),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  /** Errors for links to collections, products, pages, blogs or articles the shop does not have. */
  async #missing(tx: Tx, shopId: string, items: MenuItemValue[]): Promise<FieldError[]> {
    const linked = allItems(items).filter((item) => item.resourceId);
    if (linked.length === 0) return [];
    const [record] = await this.#records(tx, shopId, [
      {
        shopId,
        id: '',
        handle: '',
        title: '',
        isDefault: false,
        items,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const errors: FieldError[] = [];
    const walk = (level: readonly MenuItemRecord[], field: string[]) =>
      level.forEach((item, index) => {
        const at = [...field, String(index)];
        if (item.resourceId && item.url === null) {
          const kind = {
            collection: 'Collection',
            product: 'Product',
            page: 'Page',
            blog: 'Blog',
            article: 'Article',
          }[item.type as 'collection' | 'product' | 'page' | 'blog' | 'article'];
          errors.push({
            field: [...at, 'resourceId'],
            code: 'NOT_FOUND',
            message: `${kind} not found`,
          });
        }
        walk(item.items, [...at, 'items']);
      });
    walk(record!.items, ['items']);
    return errors;
  }

  async #recordEvent(tx: Tx, type: string, row: MenuRow): Promise<void> {
    await appendEvent<MenuChangedPayload>(tx, row.shopId, {
      type,
      aggregateType: 'menu',
      aggregateId: row.id,
      payload: { handle: row.handle },
    });
  }

  async #find(
    tx: Tx,
    shopId: string,
    id: string,
    options: { lock?: boolean } = {},
  ): Promise<MenuRow | undefined> {
    const query = tx
      .select()
      .from(menus)
      .where(and(eq(menus.shopId, shopId), eq(menus.id, id)));
    const [row] = options.lock ? await query.for('update') : await query;
    return row;
  }
}

const GONE = { url: null, shown: false };

/** A menu's handle, checked; blank reads as an error. */
function checkHandle(check: InputChecker, handle: string | null | undefined): string {
  const value = handle?.trim() ?? '';
  if (value === '') check.add(['handle'], 'BLANK', "can't be blank");
  else if (!MENU_HANDLE.test(value)) {
    check.add(
      ['handle'],
      'INVALID',
      'may have only lower-case letters, digits and hyphens, and starts and ends with a letter ' +
        'or digit (at most 100)',
    );
  }
  return value;
}
