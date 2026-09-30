import { CurrentTenant, RequireScopes, UserError, type TenantContext } from '@hatti/api';
import { ProductImportService, type ImportedStock } from '@hatti/catalog/public';
import { InventoryService, LocationService } from '@hatti/inventory/public';
import { Args, Field, Int, Mutation, ObjectType, Resolver } from '@nestjs/graphql';

/** Variants given their stock in one change, as `inventorySetQuantities` takes them. */
const STOCK_BATCH = 250;

/** Where stock set by an import says it came from, in the stock history. */
const IMPORT_REFERENCE = 'hatti://imports/shopify-products';

@ObjectType({ description: "A row of an import's file that did not go in as it was, and why." })
export class ProductImportRowError {
  @Field(() => Int, { description: 'Its row in the file, the headings being row 1.' })
  row!: number;

  @Field(() => String, {
    nullable: true,
    description: "The column's heading in the file; null for the row as a whole.",
  })
  column!: string | null;

  @Field()
  message!: string;
}

@ObjectType()
export class ProductsImportPayload {
  @Field(() => Int, { description: 'Rows under the headings.' })
  rows!: number;

  @Field(() => Int, { description: 'Products made, or that would be in a dry run.' })
  created!: number;

  @Field(() => Int)
  variants!: number;

  @Field(() => Int, { description: 'Images added by their addresses.' })
  images!: number;

  @Field(() => Int, {
    description: 'Products left as they are: the shop has products with their handles already.',
  })
  skipped!: number;

  @Field(() => Int, {
    description: 'Variants given the stock Shopify tracked for them, at the primary location.',
  })
  stocked!: number;

  @Field(() => [ProductImportRowError], { description: 'The first 100, in the order of the file.' })
  rowErrors!: ProductImportRowError[];

  @Field(() => Int)
  rowErrorCount!: number;

  @Field()
  dryRun!: boolean;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/**
 * Products from a Shopify store's product export (ONB-05). The catalog makes the products and
 * their images; the core then gives them the stock Shopify tracked, through the inventory module,
 * which the catalog cannot reach.
 */
@Resolver()
export class ProductsImportResolver {
  constructor(
    private readonly imports: ProductImportService,
    private readonly inventory: InventoryService,
    private readonly locations: LocationService,
  ) {}

  @Mutation(() => ProductsImportPayload, {
    description:
      'Imports products from a Shopify product export, as CSV: rows grouped by Handle into ' +
      'products with their options, variants, prices, SKUs, weights, tags, status and images ' +
      '(by address, https only), each keeping its handle, and the stock Shopify tracked at the ' +
      'primary location. Products whose handles the shop has are left as they are. dryRun ' +
      'checks the file and counts, changing nothing.',
  })
  @RequireScopes('write_products', 'write_inventory')
  async productsImport(
    @CurrentTenant() tenant: TenantContext,
    @Args('csv', { description: "The file's text, at most 1,500,000 characters." }) csv: string,
    @Args('dryRun', { nullable: true }) dryRun?: boolean,
  ): Promise<ProductsImportPayload> {
    const result = await this.imports.import(tenant, csv, { dryRun: dryRun ?? false });
    if (!result.ok) {
      return Object.assign(new ProductsImportPayload(), {
        rows: 0,
        created: 0,
        variants: 0,
        images: 0,
        skipped: 0,
        stocked: 0,
        rowErrors: [],
        rowErrorCount: 0,
        dryRun: dryRun ?? false,
        userErrors: UserError.list(result.errors),
      });
    }
    const { stock, rowErrors, rowErrorCount, ...counts } = result.value;
    const stockErrors = await this.#stock(tenant, stock);
    const errors = [...rowErrors, ...stockErrors].sort((a, b) => a.row - b.row);
    return Object.assign(new ProductsImportPayload(), {
      ...counts,
      stocked: stock.length - stockErrors.length,
      rowErrors: errors
        .slice(0, 100)
        .map((error) => Object.assign(new ProductImportRowError(), error)),
      rowErrorCount: rowErrorCount + stockErrors.length,
      userErrors: [],
    });
  }

  /**
   * Sets the stock Shopify tracked, on hand at the primary location, a batch at a time; and
   * keeps selling what Shopify sold when out of stock. What could not be set, by its row.
   */
  async #stock(
    tenant: TenantContext,
    stock: ImportedStock[],
  ): Promise<{ row: number; column: string; message: string }[]> {
    if (stock.length === 0) return [];
    const location = await this.locations.primary(tenant);
    const errors: { row: number; column: string; message: string }[] = [];
    for (let start = 0; start < stock.length; start += STOCK_BATCH) {
      const batch = stock.slice(start, start + STOCK_BATCH);
      const set = await this.inventory.setQuantities(tenant, {
        name: 'on_hand',
        reason: 'correction',
        referenceDocumentUri: IMPORT_REFERENCE,
        quantities: batch.map((entry) => ({
          inventoryItemId: entry.variantId,
          locationId: location.id,
          quantity: entry.quantity,
        })),
      });
      if (!set.ok) {
        const message = set.errors[0]?.message ?? 'Stock could not be set';
        errors.push(
          ...batch.map((entry) => ({ row: entry.row, column: 'Variant Inventory Qty', message })),
        );
        continue;
      }
      for (const entry of batch.filter((each) => each.continueSelling)) {
        await this.inventory.updateItem(tenant, entry.variantId, { inventoryPolicy: 'continue' });
      }
    }
    return errors;
  }
}
