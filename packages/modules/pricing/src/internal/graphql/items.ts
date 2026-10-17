import type { FieldError } from '@hatti/api';
import { toPublicId, tryFromPublicId } from '@hatti/ids';

interface ItemIds {
  productIds?: readonly string[] | null;
  collectionIds?: readonly string[] | null;
}

/**
 * `input` with the products and collections it names by their UUIDs (ADR-517); an ID that can be
 * neither one's is not found, as one the shop lacks is.
 */
export function withItemUuids<T extends ItemIds>(
  input: T,
): { ok: true; value: T } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const uuids = (field: keyof ItemIds, kind: 'product' | 'collection') => {
    const ids = input[field];
    if (ids === undefined || ids === null) return ids;
    return ids.map((id, index) => {
      const uuid = tryFromPublicId(id, kind);
      if (!uuid) {
        errors.push({
          field: [field, String(index)],
          code: 'NOT_FOUND',
          message: kind === 'product' ? 'Product not found' : 'Collection not found',
        });
      }
      return uuid ?? '';
    });
  };
  const value = {
    ...input,
    productIds: uuids('productIds', 'product'),
    collectionIds: uuids('collectionIds', 'collection'),
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** What a discount is for, by public IDs. */
export function itemIdsOf(record: { productIds: string[]; collectionIds: string[] }): {
  productIds: string[];
  collectionIds: string[];
} {
  return {
    productIds: record.productIds.map((id) => toPublicId('product', id)),
    collectionIds: record.collectionIds.map((id) => toPublicId('collection', id)),
  };
}
