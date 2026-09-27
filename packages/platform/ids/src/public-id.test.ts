import { describe, expect, it } from 'vitest';
import {
  PublicIdError,
  fromPublicId,
  newId,
  parsePublicId,
  toPublicId,
  tryFromPublicId,
  uuidVersion,
} from './index.js';

describe('newId', () => {
  it('creates UUIDv7 values', () => {
    expect(uuidVersion(newId())).toBe(7);
  });
});

describe('public IDs', () => {
  it('round-trips a UUID through the public form', () => {
    const uuid = newId();
    const publicId = toPublicId('product', uuid);
    expect(publicId).toMatch(/^prod_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(fromPublicId(publicId, 'product')).toBe(uuid);
  });

  it('encodes the extreme values correctly', () => {
    const min = '00000000-0000-0000-0000-000000000000';
    const max = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    expect(toPublicId('order', min)).toBe(`ord_${'0'.repeat(26)}`);
    expect(toPublicId('order', max)).toBe(`ord_7${'z'.repeat(25)}`);
    expect(fromPublicId(toPublicId('order', max), 'order')).toBe(max);
  });

  it('preserves creation order of UUIDv7 values', () => {
    const ids = Array.from({ length: 200 }, () => toPublicId('order', newId()));
    expect([...ids].sort()).toEqual(ids);
  });

  it('accepts uppercase input and Crockford aliases', () => {
    const uuid = newId();
    const publicId = toPublicId('customer', uuid);
    const [prefix, body] = publicId.split('_') as [string, string];
    expect(fromPublicId(`${prefix}_${body.toUpperCase()}`, 'customer')).toBe(uuid);
    const withAliases = body.replace(/1/g, 'l').replace(/0/g, 'o');
    expect(fromPublicId(`${prefix}_${withAliases}`, 'customer')).toBe(uuid);
  });

  it('rejects IDs of a different kind', () => {
    const publicId = toPublicId('order', newId());
    expect(() => fromPublicId(publicId, 'product')).toThrow(PublicIdError);
    expect(tryFromPublicId(publicId, 'product')).toBeNull();
  });

  it.each([
    ['missing prefix', '01j9zk3m8q5v7w2x4y6z8a0b1c'],
    ['unknown prefix', 'foo_01j9zk3m8q5v7w2x4y6z8a0b1c'],
    ['wrong length', 'prod_01j9zk3m8q'],
    ['invalid character', 'prod_01j9zk3m8q5v7w2x4y6z8a0b1u'],
    ['out of range', `prod_8${'0'.repeat(25)}`],
  ])('rejects malformed IDs (%s)', (_label, value) => {
    expect(() => parsePublicId(value)).toThrow(PublicIdError);
  });

  it('rejects non-UUID input when encoding', () => {
    expect(() => toPublicId('product', 'not-a-uuid')).toThrow(PublicIdError);
  });
});
