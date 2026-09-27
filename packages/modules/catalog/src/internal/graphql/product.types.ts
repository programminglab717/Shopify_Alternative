import { Money, PageInfo, UserError } from '@hatti/api';
import {
  ArgsType,
  Field,
  GraphQLISODateTime,
  ID,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum ProductStatus {
  ACTIVE = 'ACTIVE',
  ARCHIVED = 'ARCHIVED',
  DRAFT = 'DRAFT',
}

registerEnumType(ProductStatus, {
  name: 'ProductStatus',
  description: 'Whether a product is on sale.',
  valuesMap: {
    ACTIVE: { description: 'On sale in the channels it is published to.' },
    ARCHIVED: { description: 'No longer sold; kept for order history and reports.' },
    DRAFT: { description: 'Being prepared; not on sale.' },
  },
});

@ObjectType({ description: 'A sellable version of a product, such as one size or colour.' })
export class ProductVariant {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field(() => String, { nullable: true })
  sku!: string | null;

  @Field(() => String, { nullable: true })
  barcode!: string | null;

  @Field(() => Money)
  price!: Money;

  @Field(() => Money, {
    nullable: true,
    description: 'Original price, shown struck through when higher than the price.',
  })
  compareAtPrice!: Money | null;

  @Field(() => Int)
  position!: number;
}

@ObjectType()
export class ProductPriceRange {
  @Field(() => Money)
  minVariantPrice!: Money;

  @Field(() => Money)
  maxVariantPrice!: Money;
}

@ObjectType({ description: 'A product in the shop catalog.' })
export class Product {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field({ description: 'Unique, URL-safe name within the shop, e.g. "lawn-3-piece-suit".' })
  handle!: string;

  @Field(() => ProductStatus)
  status!: ProductStatus;

  @Field()
  description!: string;

  @Field(() => String, { nullable: true })
  vendor!: string | null;

  @Field(() => String, { nullable: true })
  productType!: string | null;

  @Field(() => [String])
  tags!: string[];

  @Field(() => [ProductVariant])
  variants!: ProductVariant[];

  @Field(() => ProductPriceRange)
  priceRange!: ProductPriceRange;

  @Field(() => Int, { description: 'Starts at 1 and increases with every change.' })
  version!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class ProductEdge {
  @Field()
  cursor!: string;

  @Field(() => Product)
  node!: Product;
}

@ObjectType()
export class ProductConnection {
  @Field(() => [ProductEdge])
  edges!: ProductEdge[];

  @Field(() => [Product])
  nodes!: Product[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;
}

@ArgsType()
export class ProductsArgs {
  @Field(() => Int, { nullable: true, defaultValue: 50, description: 'Page size, 1 to 250.' })
  first?: number | null;

  @Field(() => String, { nullable: true, description: 'Cursor from a previous page.' })
  after?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Words to find in the title, vendor, type or tags. Matches Roman Urdu spelling variants ' +
      '(kameez, qameez, kamiz) and Urdu written with Arabic or Urdu letters.',
  })
  query?: string | null;
}

@InputType()
export class ProductVariantInput {
  @Field(() => String, { nullable: true, description: 'Defaults to "Default".' })
  title?: string | null;

  @Field(() => String, { nullable: true })
  sku?: string | null;

  @Field(() => String, { nullable: true })
  barcode?: string | null;

  @Field({ description: 'Decimal amount in the shop currency, e.g. "2499" or "2499.50".' })
  price!: string;

  @Field(() => String, { nullable: true })
  compareAtPrice?: string | null;
}

@InputType()
export class ProductCreateInput {
  @Field()
  title!: string;

  @Field(() => String, { nullable: true, description: 'Generated from the title if omitted.' })
  handle?: string | null;

  @Field(() => String, { nullable: true })
  description?: string | null;

  @Field(() => ProductStatus, { nullable: true, description: 'Defaults to DRAFT.' })
  status?: ProductStatus | null;

  @Field(() => String, { nullable: true })
  vendor?: string | null;

  @Field(() => String, { nullable: true })
  productType?: string | null;

  @Field(() => [String], { nullable: true })
  tags?: string[] | null;

  @Field(() => [ProductVariantInput], {
    nullable: true,
    description: 'Up to 100 variants. Defaults to one variant priced at zero.',
  })
  variants?: ProductVariantInput[] | null;
}

@InputType()
export class ProductUpdateInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  handle?: string | null;

  @Field(() => String, { nullable: true })
  description?: string | null;

  @Field(() => ProductStatus, { nullable: true })
  status?: ProductStatus | null;

  @Field(() => String, { nullable: true, description: 'null clears it.' })
  vendor?: string | null;

  @Field(() => String, { nullable: true, description: 'null clears it.' })
  productType?: string | null;

  @Field(() => [String], { nullable: true, description: 'Replaces all tags.' })
  tags?: string[] | null;
}

@ObjectType()
export class ProductCreatePayload {
  @Field(() => Product, { nullable: true })
  product!: Product | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ProductUpdatePayload {
  @Field(() => Product, { nullable: true })
  product!: Product | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
