import 'reflect-metadata';
import { DnsLookup, StorefrontSite } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DOMAIN_LIMIT, hostOf } from './domain-name.js';
import { DomainService } from './domain.service.js';
import { domains } from './schema.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';

const server = testDatabaseServer();

/** DNS with the records a test sets; `down` makes every question fail. */
class FakeDns extends DnsLookup {
  readonly records = new Map<string, { cnames?: string[]; addresses?: string[] }>();
  down = false;

  async cnames(host: string): Promise<string[]> {
    if (this.down) throw Object.assign(new Error('queryCname ETIMEOUT'), { code: 'ETIMEOUT' });
    return this.records.get(host)?.cnames ?? [];
  }

  async addresses(host: string): Promise<string[]> {
    return this.records.get(host)?.addresses ?? [];
  }
}

describe('Domain names', () => {
  it('reads a domain as DNS has it, however it is typed or pasted', () => {
    expect(hostOf('https://WWW.Zari.pk/products?x=1')).toBe('www.zari.pk');
    expect(hostOf(' zari.pk. ')).toBe('zari.pk');
    // An internationalised name, in its xn-- form.
    expect(hostOf('www.زری.pk')).toMatch(/^www\.xn--[a-z0-9-]+\.pk$/);
    for (const input of ['localhost', '1.2.3.4', 'zari.pk:8080', 'zari', 'a@zari.pk', '-zari.pk']) {
      expect(hostOf(input), input).toBeNull();
    }
  });
});

describe.skipIf(!server)('DomainService', () => {
  let f: OnlineStoreFixture;
  let service: DomainService;
  const dns = new FakeDns();

  beforeAll(async () => {
    f = await onlineStoreFixture(server!);
    service = new DomainService(f.db, new StorefrontSite('https://hatti.pk'), dns);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    dns.records.clear();
    dns.down = false;
  });

  it('matches the migrated table', async () => {
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(domains).limit(1));
  });

  it("connects a domain as DNS has it, one shop's on the platform, and never the platform's", async () => {
    const www = unwrap(await service.create(f.a, { host: 'https://WWW.Zari.pk/' }));
    expect(www).toMatchObject({ host: 'www.zari.pk', verifiedAt: null, isPrimary: false });
    expect(errorsOf(await service.create(f.a, { host: 'www.zari.pk' }))).toEqual([
      ['host', 'TAKEN', 'www.zari.pk is connected to a shop already'],
    ]);
    // Another shop cannot take it, though it sees none of the first shop's.
    expect(errorsOf(await service.create(f.b, { host: 'WWW.ZARI.PK' }))[0]?.[1]).toBe('TAKEN');
    expect(await service.list(f.b)).toEqual([]);
    for (const host of ['zari.hatti.pk', 'hatti.pk', 'shops.hatti.pk', 'zari']) {
      expect(errorsOf(await service.create(f.a, { host }))[0]?.[1], host).toBe('INVALID');
    }
    expect((await f.outbox()).map((row) => [row.event_type, row.payload])).toEqual([
      ['domain.created', { host: 'www.zari.pk', isVerified: false, isPrimary: false }],
    ]);

    for (let n = 2; n <= DOMAIN_LIMIT; n += 1)
      unwrap(await service.create(f.a, { host: `z${n}.pk` }));
    expect(errorsOf(await service.create(f.a, { host: 'one-more.pk' }))).toEqual([
      ['', 'TOO_MANY', `A shop can connect at most ${DOMAIN_LIMIT} domains`],
    ]);
  });

  it('verifies a domain DNS points at the platform, by its CNAME or, at an apex, its addresses', async () => {
    const www = unwrap(await service.create(f.a, { host: 'www.zari.pk' }));
    const apex = unwrap(await service.create(f.a, { host: 'zari.pk' }));
    expect(errorsOf(await service.verify(f.a, www.id))).toEqual([
      [
        'id',
        'NOT_POINTED',
        'www.zari.pk is not pointed at shops.hatti.pk: add a CNAME record naming ' +
          'shops.hatti.pk, and check again once DNS has it',
      ],
    ]);
    dns.records.set('www.zari.pk', { cnames: ['zari.myshopify.com'] });
    expect(errorsOf(await service.verify(f.a, www.id))[0]?.[2]).toMatch(
      /^www\.zari\.pk points at zari\.myshopify\.com, not/,
    );
    dns.records.set('www.zari.pk', { cnames: ['SHOPS.hatti.pk.'] });
    const verified = unwrap(await service.verify(f.a, www.id));
    expect(verified.verifiedAt).toBeInstanceOf(Date);
    unwrap(await service.verify(f.a, www.id));

    // An apex its DNS provider flattens: the target's own addresses.
    dns.records.set('shops.hatti.pk', { addresses: ['104.16.1.1', '104.16.2.2'] });
    dns.records.set('zari.pk', { addresses: ['104.16.1.1', '203.0.113.9'] });
    expect(errorsOf(await service.verify(f.a, apex.id))[0]?.[1]).toBe('NOT_POINTED');
    dns.records.set('zari.pk', { addresses: ['104.16.2.2'] });
    expect(unwrap(await service.verify(f.a, apex.id)).verifiedAt).not.toBeNull();

    // DNS that cannot be asked; a domain another shop cannot check.
    dns.down = true;
    expect(errorsOf(await service.verify(f.a, www.id))[0]?.[1]).toBe('UNAVAILABLE');
    expect(errorsOf(await service.verify(f.b, www.id))[0]?.[1]).toBe('NOT_FOUND');
    // Verified once each: the second check changed nothing.
    expect(
      (await f.outbox())
        .filter((row) => row.event_type === 'domain.updated')
        .map((row) => row.payload),
    ).toEqual([
      { host: 'www.zari.pk', isVerified: true, isPrimary: false, changed: ['isVerified'] },
      { host: 'zari.pk', isVerified: true, isPrimary: false, changed: ['isVerified'] },
    ]);
  });

  it('makes one verified domain primary at a time, and lets domains go', async () => {
    const www = unwrap(await service.create(f.a, { host: 'www.zari.pk' }));
    const apex = unwrap(await service.create(f.a, { host: 'zari.pk' }));
    expect(errorsOf(await service.update(f.a, apex.id, { isPrimary: true }))).toEqual([
      [
        'isPrimary',
        'NOT_POINTED',
        'zari.pk must point at shops.hatti.pk before it is primary: check it first',
      ],
    ]);
    dns.records.set('www.zari.pk', { cnames: ['shops.hatti.pk'] });
    dns.records.set('zari.pk', { cnames: ['shops.hatti.pk'] });
    unwrap(await service.verify(f.a, www.id));
    unwrap(await service.verify(f.a, apex.id));
    unwrap(await service.update(f.a, www.id, { isPrimary: true }));
    const primaries = async () =>
      (await service.list(f.a)).filter((domain) => domain.isPrimary).map((domain) => domain.host);
    expect(await primaries()).toEqual(['www.zari.pk']);
    // Another made primary: the first stops being.
    unwrap(await service.update(f.a, apex.id, { isPrimary: true }));
    expect(await primaries()).toEqual(['zari.pk']);
    expect((await service.list(f.a)).map((domain) => domain.host)).toEqual([
      'zari.pk',
      'www.zari.pk',
    ]);
    expect(await f.db.tenant(f.a.shopId, (tx) => service.primaryOf(tx, f.a.shopId))).toBe(
      'zari.pk',
    );
    unwrap(await service.update(f.a, apex.id, { isPrimary: false }));
    expect(await primaries()).toEqual([]);

    expect(errorsOf(await service.delete(f.b, www.id))[0]?.[1]).toBe('NOT_FOUND');
    unwrap(await service.delete(f.a, www.id));
    expect((await service.list(f.a)).map((domain) => domain.host)).toEqual(['zari.pk']);
    const events = (await f.outbox()).map((row) => row.event_type);
    expect(events.filter((type) => type === 'domain.updated')).toHaveLength(6);
    expect(events.at(-1)).toBe('domain.deleted');
    // Let go, it can be connected again, by any shop.
    unwrap(await service.create(f.b, { host: 'www.zari.pk' }));
  });
});
