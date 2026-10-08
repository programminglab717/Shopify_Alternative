import 'reflect-metadata';
import { DnsLookup, PlanAllowance, StorefrontSite } from '@hatti/api';
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

/** A plan, such as Free, that leaves out every feature it may. */
class WithoutFeatures extends PlanAllowance {
  async limitOf(): Promise<null> {
    return null;
  }

  async limitIn(): Promise<null> {
    return null;
  }

  async excludes(): Promise<string> {
    return 'Free';
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

  it('checks verified domains again, telling of one DNS points elsewhere and disconnecting it three days on (ADR-262)', async () => {
    const www = unwrap(await service.create(f.a, { host: 'www.zari.pk' }));
    const apex = unwrap(await service.create(f.a, { host: 'zari.pk' }));
    unwrap(await service.create(f.a, { host: 'shop.zari.pk' }));
    const theirs = unwrap(await service.create(f.b, { host: 'www.theirs.pk' }));
    for (const host of ['www.zari.pk', 'zari.pk', 'www.theirs.pk']) {
      dns.records.set(host, { cnames: ['shops.hatti.pk'] });
    }
    unwrap(await service.verify(f.a, www.id));
    unwrap(await service.verify(f.a, apex.id));
    unwrap(await service.verify(f.b, theirs.id));
    unwrap(await service.update(f.a, www.id, { isPrimary: true }));
    /** Moves a column of the shop's domains, or one of them, back by `hours`. */
    const back = (column: 'checked_at' | 'unpointed_since', hours: number, id?: string) =>
      f.admin.query(
        `UPDATE online_store.domains SET ${column} = ${column} - make_interval(hours => $1)
          WHERE $2::uuid IS NULL OR id = $2`,
        [hours, id ?? null],
      );
    const due = async (limit = 10) =>
      (await service.domainsToCheck(limit)).map((each) => each.id).sort();
    const domainOf = async (id: string) => (await service.get(f.a, id))!;
    const events = async (type: string) =>
      (await f.outbox()).filter((row) => row.event_type === type).map((row) => row.payload);

    // Each verified domain, every shop's, six hours after it was checked; none not verified.
    expect(await due()).toEqual([]);
    await back('checked_at', 7);
    expect(await due()).toEqual([www.id, apex.id, theirs.id].sort());
    expect(await due(2)).toHaveLength(2);

    // Pointed elsewhere: noted, and the shop told once, still served meanwhile.
    dns.records.set('www.zari.pk', { cnames: ['zari.myshopify.com'] });
    expect(await service.recheck(f.a.shopId, www.id)).toBe('unpointed');
    expect(await service.recheck(f.a.shopId, apex.id)).toBe('pointed');
    expect(await service.recheck(f.b.shopId, theirs.id)).toBe('pointed');
    // Another shop's is not this shop's to check.
    expect(await service.recheck(f.a.shopId, theirs.id)).toBe('skipped');
    expect(await due()).toEqual([]);
    const unpointed = await domainOf(www.id);
    expect(unpointed).toMatchObject({ isPrimary: true, unpointedSince: expect.any(Date) });
    expect(unpointed.verifiedAt).not.toBeNull();
    const [told] = await events('domain.unpointed');
    expect(told).toEqual({
      host: 'www.zari.pk',
      isVerified: true,
      isPrimary: true,
      disconnectAt: new Date(unpointed.unpointedSince!.getTime() + 72 * 3_600_000).toISOString(),
    });
    await back('checked_at', 7, www.id);
    expect(await service.recheck(f.a.shopId, www.id)).toBe('unpointed');
    expect(await events('domain.unpointed')).toHaveLength(1);

    // One pointed elsewhere is not made primary; pointed back, it is as before.
    dns.records.set('zari.pk', { cnames: ['parked.example.com'] });
    await back('checked_at', 7, apex.id);
    expect(await service.recheck(f.a.shopId, apex.id)).toBe('unpointed');
    expect(errorsOf(await service.update(f.a, apex.id, { isPrimary: true }))[0]?.[1]).toBe(
      'NOT_POINTED',
    );
    dns.records.set('zari.pk', { cnames: ['shops.hatti.pk'] });
    await back('checked_at', 7, apex.id);
    expect(await service.recheck(f.a.shopId, apex.id)).toBe('pointed');
    expect((await domainOf(apex.id)).unpointedSince).toBeNull();

    // DNS that does not answer changes nothing.
    dns.down = true;
    await back('checked_at', 7, apex.id);
    expect(await service.recheck(f.a.shopId, apex.id)).toBe('unanswered');
    expect(await domainOf(apex.id)).toMatchObject({ unpointedSince: null, isPrimary: false });
    dns.down = false;

    // Three days pointed elsewhere: disconnected, the platform's address primary in its place.
    await back('unpointed_since', 73, www.id);
    await back('checked_at', 7, www.id);
    expect(await service.recheck(f.a.shopId, www.id)).toBe('disconnected');
    expect(await domainOf(www.id)).toMatchObject({ verifiedAt: null, isPrimary: false });
    expect(await events('domain.updated')).toContainEqual({
      host: 'www.zari.pk',
      isVerified: false,
      isPrimary: false,
      changed: ['isVerified', 'isPrimary'],
    });
    expect(await due()).toEqual([]);
    expect(await service.recheck(f.a.shopId, www.id)).toBe('skipped');

    // Pointed back, the shop checks it again: verified, pointing from now on.
    dns.records.set('www.zari.pk', { cnames: ['shops.hatti.pk'] });
    expect(unwrap(await service.verify(f.a, www.id))).toMatchObject({
      verifiedAt: expect.any(Date),
      unpointedSince: null,
    });
  });

  it('connects no domain on a plan without them, and keeps those connected before (ADR-264)', async () => {
    const www = unwrap(await service.create(f.a, { host: 'www.zari.pk' }));
    const free = new DomainService(
      f.db,
      new StorefrontSite('https://hatti.pk'),
      dns,
      new WithoutFeatures(),
    );
    expect(errorsOf(await free.create(f.a, { host: 'shop.zari.pk' }))).toEqual([
      [
        'host',
        'INVALID',
        "The Free plan doesn't include a domain of the shop's own: choose a bigger plan to " +
          'connect one',
      ],
    ]);
    expect((await free.list(f.a)).map((domain) => domain.host)).toEqual(['www.zari.pk']);
    // The one connected before is checked, and served, as before.
    dns.records.set('www.zari.pk', { cnames: ['shops.hatti.pk'] });
    expect(unwrap(await free.verify(f.a, www.id))).toMatchObject({ verifiedAt: expect.any(Date) });
  });
});
