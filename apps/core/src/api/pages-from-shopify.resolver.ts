import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { PageService } from '@hatti/online-store/public';
import { readStorePages } from '@hatti/shopify-admin';
import { Args, Field, Int, Mutation, ObjectType, Resolver } from '@nestjs/graphql';
import { ShopifyStores, storeGiven, storeRefusalOf } from './shopify-stores.js';

/** The shop's pages read at a time, for the handles it has. */
const PAGE_BATCH = 250;

@ObjectType({ description: "A store's page that did not go in, and why." })
export class StorePageImportError {
  @Field({ description: "The page's handle at the store." })
  handle!: string;

  @Field()
  message!: string;
}

@ObjectType()
export class PagesImportFromShopifyPayload {
  @Field(() => Int, { description: 'Pages the store has.' })
  pages!: number;

  @Field(() => Int, { description: 'Pages made, or that would be in a dry run.' })
  created!: number;

  @Field(() => Int, {
    description: 'Pages left as they are: the shop has a page with their handles already.',
  })
  skipped!: number;

  @Field(() => [StorePageImportError])
  pageErrors!: StorePageImportError[];

  @Field()
  dryRun!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * A Shopify store's own pages through its Admin API (ONB-05, ADR-752): each made as `pageCreate`
 * makes one, keeping its handle and so its address, its body cleaned as any page's is.
 */
@Resolver()
export class PagesFromShopifyResolver {
  constructor(
    private readonly pages: PageService,
    private readonly shopify: ShopifyStores,
  ) {}

  @Mutation(() => PagesImportFromShopifyPayload, {
    description:
      "Imports a Shopify store's own pages through its Admin API (ONB-05, ADR-752), such as About " +
      'us and Contact, each keeping its handle and so its address at /pages/{handle}: its title, ' +
      'body, whether it is shown and since when, and its template. Give the store and its app as ' +
      'productsImportFromShopify takes them; the app needs the read_online_store_pages access ' +
      'scope. Pages whose handles the shop has are left as they are. Nothing given is kept. ' +
      'dryRun reads the store and counts, changing nothing.',
  })
  @RequireScopes('write_online_store_pages')
  async pagesImportFromShopify(
    @CurrentTenant() tenant: TenantContext,
    @Args('store', {
      description:
        "The store's address at Shopify, as zari.myshopify.com, its name, or a link to its admin.",
    })
    store: string,
    @Args('accessToken', { nullable: true }) accessToken?: string,
    @Args('clientId', { nullable: true }) clientId?: string,
    @Args('clientSecret', { nullable: true }) clientSecret?: string,
    @Args('dryRun', { nullable: true }) dryRun?: boolean,
  ): Promise<PagesImportFromShopifyPayload> {
    const dry = dryRun ?? false;
    const payload = (values: Partial<PagesImportFromShopifyPayload>) =>
      Object.assign(new PagesImportFromShopifyPayload(), {
        pages: 0,
        created: 0,
        skipped: 0,
        pageErrors: [],
        dryRun: dry,
        userErrors: [],
        ...values,
      });
    const refused = (refusal: { field: string[] | null; code: string; message: string }) =>
      payload({ userErrors: [UserError.of(refusal.field, refusal.code, refusal.message)] });

    const given = storeGiven(store, accessToken, clientId, clientSecret);
    if (!given.ok) return refused(given);
    const read = await readStorePages(
      this.shopify.connect(given.shop, given.credentials),
      this.shopify.bulk,
    );
    if (!read.ok) return refused(storeRefusalOf(read));
    const storePages = read.value.pages;
    if (storePages.length === 0) {
      return refused({
        field: ['store'],
        code: 'BLANK',
        message: `${read.value.storeName} has no pages`,
      });
    }

    const handles = await this.#handles(tenant);
    let created = 0;
    let skipped = 0;
    const pageErrors: StorePageImportError[] = [];
    for (const page of storePages) {
      if (handles.has(page.handle)) {
        skipped++;
        continue;
      }
      if (dry) {
        created++;
        continue;
      }
      const made = await this.pages.create(tenant, {
        title: page.title,
        handle: page.handle,
        body: page.body,
        isPublished: page.isPublished,
        // Shown since when the store showed it.
        ...(page.isPublished && page.publishedAt && { publishDate: new Date(page.publishedAt) }),
        templateSuffix: page.templateSuffix,
      });
      if (made.ok) {
        created++;
        handles.add(page.handle);
      } else if (made.errors.some((error) => error.code === 'TAKEN')) {
        skipped++;
      } else {
        pageErrors.push(
          Object.assign(new StorePageImportError(), {
            handle: page.handle,
            message: made.errors.map((error) => error.message).join('; '),
          }),
        );
      }
    }
    return payload({ pages: storePages.length, created, skipped, pageErrors });
  }

  /** The handles of the shop's pages. */
  async #handles(tenant: TenantContext): Promise<Set<string>> {
    const handles = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const page = await this.pages.list(tenant, { first: PAGE_BATCH, after });
      for (const each of page.items) handles.add(each.handle);
      if (!page.hasNextPage || page.items.length === 0) return handles;
      after = page.items.at(-1)!.id;
    }
  }
}
