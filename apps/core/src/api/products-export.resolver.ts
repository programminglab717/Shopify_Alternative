import {
  CurrentTenant,
  RequireScopes,
  badUserInput,
  hasScope,
  type TenantContext,
} from '@hatti/api';
import {
  PRODUCT_EXPORT_LIMITS,
  ProductExportService,
  parseProductSearch,
  type ShopifyVariantStock,
} from '@hatti/catalog/public';
import { InventoryService, sellableQuantity } from '@hatti/inventory/public';
import { Args, Field, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';

@ObjectType({
  description:
    "The shop's products as Shopify's product CSV (CAT-05), which Shopify's import and " +
    'productsImport both take back.',
})
export class ProductsExport {
  @Field({
    description:
      "CSV under Shopify's headings: a product's rows share its handle, a row for each of its " +
      'variants and images, the products oldest first.',
  })
  csv!: string;

  @Field(() => Int)
  productCount!: number;

  @Field(() => Int, { description: 'Rows under the headings, as an import counts them.' })
  rowCount!: number;
}

/**
 * Products to a file (CAT-05, ADR-129): the catalog gives the products and writes Shopify's CSV;
 * the core adds each tracked variant's stock from the inventory module, as an import sets it.
 */
@Resolver()
export class ProductsExportResolver {
  constructor(
    private readonly exports: ProductExportService,
    private readonly inventory: InventoryService,
  ) {}

  @Query(() => ProductsExport, {
    description:
      "The shop's products as Shopify's product CSV, filtered as the products list is, for a " +
      'backup, an edit in a spreadsheet or a move: as much as one import takes, ' +
      `${PRODUCT_EXPORT_LIMITS.rows.toLocaleString('en')} rows and ` +
      `${PRODUCT_EXPORT_LIMITS.csv.toLocaleString('en')} characters, a larger catalog in parts. ` +
      "Each tracked variant's stock, what is for sale online, comes with read_inventory.",
  })
  @RequireScopes('read_products')
  async productsExport(
    @CurrentTenant() tenant: TenantContext,
    @Args('query', {
      type: () => String,
      nullable: true,
      description: 'Searches as `products(query:)` does.',
    })
    query?: string | null,
  ): Promise<ProductsExport> {
    const search = query ?? '';
    const parsed = parseProductSearch(search);
    if (!parsed.ok) throw badUserInput(parsed.error);
    const stock = hasScope(tenant, 'read_inventory')
      ? (variantIds: string[]) => this.#stock(tenant, variantIds)
      : null;
    const result = await this.exports.export(tenant, search, stock);
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    return Object.assign(new ProductsExport(), {
      csv: result.value.csv,
      productCount: result.value.products,
      rowCount: result.value.rows,
    });
  }

  /** Each tracked variant's stock: what is for sale online, and whether it sells on at zero. */
  async #stock(
    tenant: TenantContext,
    variantIds: string[],
  ): Promise<Map<string, ShopifyVariantStock>> {
    const items = await this.inventory.itemsOf(tenant, variantIds);
    const stock = new Map<string, ShopifyVariantStock>();
    for (const [variantId, item] of items) {
      if (!item.tracked) continue;
      stock.set(variantId, {
        quantity: sellableQuantity(item),
        continueSelling: item.inventoryPolicy === 'continue',
      });
    }
    return stock;
  }
}
