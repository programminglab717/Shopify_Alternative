import type {
  CollectionRuleValue,
  CollectionSortOrderValue,
  MediaStatusValue,
  ProductStatusValue,
} from './schema.js';

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
  mediaType: 'image';
  sourceUrl: string;
  alt: string;
  position: number;
  status: MediaStatusValue;
  width: number | null;
  height: number | null;
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
  productsCount: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Page<T> {
  items: T[];
  hasNextPage: boolean;
}
