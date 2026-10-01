import 'reflect-metadata';
import { money } from '@hatti/money';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { GraphQLError } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  InputChecker,
  Money,
  PublicSite,
  REAUTHENTICATION_WINDOW_MS,
  ROLE_SCOPES,
  RequestLoaders,
  RequireRecentAuthentication,
  RequireScopes,
  ScopesGuard,
  StorefrontSite,
  UserError,
  UserErrorsRollback,
  decodeCursor,
  encodeCursor,
  generateAccessToken,
  hasScope,
  hashAccessToken,
  mutationsRequiringRecentAuthentication,
  pageSize,
  phoneAccess,
  recentlyAuthenticated,
  rollbackResult,
  shownPhone,
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

  @RequireScopes('write_customers')
  @RequireRecentAuthentication()
  customerErase() {}
}

/** Staff whose session's user proved who they are `minutesAgo` before `at`. */
const staffAuthenticated = (minutesAgo: number, at = new Date()): TenantContext => ({
  ...tenant('write_customers'),
  actor: {
    kind: 'staff',
    userId: 'u',
    sessionId: 's',
    role: 'owner',
    authenticatedAt: new Date(at.getTime() - minutesAgo * 60_000),
  },
});

function graphqlContext(
  handler: () => void,
  context: object,
  parentType = 'Query',
): ExecutionContext {
  const args = [
    undefined,
    {},
    context,
    { parentType: { name: parentType }, fieldName: handler.name },
  ];
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

describe('public addresses', () => {
  it("puts each shop's storefront at its handle's subdomain", () => {
    expect(new StorefrontSite('https://hatti.pk').url('zari')).toBe('https://zari.hatti.pk');
    expect(new StorefrontSite('http://localhost:4100/').url('zari')).toBe(
      'http://zari.localhost:4100',
    );
    expect(new PublicSite('https://hatti.pk/').url('/d/abc')).toBe('https://hatti.pk/d/abc');
    expect(() => new StorefrontSite('ftp://hatti.pk')).toThrow(/http/);
  });

  it("puts a storefront at its shop's own domain, which the platform's cannot be", () => {
    const site = new StorefrontSite('https://hatti.pk');
    expect(site.urlAt('www.zari.pk')).toBe('https://www.zari.pk');
    expect(site.dnsTarget).toBe('shops.hatti.pk');
    expect(new StorefrontSite('https://hatti.pk', { dnsTarget: 'edge.hatti.net' }).dnsTarget).toBe(
      'edge.hatti.net',
    );
    expect(
      ['hatti.pk', 'zari.hatti.pk', 'nothatti.pk'].map((host) => site.isPlatformHost(host)),
    ).toEqual([true, true, false]);
    expect(new StorefrontSite('http://localhost:4100').urlAt('zari.test')).toBe(
      'http://zari.test:4100',
    );
  });
});

describe('scopes', () => {
  it('gives each role the customer access its preset allows', () => {
    const customers = (role: keyof typeof ROLE_SCOPES) =>
      ROLE_SCOPES[role].filter((scope) => scope.endsWith('_customers'));
    expect(customers('owner')).toEqual(['write_customers']);
    expect(customers('manager')).toEqual(['write_customers']);
    expect(customers('confirmation_agent')).toEqual(['read_customers']);
    expect(customers('marketer')).toEqual(['read_customers']);
    expect(customers('packer')).toEqual([]);
    expect(customers('accountant')).toEqual([]);
    // Marketers build segments without being able to change customers.
    const segments = (role: keyof typeof ROLE_SCOPES) =>
      ROLE_SCOPES[role].filter((scope) => scope.endsWith('_segments'));
    expect(segments('marketer')).toEqual(['write_segments']);
    expect(segments('owner')).toEqual(['write_segments']);
    expect(segments('confirmation_agent')).toEqual([]);
  });

  it("lets only owners and managers change shop settings and the online store's themes", () => {
    for (const resource of ['_settings', '_themes']) {
      const granted = Object.entries(ROLE_SCOPES)
        .filter(([, scopes]) => scopes.some((scope) => scope.endsWith(resource)))
        .map(([role, scopes]) => [role, scopes.filter((scope) => scope.endsWith(resource))]);
      expect(granted, resource).toEqual([
        ['owner', [`write${resource}`]],
        ['manager', [`write${resource}`]],
      ]);
    }
  });

  it("lets marketers edit the online store's pages, its content, but not its themes or menus", () => {
    const pages = Object.entries(ROLE_SCOPES)
      .filter(([, scopes]) => scopes.includes('write_online_store_pages'))
      .map(([role]) => role);
    expect(pages).toEqual(['owner', 'manager', 'marketer']);
    expect(ROLE_SCOPES.marketer).not.toContain('write_online_store_navigation');
    expect(ROLE_SCOPES.marketer).not.toContain('write_themes');
  });

  it('lets owners, managers and marketers make discount codes, and no one else', () => {
    const discounts = Object.entries(ROLE_SCOPES)
      .filter(([, scopes]) => scopes.some((scope) => scope.endsWith('_discounts')))
      .map(([role, scopes]) => [role, scopes.filter((scope) => scope.endsWith('_discounts'))]);
    expect(discounts).toEqual([
      ['owner', ['write_discounts']],
      ['manager', ['write_discounts']],
      ['marketer', ['write_discounts']],
    ]);
  });

  it('shows numbers whole to owners, managers and apps, and masked to everyone else', () => {
    const staff = (role: keyof typeof ROLE_SCOPES): TenantContext => ({
      ...tenant('read_orders'),
      actor: { kind: 'staff', userId: 'u', sessionId: 's', authenticatedAt: new Date(), role },
    });
    const seen = (context: TenantContext) => [
      phoneAccess(context),
      shownPhone(context, '+923001234567'),
    ];
    expect(seen(tenant('read_orders'))).toEqual(['full', '+923001234567']);
    expect(seen(staff('manager'))).toEqual(['full', '+923001234567']);
    expect(seen(staff('confirmation_agent'))).toEqual(['reveal', '0300 ••••567']);
    for (const role of ['packer', 'marketer', 'accountant'] as const) {
      expect(seen(staff(role))).toEqual(['masked', '0300 ••••567']);
    }
  });

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

  it('asks staff to prove who they are again for sensitive mutations, after 15 minutes', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ScopesGuard, Reflector],
    }).compile();
    const guard = moduleRef.get(ScopesGuard);
    const { customerErase } = Resolvers.prototype;
    expect(mutationsRequiringRecentAuthentication().has('customerErase')).toBe(true);
    const erase = (tenant: TenantContext) => graphqlContext(customerErase, { tenant }, 'Mutation');

    expect(guard.canActivate(erase(staffAuthenticated(14)))).toBe(true);
    expect(errorCode(() => guard.canActivate(erase(staffAuthenticated(16))))).toBe(
      'REAUTHENTICATION_REQUIRED',
    );
    // Apps have no one to ask.
    expect(guard.canActivate(erase(tenant('write_customers')))).toBe(true);
    // Scopes come first: there is no point proving who you are for what you may not do.
    expect(
      errorCode(() => guard.canActivate(erase({ ...staffAuthenticated(16), scopes: new Set() }))),
    ).toBe('ACCESS_DENIED');
    // A query or field of the same name is not the mutation.
    expect(
      guard.canActivate(graphqlContext(customerErase, { tenant: staffAuthenticated(16) })),
    ).toBe(true);
  });

  it('counts the 15 minutes from when staff last proved who they are', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    expect(REAUTHENTICATION_WINDOW_MS).toBe(15 * 60_000);
    expect(recentlyAuthenticated(staffAuthenticated(0, now), now)).toBe(true);
    expect(recentlyAuthenticated(staffAuthenticated(14.99, now), now)).toBe(true);
    expect(recentlyAuthenticated(staffAuthenticated(15, now), now)).toBe(false);
    expect(recentlyAuthenticated(tenant('write_customers'), now)).toBe(true);
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

describe('request loaders', () => {
  it('batches loads made while a list resolves, and caches them for the request', async () => {
    const batches: string[][] = [];
    const loaders = new RequestLoaders();
    const loader = () =>
      loaders.get<string, number>('lengths', async (keys) => {
        batches.push([...keys]);
        return new Map(keys.filter((key) => key !== 'missing').map((key) => [key, key.length]));
      });
    const loaded = await Promise.all(
      ['a', 'bb', 'a', 'missing'].map(async (key) => {
        // Resolvers reach the loader after a few awaits, as Nest's guards and interceptors add.
        await Promise.resolve();
        return loader().load(key);
      }),
    );
    expect(loaded).toEqual([1, 2, 1, undefined]);
    expect(batches).toEqual([['a', 'bb', 'missing']]);
    expect(await loader().load('bb')).toBe(2);
    expect(batches).toHaveLength(1);
  });
});

describe('mutation results', () => {
  it('collects field errors with readable messages', () => {
    const check = new InputChecker();
    expect(check.text(['input', 'productType'], '  x  ', { max: 1 })).toBe('x');
    expect(check.text(['input', 'title'], ' ', { required: true, max: 10 })).toBeNull();
    expect(check.integer(['input', 'weight'], 1.5, { min: 0, max: 10 })).toBeNull();
    expect(check.ok).toBe(false);
    expect(UserError.list(check.errors).map((error) => ({ ...error }))).toEqual([
      { field: ['input', 'title'], code: 'BLANK', message: "Title can't be blank" },
      {
        field: ['input', 'weight'],
        code: 'INVALID',
        message: 'Weight must be a whole number from 0 to 10',
      },
    ]);
  });

  it('checks tags, email addresses and Pakistani mobile numbers', () => {
    const check = new InputChecker();
    expect(check.tags(['tags'], [' eid ', 'EID', '', 'sale'])).toEqual(['eid', 'sale']);
    expect(check.tags(['tags'], null)).toEqual([]);
    expect(check.email(['email'], ' ayesha@example.com ')).toBe('ayesha@example.com');
    expect(check.email(['email'], ' ')).toBeNull();
    expect(check.mobile(['phone'], '0300-1234567')).toBe('+923001234567');
    expect(check.mobile(['phone'], '۰۳۰۰ ۱۲۳۴۵۶۷')).toBe('+923001234567');
    expect(check.mobile(['phone'], '')).toBeNull();
    expect(check.ok).toBe(true);

    expect(check.tags(['tags'], ['x'.repeat(256)])).toHaveLength(1);
    expect(
      check.tags(
        ['more'],
        Array.from({ length: 251 }, (_, i) => `t${i}`),
      ),
    ).toHaveLength(251);
    expect(check.email(['email'], 'ayesha@')).toBeNull();
    expect(check.mobile(['phone'], '042-35761234')).toBeNull();
    expect(check.mobile(['landline'], ' ', { required: true })).toBeNull();
    expect(check.errors.map((error) => [error.field.join('.'), error.code, error.message])).toEqual(
      [
        ['tags', 'TOO_LONG', 'Tags contain a tag longer than 255 characters'],
        ['more', 'TOO_MANY', 'More can have at most 250'],
        ['email', 'INVALID', 'Email must be an email address, like name@example.com'],
        ['phone', 'INVALID', 'Phone must be a Pakistani mobile number, like 0300 1234567'],
        ['landline', 'BLANK', "Landline can't be blank"],
      ],
    );
  });

  it('turns a rollback into user errors and lets other errors through', async () => {
    const errors = [{ field: ['input'], code: 'STALE' as const, message: 'Read it again' }];
    expect(
      await rollbackResult(async () => {
        throw new UserErrorsRollback(errors);
      }),
    ).toEqual({ ok: false, errors });
    await expect(
      rollbackResult(async () => {
        throw new Error('database down');
      }),
    ).rejects.toThrow('database down');
    expect(await rollbackResult(async () => ({ ok: true, value: 1 }))).toEqual({
      ok: true,
      value: 1,
    });
  });
});
