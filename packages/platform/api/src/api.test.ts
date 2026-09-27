import 'reflect-metadata';
import { money } from '@hatti/money';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { GraphQLError } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  Money,
  RequireScopes,
  ScopesGuard,
  decodeCursor,
  encodeCursor,
  generateAccessToken,
  hasScope,
  hashAccessToken,
  pageSize,
  type TenantContext,
} from './index.js';

const tenant = (...scopes: string[]): TenantContext => ({
  shopId: '0192a0b0-0000-7000-8000-000000000000',
  currency: 'PKR',
  actor: { kind: 'app', tokenId: '0192a0b0-0000-7000-8000-000000000001' },
  scopes: new Set(scopes),
});

class Resolvers {
  @RequireScopes('read_products')
  products() {}

  @RequireScopes('write_products')
  productCreate() {}

  shop() {}
}

function graphqlContext(handler: () => void, context: object): ExecutionContext {
  const args = [undefined, {}, context, {}];
  return {
    getType: () => 'graphql',
    getHandler: () => handler,
    getClass: () => Resolvers,
    getArgs: () => args,
    getArgByIndex: (index: number) => args[index],
  } as unknown as ExecutionContext;
}

function errorCode(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return (error as GraphQLError).extensions?.code;
  }
  return undefined;
}

describe('access tokens', () => {
  it('generates prefixed tokens and stores only a hash', () => {
    const { token, hash, hint } = generateAccessToken();
    expect(token).toMatch(/^hat_[A-Za-z0-9_-]{43}$/);
    expect(hash).toHaveLength(32);
    expect(hash.equals(hashAccessToken(token))).toBe(true);
    expect(token.endsWith(hint)).toBe(true);
    expect(generateAccessToken().token).not.toBe(token);
  });
});

describe('scopes', () => {
  it('treats write as implying read', () => {
    expect(hasScope(tenant('write_products'), 'read_products')).toBe(true);
    expect(hasScope(tenant('read_products'), 'write_products')).toBe(false);
  });

  it('has decorator metadata for dependency injection', () => {
    // NestJS resolves constructor dependencies from design:paramtypes. The test transform must
    // emit it, as tsc does for builds (tsconfig.nest.json).
    expect(Reflect.getMetadata('design:paramtypes', ScopesGuard)).toEqual([Reflector]);
  });

  it('is enforced by the guard, which Nest can construct', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ScopesGuard, Reflector],
    }).compile();
    const guard = moduleRef.get(ScopesGuard);
    const { products, productCreate, shop } = Resolvers.prototype;

    expect(guard.canActivate(graphqlContext(products, { tenant: tenant('read_products') }))).toBe(
      true,
    );
    expect(guard.canActivate(graphqlContext(shop, { tenant: tenant() }))).toBe(true);
    expect(
      errorCode(() =>
        guard.canActivate(graphqlContext(productCreate, { tenant: tenant('read_products') })),
      ),
    ).toBe('ACCESS_DENIED');
    expect(errorCode(() => guard.canActivate(graphqlContext(products, {})))).toBe(
      'UNAUTHENTICATED',
    );
  });
});

describe('pagination', () => {
  it('round-trips cursors and rejects tampered ones', () => {
    const cursor = encodeCursor({ id: 'abc' });
    expect(decodeCursor(cursor, ['id'])).toEqual({ id: 'abc' });
    expect(() => decodeCursor('not-a-cursor', ['id'])).toThrow(GraphQLError);
    expect(() => decodeCursor(encodeCursor({ other: 'x' }), ['id'])).toThrow('Invalid cursor');
  });

  it('bounds page sizes', () => {
    expect(pageSize(undefined)).toBe(50);
    expect(pageSize(250)).toBe(250);
    expect(() => pageSize(0)).toThrow();
    expect(() => pageSize(251)).toThrow();
  });
});

describe('Money type', () => {
  it('exposes decimal and formatted amounts', () => {
    expect({ ...Money.from(money(1_250_050n, 'PKR')) }).toEqual({
      amount: '12500.50',
      currencyCode: 'PKR',
      formatted: 'Rs 12,500.50',
    });
  });
});
