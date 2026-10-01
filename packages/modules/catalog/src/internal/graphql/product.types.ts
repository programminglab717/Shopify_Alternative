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

export enum MediaStatus {
  UPLOADED = 'UPLOADED',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  FAILED = 'FAILED',
}

registerEnumType(MediaStatus, {
  name: 'MediaStatus',
  description: 'Where a media file is in processing.',
  valuesMap: {
    UPLOADED: { description: 'Recorded; not yet fetched from its source.' },
    PROCESSING: { description: 'Being fetched, checked and resized.' },
    READY: { description: 'Ready to show.' },
    FAILED: { description: 'Could not be fetched or read.' },
  },
});

export enum MediaContentType {
  IMAGE = 'IMAGE',
}

registerEnumType(MediaContentType, { name: 'MediaContentType' });

export enum ProductVariantsStrategy {
  LEAVE_AS_IS = 'LEAVE_AS_IS',
  CREATE = 'CREATE',
}

registerEnumType(ProductVariantsStrategy, {
  name: 'ProductOptionCreateVariantStrategy',
  description: 'What happens to variants when options are added.',
  valuesMap: {
    LEAVE_AS_IS: { description: "Existing variants take each new option's first value." },
    CREATE: {
      description: 'Also add a variant for every missing combination, priced like the first.',
    },
  },
});

@ObjectType({ description: 'A value of a product option, such as "M" for Size.' })
export class ProductOptionValue {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field({ description: 'Whether any variant has this value.' })
  hasVariants!: boolean;
}

@ObjectType({ description: 'A way the variants of a product differ, such as Size or Colour.' })
export class ProductOption {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => Int, { description: '1 to 3.' })
  position!: number;

  @Field(() => [ProductOptionValue])
  optionValues!: ProductOptionValue[];
}

@ObjectType({ description: "A variant's value for one option." })
export class SelectedOption {
  @Field({ description: 'The option, e.g. "Size".' })
  name!: string;

  @Field({ description: 'The value, e.g. "M".' })
  value!: string;
}

@ObjectType({ description: 'An image of a product.' })
export class ProductMedia {
  @Field(() => ID)
  id!: string;

  @Field(() => MediaContentType)
  mediaContentType!: MediaContentType;

  @Field({ description: 'Alternative text, for screen readers and search engines.' })
  alt!: string;

  @Field(() => Int)
  position!: number;

  @Field(() => MediaStatus)
  status!: MediaStatus;

  @Field({ description: 'Where the file was fetched from.' })
  sourceUrl!: string;

  @Field(() => Int, { nullable: true })
  width!: number | null;

  @Field(() => Int, { nullable: true })
  height!: number | null;
}

@ObjectType({ description: 'A sellable version of a product, such as one size or colour.' })
export class ProductVariant {
  @Field(() => ID)
  id!: string;

  @Field({ description: 'The option values, e.g. "M / Maroon"; "Default Title" without options.' })
  title!: string;

  @Field(() => [SelectedOption])
  selectedOptions!: SelectedOption[];

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

  @Field(() => Money, { nullable: true, description: 'What one unit costs the shop, for profit.' })
  cost!: Money | null;

  @Field(() => Int, { nullable: true, description: 'Shipping weight in grams.' })
  weightGrams!: number | null;

  @Field({
    description:
      "Whether its price includes the shop's sales tax, as Shopify's \"Charge tax on this " +
      'variant": orders keep what of it was tax. True unless set otherwise.',
  })
  taxable!: boolean;

  @Field(() => String, {
    nullable: true,
    description:
      "Shopify's tax code: one of the shop's tax categories' codes, whose rate its price's tax " +
      "is at instead of the shop's; null for the shop's own.",
  })
  taxCode!: string | null;

  @Field(() => Int)
  position!: number;

  @Field(() => ProductMedia, { nullable: true, description: 'The image shown for this variant.' })
  media!: ProductMedia | null;
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

  @Field(() => [ProductOption])
  options!: ProductOption[];

  @Field(() => [ProductVariant])
  variants!: ProductVariant[];

  @Field(() => [ProductMedia], { description: 'Images, in order.' })
  media!: ProductMedia[];

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
export class PageArgs {
  @Field(() => Int, { nullable: true, defaultValue: 50, description: 'Page size, 1 to 250.' })
  first?: number | null;

  @Field(() => String, { nullable: true, description: 'Cursor from a previous page.' })
  after?: string | null;
}

@ArgsType()
export class ProductsArgs extends PageArgs {
  @Field(() => String, {
    nullable: true,
    description:
      'Words to find in the title, vendor, type or tags, matching Roman Urdu spelling variants ' +
      '(kameez, qameez, kamiz) and Urdu written with Arabic or Urdu letters; with filters among ' +
      "them, as Shopify's search syntax writes them: `status:draft`, `vendor:Khaadi`, " +
      '`product_type:"Unstitched suit"`, `tag:eid`, `sku:KRT-001`, or `-tag:sale` for the ' +
      'products a filter does not match. Filters are status (active, draft or archived), vendor, ' +
      'product_type, tag, sku and barcode of any variant, and handle, each matched in any letter ' +
      'case; any other is refused.',
  })
  query?: string | null;
}

@InputType({ description: 'An option and its values, e.g. Size with S, M and L.' })
export class ProductOptionInput {
  @Field()
  name!: string;

  @Field(() => [String])
  values!: string[];
}

@InputType()
export class ProductVariantInput {
  @Field(() => [String], {
    nullable: true,
    description: 'One value per option, in option order, e.g. ["M", "Maroon"].',
  })
  optionValues?: string[] | null;

  @Field({ description: 'Decimal amount in the shop currency, e.g. "2499" or "2499.50".' })
  price!: string;

  @Field(() => String, { nullable: true })
  compareAtPrice?: string | null;

  @Field(() => String, { nullable: true })
  cost?: string | null;

  @Field(() => String, { nullable: true })
  sku?: string | null;

  @Field(() => String, { nullable: true })
  barcode?: string | null;

  @Field(() => Int, { nullable: true })
  weightGrams?: number | null;

  @Field(() => Boolean, {
    nullable: true,
    description: "Whether its price includes the shop's sales tax; true unless false.",
  })
  taxable?: boolean | null;

  @Field(() => String, {
    nullable: true,
    description: "One of the shop's tax categories' codes, such as REDUCED; null for none.",
  })
  taxCode?: string | null;
}

@InputType()
export class ProductVariantsBulkInput extends ProductVariantInput {
  @Field(() => ID, { nullable: true, description: 'One of the product media, shown for it.' })
  mediaId?: string | null;
}

@InputType({ description: 'Omitted fields stay as they are; null clears optional ones.' })
export class ProductVariantsBulkUpdateInput {
  @Field(() => ID)
  id!: string;

  @Field(() => [String], { nullable: true })
  optionValues?: string[] | null;

  @Field(() => String, { nullable: true })
  price?: string | null;

  @Field(() => String, { nullable: true })
  compareAtPrice?: string | null;

  @Field(() => String, { nullable: true })
  cost?: string | null;

  @Field(() => String, { nullable: true })
  sku?: string | null;

  @Field(() => String, { nullable: true })
  barcode?: string | null;

  @Field(() => Int, { nullable: true })
  weightGrams?: number | null;

  @Field(() => Boolean, { nullable: true, description: 'Whether its price includes sales tax.' })
  taxable?: boolean | null;

  @Field(() => String, {
    nullable: true,
    description: "One of the shop's tax categories' codes; null or blank clears it.",
  })
  taxCode?: string | null;

  @Field(() => ID, { nullable: true })
  mediaId?: string | null;
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

  @Field(() => [ProductOptionInput], { nullable: true, description: 'Up to 3.' })
  options?: ProductOptionInput[] | null;

  @Field(() => [ProductVariantInput], {
    nullable: true,
    description:
      'Up to 250. Defaults to every combination of the options, or to one variant without ' +
      'options, priced at zero.',
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

  @Field(() => Boolean, {
    nullable: true,
    description:
      "With a new handle, whether the product's old address sends shoppers to its new one: a URL " +
      'redirect is made, as on Shopify. False unless given.',
  })
  redirectNewHandle?: boolean | null;
}

@InputType()
export class ProductDeleteInput {
  @Field(() => ID)
  id!: string;
}

@InputType()
export class ProductOptionUpdateInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name?: string | null;

  @Field(() => Int, { nullable: true, description: 'Moves the option; variants follow.' })
  position?: number | null;
}

@InputType()
export class ProductOptionValueUpdateInput {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;
}

@InputType()
export class CreateMediaInput {
  @Field({ description: 'An https URL to fetch the image from.' })
  originalSource!: string;

  @Field(() => String, { nullable: true })
  alt?: string | null;

  @Field(() => MediaContentType, { nullable: true, defaultValue: MediaContentType.IMAGE })
  mediaContentType?: MediaContentType | null;
}

@InputType()
export class UpdateMediaInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  alt?: string | null;
}

@InputType({ description: 'Moves an item to a new position; 1 is first.' })
export class MoveInput {
  @Field(() => ID)
  id!: string;

  @Field(() => Int)
  newPosition!: number;
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

@ObjectType()
export class ProductDeletePayload {
  @Field(() => ID, { nullable: true })
  deletedProductId!: string | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ProductVariantsBulkPayload {
  @Field(() => Product, { nullable: true })
  product!: Product | null;

  @Field(() => [ProductVariant], {
    nullable: true,
    description: 'The variants created or updated, in input order.',
  })
  productVariants!: ProductVariant[] | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ProductPayload {
  @Field(() => Product, { nullable: true })
  product!: Product | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ProductOptionsDeletePayload {
  @Field(() => [ID], { nullable: true })
  deletedOptionsIds!: string[] | null;

  @Field(() => Product, { nullable: true })
  product!: Product | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ProductCreateMediaPayload {
  @Field(() => [ProductMedia], { nullable: true, description: 'The new media, in input order.' })
  media!: ProductMedia[] | null;

  @Field(() => Product, { nullable: true })
  product!: Product | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType()
export class ProductDeleteMediaPayload {
  @Field(() => [ID], { nullable: true })
  deletedMediaIds!: string[] | null;

  @Field(() => Product, { nullable: true })
  product!: Product | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}
