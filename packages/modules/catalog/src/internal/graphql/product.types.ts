import { Money, PageInfo, SEO, SEOInput, UserError } from '@hatti/api';
import type { MediaRecord } from '../records.js';
import {
  ArgsType,
  Field,
  Float,
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
    UPLOADED: { description: 'Recorded; not yet read from its source.' },
    PROCESSING: {
      description:
        'Being read from its source and checked; tried again later if its source did not answer.',
    },
    READY: { description: 'Ready to show, at the widths and in the formats browsers ask for.' },
    FAILED: {
      description:
        'Could not be read, or is not an image or video to show: `mediaErrors` says why.',
    },
  },
});

export enum MediaErrorCode {
  IMAGE_DOWNLOAD_FAILURE = 'IMAGE_DOWNLOAD_FAILURE',
  UNSUPPORTED_IMAGE_FILE_TYPE = 'UNSUPPORTED_IMAGE_FILE_TYPE',
  INVALID_IMAGE_FILE_SIZE = 'INVALID_IMAGE_FILE_SIZE',
  INVALID_IMAGE_RESOLUTION = 'INVALID_IMAGE_RESOLUTION',
  INVALID_IMAGE_ASPECT_RATIO = 'INVALID_IMAGE_ASPECT_RATIO',
  IMAGE_PROCESSING_FAILURE = 'IMAGE_PROCESSING_FAILURE',
  VIDEO_INVALID_FILETYPE_ERROR = 'VIDEO_INVALID_FILETYPE_ERROR',
  VIDEO_METADATA_READ_ERROR = 'VIDEO_METADATA_READ_ERROR',
  VIDEO_MAX_DURATION_ERROR = 'VIDEO_MAX_DURATION_ERROR',
  GENERIC_FILE_INVALID_SIZE = 'GENERIC_FILE_INVALID_SIZE',
  GENERIC_FILE_DOWNLOAD_FAILURE = 'GENERIC_FILE_DOWNLOAD_FAILURE',
  EXTERNAL_VIDEO_NOT_FOUND = 'EXTERNAL_VIDEO_NOT_FOUND',
  UNKNOWN = 'UNKNOWN',
}

registerEnumType(MediaErrorCode, {
  name: 'MediaErrorCode',
  description: "Why a media failed, in Shopify's codes (ADR-158).",
  valuesMap: {
    IMAGE_DOWNLOAD_FAILURE: { description: 'Its URL or upload could not be read.' },
    UNSUPPORTED_IMAGE_FILE_TYPE: {
      description: 'Not a JPEG, PNG, WebP, GIF or AVIF image; HEIC photos among them.',
    },
    INVALID_IMAGE_FILE_SIZE: { description: 'Over 20 MB.' },
    INVALID_IMAGE_RESOLUTION: { description: 'Over 50 megapixels.' },
    INVALID_IMAGE_ASPECT_RATIO: { description: 'One side over 20 times the other.' },
    IMAGE_PROCESSING_FAILURE: { description: 'Damaged, or not what it says it is.' },
    VIDEO_INVALID_FILETYPE_ERROR: {
      description:
        'Not an MP4 or QuickTime video of H.264 and AAC, which every browser plays: HEVC among ' +
        'them (ADR-258).',
    },
    VIDEO_METADATA_READ_ERROR: { description: 'Its index, length or size could not be read.' },
    VIDEO_MAX_DURATION_ERROR: { description: 'Over 10 minutes.' },
    GENERIC_FILE_INVALID_SIZE: { description: 'A video over 100 MB.' },
    GENERIC_FILE_DOWNLOAD_FAILURE: { description: "A video's upload could not be read." },
    EXTERNAL_VIDEO_NOT_FOUND: {
      description: 'YouTube or Vimeo gave no image for the video: private, or gone.',
    },
    UNKNOWN: { description: 'Anything else.' },
  },
});

@ObjectType({ description: 'Why a media failed (ADR-158).' })
export class MediaError {
  @Field(() => MediaErrorCode)
  code!: MediaErrorCode;

  @Field({ description: 'What is wrong with it, and what to do, for the merchant.' })
  message!: string;
}

@ObjectType({ description: 'An image as Hatti serves it (ADR-158).' })
export class Image {
  @Field({
    description:
      'Where it is served, at its own size: add `?width=` for a width, which it is made at the ' +
      "next of 96, 192, 360, 540, 720, 960, 1200, 1500 and 2048 pixels; the browser's Accept " +
      'header picks AVIF, WebP or its own format. The address never changes what it shows.',
  })
  url!: string;

  @Field(() => Int, { description: 'In pixels, at its own size.' })
  width!: number;

  @Field(() => Int)
  height!: number;

  @Field(() => String, { nullable: true })
  altText!: string | null;
}

@ObjectType({
  description:
    'The part of an image shown (ADR-257), in pixels of the whole image (`ProductMedia.width` ' +
    'and `height`) from its top left.',
})
export class ImageCrop {
  @Field(() => Int)
  left!: number;

  @Field(() => Int)
  top!: number;

  @Field(() => Int)
  width!: number;

  @Field(() => Int)
  height!: number;
}

@ObjectType({
  description:
    'What matters in an image (ADR-257), in percent of the image shown, across and down from ' +
    'its top left: themes keep it in sight as they fill a frame with the image.',
})
export class FocalPoint {
  @Field(() => Float)
  x!: number;

  @Field(() => Float)
  y!: number;
}

export enum MediaContentType {
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
  EXTERNAL_VIDEO = 'EXTERNAL_VIDEO',
}

registerEnumType(MediaContentType, {
  name: 'MediaContentType',
  valuesMap: {
    IMAGE: { description: 'An image.' },
    VIDEO: {
      description: 'A video the shop uploaded: MP4 or QuickTime, H.264 and AAC (ADR-258).',
    },
    EXTERNAL_VIDEO: { description: 'A YouTube or Vimeo video, by its address.' },
  },
});

export enum ExternalVideoHost {
  YOUTUBE = 'YOUTUBE',
  VIMEO = 'VIMEO',
}

registerEnumType(ExternalVideoHost, { name: 'MediaHost' });

@ObjectType({
  description: "A video's file as Hatti serves it (ADR-258), as Shopify's VideoSource.",
})
export class VideoSource {
  @Field({
    description:
      'Where it is served, whole or a range at a time, as browsers ask; the address never ' +
      'changes what it shows.',
  })
  url!: string;

  @Field({ description: 'video/mp4.' })
  mimeType!: string;

  @Field({ description: 'mp4.' })
  format!: string;

  @Field(() => Int, { description: 'In pixels, as shown.' })
  width!: number;

  @Field(() => Int)
  height!: number;

  @Field(() => Int, { description: 'Bytes.' })
  fileSize!: number;
}

@ObjectType({ description: 'A video the shop uploaded, as Hatti serves it once ready (ADR-258).' })
export class ProductVideo {
  @Field(() => [VideoSource])
  sources!: VideoSource[];

  @Field(() => Int, { description: 'How long it lasts, in milliseconds.' })
  duration!: number;
}

@ObjectType({ description: 'A YouTube or Vimeo video (ADR-258).' })
export class ExternalVideo {
  @Field(() => ExternalVideoHost)
  host!: ExternalVideoHost;

  @Field({ description: 'Its ID there.' })
  externalId!: string;

  @Field({ description: 'Where it is watched.' })
  originUrl!: string;

  @Field({ description: 'Where pages embed it from.' })
  embedUrl!: string;
}

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

@ObjectType({ description: 'An image or a video of a product.' })
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

  @Field({
    description:
      'Where it came from: the URL given, or the file the shop uploaded, by its location.',
  })
  sourceUrl!: string;

  @Field(() => Int, {
    nullable: true,
    description: 'In pixels, once ready: the whole image, before any crop.',
  })
  width!: number | null;

  @Field(() => Int, { nullable: true })
  height!: number | null;

  @Field(() => [MediaError], { description: 'Why it failed; none unless it did.' })
  mediaErrors!: MediaError[];

  @Field(() => ImageCrop, {
    nullable: true,
    description: 'The part of the image shown; null for all of it.',
  })
  crop!: ImageCrop | null;

  @Field(() => FocalPoint, { nullable: true, description: 'What matters in it; null for none.' })
  focalPoint!: FocalPoint | null;

  @Field(() => ExternalVideo, {
    nullable: true,
    description: 'A YouTube or Vimeo video; null for anything else.',
  })
  externalVideo!: ExternalVideo | null;

  /** The media as the catalog keeps it, and its product's handle: for its image's address. */
  record!: MediaRecord;
  handle!: string;
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

  @Field(() => SEO, {
    description:
      'What search engines and link previews are told in place of its title and description ' +
      '(ADR-231).',
  })
  seo!: SEO;

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

  @Field(() => SEOInput, {
    nullable: true,
    description: 'A title and description for search engines in place of its own.',
  })
  seo?: SEOInput | null;

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

  @Field(() => SEOInput, {
    nullable: true,
    description: 'A field left out stays as it is; null or blank clears it.',
  })
  seo?: SEOInput | null;

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
  @Field({
    description:
      'Where the image is: an https URL to fetch it from, or the `resourceUrl` of an upload ' +
      '`stagedUploadsCreate` staged, once the file is in. JPEG, PNG, WebP, GIF or AVIF, up to ' +
      '20 MB and 50 megapixels; kept at most 4,096 pixels a side, without its metadata.',
  })
  originalSource!: string;

  @Field(() => String, { nullable: true })
  alt?: string | null;

  @Field(() => MediaContentType, {
    nullable: true,
    defaultValue: MediaContentType.IMAGE,
    description:
      'IMAGE; VIDEO, its originalSource the resourceUrl of a video staged as video/mp4 or ' +
      "video/quicktime, H.264 and AAC, up to 100 MB and 10 minutes; EXTERNAL_VIDEO, a YouTube or Vimeo video's address (ADR-258).",
  })
  mediaContentType?: MediaContentType | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The image that shows before a video plays: an https URL, or the resourceUrl of an image ' +
      "staged. A VIDEO needs one, as a frame of it the admin takes; an EXTERNAL_VIDEO's own is " +
      'taken where none is given.',
  })
  previewImageSource?: string | null;
}

@InputType({
  description:
    'The part of an image to show (ADR-257), in pixels of the whole image (`ProductMedia.width` ' +
    'and `height`) from its top left: at least 16 pixels a side, one side at most 20 times the ' +
    'other.',
})
export class ImageCropInput {
  @Field(() => Int)
  left!: number;

  @Field(() => Int)
  top!: number;

  @Field(() => Int)
  width!: number;

  @Field(() => Int)
  height!: number;
}

@InputType({
  description:
    'What matters in an image, in percent of the image shown, across and down: 0 to 100.',
})
export class FocalPointInput {
  @Field(() => Float)
  x!: number;

  @Field(() => Float)
  y!: number;
}

@InputType()
export class UpdateMediaInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  alt?: string | null;

  @Field(() => ImageCropInput, {
    nullable: true,
    description:
      'The part of a ready image to show, at every size and in every format; null to show all ' +
      'of it again. The whole image is kept, to be cropped again.',
  })
  crop?: ImageCropInput | null;

  @Field(() => FocalPointInput, {
    nullable: true,
    description:
      'What matters in the image shown; null for none. A new crop clears it unless it comes ' +
      'with one.',
  })
  focalPoint?: FocalPointInput | null;
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
export class ProductDuplicatePayload {
  @Field(() => Product, { nullable: true, description: 'The copy.' })
  newProduct!: Product | null;

  @Field(() => [UserError])
  userErrors!: UserError[];
}

@ObjectType({ description: 'Products acted on many at once (CAT-04).' })
export class ProductBulkPayload {
  @Field(() => [Product], {
    description: 'The products done, in the order asked; those refused are left out.',
  })
  products!: Product[];

  @Field(() => [UserError], {
    description: 'Why products were refused, each at its place in `ids`: ["ids", "3"].',
  })
  userErrors!: UserError[];
}

@ObjectType({ description: 'Products deleted many at once (CAT-04).' })
export class ProductBulkDeletePayload {
  @Field(() => [ID], { description: 'The products deleted, in the order asked.' })
  deletedProductIds!: string[];

  @Field(() => [UserError], {
    description: 'Why products were not deleted, each at its place in `ids`: ["ids", "3"].',
  })
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
