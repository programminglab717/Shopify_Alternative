import {
  CurrentTenant,
  RequireScopes,
  UserError,
  badUserInput,
  type TenantContext,
} from '@hatti/api';
import {
  Args,
  Field,
  ID,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from '@nestjs/graphql';
import { ProductLabelService, type LabelPaper } from '../product-labels.js';
import { uuidOf } from './mappers.js';

export enum ProductLabelPaper {
  A4_SHEET = 'A4_SHEET',
  ROLL_50X25 = 'ROLL_50X25',
}

registerEnumType(ProductLabelPaper, {
  name: 'ProductLabelPaper',
  description: 'What products’ labels are printed on.',
  valuesMap: {
    A4_SHEET: { description: 'A sheet of A4 cut into 24 labels of 70×37 mm, three across.' },
    ROLL_50X25: { description: 'A roll of 50×25 mm labels, as label printers take them.' },
  },
});

const PAPERS: Readonly<Record<ProductLabelPaper, LabelPaper>> = {
  A4_SHEET: 'a4',
  ROLL_50X25: 'label_50x25',
};

@InputType()
export class ProductLabelItemInput {
  @Field(() => ID)
  variantId!: string;

  @Field(() => Int, { description: 'Labels of it, from 1.', defaultValue: 1 })
  copies!: number;
}

@ObjectType({ description: 'Labels for products, to print from the browser.' })
export class ProductLabels {
  @Field({ description: 'For the browser tab, such as "24 labels".' })
  title!: string;

  @Field({ description: 'A complete HTML page, laid out for the paper asked for.' })
  html!: string;

  @Field(() => Int)
  labels!: number;
}

@ObjectType()
export class ProductVariantsBarcodesGivePayload {
  @Field(() => Int, { description: 'Variants given barcodes of the shop’s own.' })
  given!: number;

  @Field(() => Int, { description: 'Variants that had barcodes, which they keep.' })
  had!: number;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

/** Products' barcodes and price labels (CAT-22, ADR-757). */
@Resolver()
export class ProductLabelResolver {
  constructor(private readonly labels: ProductLabelService) {}

  @Query(() => ProductLabels, {
    description:
      'Price labels for variants, to stick on what the shop sells (CAT-22, ADR-757): each with ' +
      'its product’s title, its options, its price and what it was where that is more, and its ' +
      'barcode, or its SKU where it has none, as a Code 128 barcode; as many of each as asked, ' +
      'in the order asked, at most 1,000. On a sheet of A4, 24 to a page; on a roll, one to a ' +
      'label.',
  })
  @RequireScopes('read_products')
  async productLabels(
    @CurrentTenant() tenant: TenantContext,
    @Args('items', { type: () => [ProductLabelItemInput] }) items: ProductLabelItemInput[],
    @Args('paper', { type: () => ProductLabelPaper, defaultValue: ProductLabelPaper.A4_SHEET })
    paper: ProductLabelPaper,
  ): Promise<ProductLabels> {
    const result = await this.labels.labels(
      tenant,
      items.map((item) => ({ variantId: uuidOf('variant', item.variantId), copies: item.copies })),
      PAPERS[paper],
    );
    if (!result.ok) throw badUserInput(result.errors[0]!.message);
    return Object.assign(new ProductLabels(), result.value);
  }

  @Mutation(() => ProductVariantsBarcodesGivePayload, {
    description:
      'Gives each variant of these products without a barcode one of the shop’s own (CAT-22, ' +
      'ADR-757): an EAN-13 starting 2, which GS1 keeps for numbers used within a business, none ' +
      'the same as another of the shop’s; variants with barcodes keep theirs. At most 250 ' +
      'products at once.',
  })
  @RequireScopes('write_products')
  async productVariantsBarcodesGive(
    @CurrentTenant() tenant: TenantContext,
    @Args('productIds', { type: () => [ID] }) productIds: string[],
  ): Promise<ProductVariantsBarcodesGivePayload> {
    const result = await this.labels.giveBarcodes(
      tenant,
      productIds.map((id) => uuidOf('product', id)),
    );
    return Object.assign(new ProductVariantsBarcodesGivePayload(), {
      given: result.ok ? result.value.given : 0,
      had: result.ok ? result.value.had : 0,
      userErrors: result.ok ? [] : UserError.list(result.errors),
    });
  }
}
