import { Money, UserError } from '@hatti/api';
import { toPublicId } from '@hatti/ids';
import { money, type CurrencyCode } from '@hatti/money';
import type { FieldError, ProductRecord, VariantRecord } from '../product.service.js';
import type { ProductStatusValue } from '../schema.js';
import { Product, ProductPriceRange, ProductStatus, ProductVariant } from './product.types.js';

export function toStatusValue(status: ProductStatus): ProductStatusValue {
  return status.toLowerCase() as ProductStatusValue;
}

function toStatus(value: ProductStatusValue): ProductStatus {
  return value.toUpperCase() as ProductStatus;
}

function toVariant(record: VariantRecord, currency: CurrencyCode): ProductVariant {
  return Object.assign(new ProductVariant(), {
    id: toPublicId('variant', record.id),
    title: record.title,
    sku: record.sku,
    barcode: record.barcode,
    price: Money.from(money(record.price, currency)),
    compareAtPrice:
      record.compareAtPrice === null ? null : Money.from(money(record.compareAtPrice, currency)),
    position: record.position,
  });
}

function priceRange(record: ProductRecord, currency: CurrencyCode): ProductPriceRange {
  const prices = record.variants.map((variant) => variant.price);
  const min = prices.reduce((a, b) => (b < a ? b : a), prices[0] ?? 0n);
  const max = prices.reduce((a, b) => (b > a ? b : a), prices[0] ?? 0n);
  return Object.assign(new ProductPriceRange(), {
    minVariantPrice: Money.from(money(min, currency)),
    maxVariantPrice: Money.from(money(max, currency)),
  });
}

export function toProduct(record: ProductRecord, currency: CurrencyCode): Product {
  return Object.assign(new Product(), {
    id: toPublicId('product', record.id),
    title: record.title,
    handle: record.handle,
    status: toStatus(record.status),
    description: record.description,
    vendor: record.vendor,
    productType: record.productType,
    tags: record.tags,
    variants: record.variants.map((variant) => toVariant(variant, currency)),
    priceRange: priceRange(record, currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toUserErrors(errors: FieldError[]): UserError[] {
  return errors.map((error) => UserError.of(error.field, error.code, error.message));
}
