import type { SeoValue } from '@hatti/api';
import type {
  CollectionRuleValue,
  CollectionSortOrderValue,
  ImageFormatValue,
  MediaStatusValue,
  MediaTypeValue,
  ProductStatusValue,
} from './schema.js';
import type { VideoHostValue } from './videos.js';

/** The catalog's view of its data, independent of GraphQL. Amounts are minor units. */

export interface SelectedOptionRecord {
  /** Option name, e.g. "Size". */
  name: string;
  /** Value name, e.g. "M". */
  value: string;
  optionId: string;
  valueId: string;
}

export interface VariantRecord {
  id: string;
  productId: string;
  /** Option values joined with " / ", e.g. "M / Maroon"; "Default Title" without options. */
  title: string;
  sku: string | null;
  barcode: string | null;
  price: bigint;
  compareAtPrice: bigint | null;
  /** What the merchant pays per unit, for profit reports. */
  cost: bigint | null;
  weightGrams: number | null;
  /** Whether its price includes the shop's sales tax (TAX-01), as Shopify's "Charge tax". */
  taxable: boolean;
  /** Shopify's tax code, naming one of the shop's tax categories (ADR-097); null for none. */
  taxCode: string | null;
  position: number;
  selectedOptions: SelectedOptionRecord[];
  mediaId: string | null;
}

export interface OptionValueRecord {
  id: string;
  name: string;
  position: number;
  /** Whether any variant uses this value. */
  hasVariants: boolean;
}

export interface OptionRecord {
  id: string;
  name: string;
  position: number;
  values: OptionValueRecord[];
}

export interface MediaRecord {
  id: string;
  productId: string;
  mediaType: MediaTypeValue;
  /** Where it came from: the URL given, or the location of the file the shop uploaded. */
  sourceUrl: string;
  /** The file the shop uploaded: its key in storage; null for an image fetched from its URL. */
  sourceKey: string | null;
  alt: string;
  position: number;
  status: MediaStatusValue;
  /** In pixels, once ready. */
  width: number | null;
  height: number | null;
  /** The clean copy Hatti keeps, once ready (ADR-158). */
  imageFormat: ImageFormatValue | null;
  imageSize: number | null;
  /** Why it failed, in Shopify's `MediaError`'s words; null unless it did. */
  error: MediaErrorRecord | null;
  /** The part shown, in the clean copy's pixels (ADR-257); null for the whole image. */
  crop: MediaCropRecord | null;
  /** What matters in it, in percent of the image shown; null for none set. */
  focalPoint: FocalPointRecord | null;
  /**
   * Where a video's preview image comes from (ADR-258): the URL given, or the location of the
   * file the shop uploaded and its key; null for an image, and for a YouTube or Vimeo video
   * whose own is taken.
   */
  previewSourceUrl: string | null;
  previewSourceKey: string | null;
  /** A YouTube or Vimeo video: which, and its ID there; null for anything else. */
  externalVideo: { host: VideoHostValue; id: string } | null;
  /** A video the shop uploaded, once ready; null for anything else. */
  video: VideoRecord | null;
}

/** A video the shop uploaded, as Hatti keeps it (ADR-258). */
export interface VideoRecord {
  /** Its clean copy's bytes. */
  size: number;
  /** Its frame as shown, in pixels. */
  width: number;
  height: number;
  durationMs: number;
}

/** The part of an image shown, in its clean copy's pixels from its top left. */
export interface MediaCropRecord {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A point of an image, in percent of it across and down from its top left. */
export interface FocalPointRecord {
  x: number;
  y: number;
}

export interface MediaErrorRecord {
  /** Shopify's `MediaErrorCode`: IMAGE_DOWNLOAD_FAILURE, UNSUPPORTED_IMAGE_FILE_TYPE, … */
  code: string;
  message: string;
}

export interface ProductRecord {
  id: string;
  title: string;
  handle: string;
  status: ProductStatusValue;
  description: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  /** What search engines are told in place of its title and description (ADR-231). */
  seo: SeoValue;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  options: OptionRecord[];
  variants: VariantRecord[];
  media: MediaRecord[];
}

export interface CollectionRecord {
  id: string;
  title: string;
  handle: string;
  description: string;
  sortOrder: CollectionSortOrderValue;
  /** Null for a manual collection. */
  rules: CollectionRuleValue[] | null;
  disjunctive: boolean;
  /** What search engines are told in place of its title and description (ADR-231). */
  seo: SeoValue;
  productsCount: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}
