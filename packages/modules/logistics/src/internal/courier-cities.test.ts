import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CourierAccountService } from './courier-accounts.service.js';
import { CourierCityService } from './courier-cities.service.js';
import { CourierCityReview } from './courier-city-review.js';
import { Couriers, PostExCourier, TestCourier } from './couriers.js';
import { errorsOf, logisticsFixture, unwrap, type LogisticsFixture } from './test-support.js';

const server = testDatabaseServer();

/** The test courier's cities, as its list writes them. */
const LISTED = [
  'LAHORE',
  'Rawalpindi',
  'Rawalpindi Cantt',
  'D.G. Khan',
  'Gujranwala',
  'Gujrat',
  'Islamabad',
];

const AGAIN = "Give Test courier's name for the city, then book the order again";

describe.skipIf(!server)("Couriers' names for cities (SHP-03, ADR-233)", () => {
  let f: LogisticsFixture;
  let accounts: CourierAccountService;
  let cities: CourierCityService;
  let accountId: string;
  /** The test courier's account, as the worker opens it. */
  const account = { courier: 'test', credentials: { key: 'anything-9876' } };

  beforeAll(async () => {
    f = await logisticsFixture(server!);
    const couriers = new Couriers([
      new TestCourier({ cities: LISTED }),
      // Nowhere it can be reached: its list cannot be had.
      new PostExCourier({ baseUrl: 'http://127.0.0.1:9/postex', timeoutMs: 1_000 }),
    ]);
    accounts = new CourierAccountService(f.db, f.box, couriers);
    cities = new CourierCityService(f.db, accounts, couriers);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    accountId = unwrap(
      await accounts.connect(f.a, {
        courier: 'test',
        credentials: [{ key: 'key', value: account.credentials.key }],
      }),
    ).id;
  });

  const named = async () =>
    (
      await f.admin.query<{ action: string; details: Record<string, string> }>(
        `SELECT action, details FROM platform.audit_log
          WHERE action LIKE 'courier_city.%' ORDER BY occurred_at, id`,
      )
    ).rows;

  it("books a parcel to the courier's name for its city, by Pakistan's names for it, or fails with the nearest", async () => {
    const cityOf = (city: string) => cities.courierCityOf(f.a.shopId, account, city);
    expect(await cityOf(' lahore ')).toEqual({ ok: true, value: 'LAHORE' });
    expect(await cityOf('Pindi')).toEqual({ ok: true, value: 'Rawalpindi' });
    expect(await cityOf('Dera Ghazi Khan')).toEqual({ ok: true, value: 'D.G. Khan' });
    expect(await cityOf('Gujran')).toEqual({
      ok: false,
      retry: false,
      message: `Test courier has no city named Gujran; its nearest: Gujranwala, Gujrat. ${AGAIN}`,
    });
    expect(await cityOf('Sukkur')).toEqual({
      ok: false,
      retry: false,
      message: `Test courier has no city named Sukkur. ${AGAIN}`,
    });
    expect(await cityOf('  ')).toEqual({
      ok: false,
      retry: false,
      message: "The order's address names no city",
    });
    expect(unwrap(await cities.match(f.a, accountId, 'Gujran'))).toEqual({
      city: 'Gujran',
      courierCity: null,
      source: null,
      suggestions: ['Gujranwala', 'Gujrat'],
      listError: null,
    });
  });

  it("keeps the shop's own names first, then Hatti's, for the city as written and Pakistan's name for it", async () => {
    await f.admin.query(
      `INSERT INTO logistics.courier_cities (courier, city, courier_city)
       VALUES ('test', 'Rawalpindi', 'Rawalpindi Cantt')`,
    );
    const match = async (city: string) => unwrap(await cities.match(f.a, accountId, city));
    // Hatti's, for the city by Pakistan's name for it too.
    expect(await match('rawalpindi')).toMatchObject({
      courierCity: 'Rawalpindi Cantt',
      source: 'platform',
    });
    expect(await match('Pindi')).toMatchObject({
      courierCity: 'Rawalpindi Cantt',
      source: 'platform',
    });

    // The shop's own, as the courier's list writes it.
    expect(
      unwrap(await cities.set(f.a, { accountId, city: ' Pindi ', courierCity: 'rawalpindi' })),
    ).toEqual({
      city: 'Pindi',
      courierCity: 'Rawalpindi',
      source: 'shop',
      suggestions: [],
      listError: null,
    });
    expect(await match('PINDI')).toMatchObject({ courierCity: 'Rawalpindi', source: 'shop' });
    // Kept for the city as written: Hatti's stands for Rawalpindi itself.
    expect(await match('Rawalpindi')).toMatchObject({ source: 'platform' });
    unwrap(await cities.set(f.a, { accountId, city: 'Rawalpindi', courierCity: 'Rawalpindi' }));
    // And for Pakistan's name for the city, from its others.
    expect(await match('RWP')).toMatchObject({ courierCity: 'Rawalpindi', source: 'shop' });
    expect(await cities.courierCityOf(f.a.shopId, account, 'rwp')).toEqual({
      ok: true,
      value: 'Rawalpindi',
    });
    // Named again, it changes.
    unwrap(await cities.set(f.a, { accountId, city: 'Gujran', courierCity: 'Gujrat' }));
    unwrap(await cities.set(f.a, { accountId, city: 'gujran', courierCity: 'Gujranwala' }));
    expect(
      unwrap(await cities.names(f.a, accountId)).map((each) => [each.city, each.courierCity]),
    ).toEqual([
      ['gujran', 'Gujranwala'],
      ['Pindi', 'Rawalpindi'],
      ['Rawalpindi', 'Rawalpindi'],
    ]);

    // Forgotten, Hatti's stands again; forgetting one not kept changes nothing.
    expect(
      unwrap(await cities.set(f.a, { accountId, city: 'Rawalpindi', courierCity: null })),
    ).toMatchObject({ courierCity: 'Rawalpindi Cantt', source: 'platform' });
    unwrap(await cities.set(f.a, { accountId, city: 'Multan' }));
    expect(unwrap(await cities.names(f.a, accountId))).toHaveLength(2);
    expect((await named()).map((entry) => [entry.action, entry.details.courierCity])).toEqual([
      ['courier_city.named', 'Rawalpindi'],
      ['courier_city.named', 'Rawalpindi'],
      ['courier_city.named', 'Gujrat'],
      ['courier_city.named', 'Gujranwala'],
      ['courier_city.forgotten', 'Rawalpindi'],
    ]);

    // Another shop's are its own.
    const theirs = unwrap(
      await accounts.connect(f.b, {
        courier: 'test',
        credentials: [{ key: 'key', value: 'other-shop-1234' }],
      }),
    );
    expect(unwrap(await cities.names(f.b, theirs.id))).toEqual([]);
    expect(unwrap(await cities.match(f.b, theirs.id, 'Pindi'))).toMatchObject({
      courierCity: 'Rawalpindi Cantt',
      source: 'platform',
    });
    expect(errorsOf(await cities.names(f.b, accountId))).toEqual([['accountId', 'NOT_FOUND']]);
    expect(
      errorsOf(await cities.set(f.b, { accountId, city: 'Pindi', courierCity: 'Islamabad' })),
    ).toEqual([['input.accountId', 'NOT_FOUND']]);
    expect(await match('Pindi')).toMatchObject({ courierCity: 'Rawalpindi', source: 'shop' });
  });

  it("shares a name three shops gave a city alike, none giving another, after Hatti's (ADR-260)", async () => {
    // Two shops more, each with the courier.
    const shops = [f.a, f.b];
    for (const name of ['C', 'D']) {
      const shopId = newId();
      await f.admin.query(`INSERT INTO control.shops (id, name) VALUES ($1, $2)`, [shopId, name]);
      shops.push({ ...f.a, shopId, actor: { kind: 'app', tokenId: newId() } });
    }
    const [a, b, c, d] = shops as [typeof f.a, typeof f.a, typeof f.a, typeof f.a];
    const accountOf = new Map<string, string>([[a.shopId, accountId]]);
    for (const shop of [b, c, d]) {
      const connected = unwrap(
        await accounts.connect(shop, {
          courier: 'test',
          credentials: [{ key: 'key', value: `key-of-${shop.shopId.slice(-4)}` }],
        }),
      );
      accountOf.set(shop.shopId, connected.id);
    }
    const name = (shop: typeof a, courierCity: string | null) =>
      cities.set(shop, { accountId: accountOf.get(shop.shopId)!, city: 'Gujran', courierCity });
    const matchIn = async (shop: typeof a) =>
      unwrap(await cities.match(shop, accountOf.get(shop.shopId)!, 'gujran'));

    // Two shops agreeing is not enough: the fourth still chooses.
    unwrap(await name(a, 'Gujranwala'));
    unwrap(await name(b, 'gujranwala'));
    expect(await matchIn(d)).toMatchObject({
      courierCity: null,
      source: null,
      suggestions: ['Gujranwala', 'Gujrat'],
    });
    // A third, as the courier's list writes it: every shop's now, its own coming first.
    unwrap(await name(c, 'GUJRANWALA'));
    expect(await matchIn(d)).toMatchObject({ courierCity: 'Gujranwala', source: 'shops' });
    expect(await cities.courierCityOf(d.shopId, account, 'Gujran')).toEqual({
      ok: true,
      value: 'Gujranwala',
    });
    expect(await matchIn(a)).toMatchObject({ courierCity: 'Gujranwala', source: 'shop' });

    // One shop giving another withdraws it, until it agrees again.
    unwrap(await name(b, 'Gujrat'));
    expect(await matchIn(d)).toMatchObject({ courierCity: null, source: null });
    const review = new CourierCityReview(f.db);
    expect((await review.review('test')).shops).toEqual([
      {
        cityKey: 'gujran',
        city: 'Gujran',
        names: [
          { courierCity: 'Gujranwala', shops: 2 },
          { courierCity: 'Gujrat', shops: 1 },
        ],
        shared: null,
      },
    ]);
    unwrap(await name(b, 'Gujranwala'));
    expect(await matchIn(d)).toMatchObject({ courierCity: 'Gujranwala', source: 'shops' });
    expect(await review.review('test')).toEqual({
      shops: [
        {
          cityKey: 'gujran',
          city: 'Gujran',
          names: [{ courierCity: 'Gujranwala', shops: 3 }],
          shared: 'Gujranwala',
        },
      ],
      hatti: [],
    });

    // Hatti's people settle a city shops named wrong: Hatti's comes first, until forgotten.
    await review.keep('test', ' gujran ', 'Gujrat');
    expect(await matchIn(d)).toMatchObject({ courierCity: 'Gujrat', source: 'platform' });
    await review.keep('test', 'Gujran', 'Gujrat');
    expect((await review.review('test')).hatti).toEqual([
      { city: 'Gujran', courierCity: 'Gujrat' },
    ]);
    expect(await review.forget('test', 'GUJRAN')).toBe(true);
    expect(await review.forget('test', 'Gujran')).toBe(false);
    expect(await matchIn(d)).toMatchObject({ courierCity: 'Gujranwala', source: 'shops' });
    await expect(review.keep('test', 'Gujran', ' ')).rejects.toThrow("The courier's name is blank");
    await expect(review.keep('Test!', 'Gujran', 'Gujrat')).rejects.toThrow(
      'No courier is called Test!',
    );
    // Shops never write Hatti's names.
    const denied = await f.db
      .tenant(d.shopId, (tx) =>
        tx.execute(sql`INSERT INTO logistics.courier_cities VALUES ('test', 'Sukkur', 'Gujrat')`),
      )
      .catch((error: { code?: string; cause?: { code?: string } }) => error);
    expect((denied as { cause?: { code?: string } }).cause?.code).toBe('42501');
  });

  it("takes only names on the courier's list, a city and a name given, and an account the shop books with", async () => {
    const set = (city: string, courierCity: string | null, id = accountId) =>
      cities.set(f.a, { accountId: id, city, courierCity });
    expect(errorsOf(await set(' ', '-'))).toEqual([
      ['input.city', 'BLANK'],
      ['input.courierCity', 'BLANK'],
    ]);
    expect(errorsOf(await set('x'.repeat(101), 'y'.repeat(101)))).toEqual([
      ['input.city', 'TOO_LONG'],
      ['input.courierCity', 'TOO_LONG'],
    ]);
    const missing = await set('Gujran', 'Gujrawala');
    expect(missing.ok ? null : missing.errors).toEqual([
      {
        field: ['input', 'courierCity'],
        code: 'NOT_FOUND',
        message: 'Test courier has no city named Gujrawala; its nearest: Gujranwala',
      },
    ]);
    expect(errorsOf(await set('Gujran', 'Gujrat', newId()))).toEqual([
      ['input.accountId', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await cities.match(f.a, newId(), 'Gujran'))).toEqual([
      ['accountId', 'NOT_FOUND'],
    ]);
    expect(errorsOf(await cities.match(f.a, accountId, 'x'.repeat(101)))).toEqual([
      ['city', 'TOO_LONG'],
    ]);
    unwrap(await accounts.archive(f.a, accountId));
    expect(errorsOf(await set('Gujran', 'Gujrat'))).toEqual([['input.accountId', 'INVALID']]);
    expect(unwrap(await cities.names(f.a, accountId))).toEqual([]);
    expect(await named()).toEqual([]);
  });

  it("gives the city as written, by Pakistan's name for it, to a courier whose list cannot be had", async () => {
    const postex = unwrap(
      await accounts.connect(f.a, {
        courier: 'postex',
        credentials: [{ key: 'token', value: 'pX7tokenLive0042abcd' }],
      }),
    );
    expect(unwrap(await cities.match(f.a, postex.id, 'Pindi'))).toEqual({
      city: 'Pindi',
      courierCity: 'Rawalpindi',
      source: 'written',
      suggestions: [],
      listError: expect.stringMatching(/^PostEx could not be reached: /),
    });
    expect(unwrap(await cities.match(f.a, postex.id, 'Pind Dadan Khan'))).toMatchObject({
      courierCity: 'Pind Dadan Khan',
      source: 'written',
    });
    // Hatti's names, as before couriers' lists.
    await f.admin.query(
      `INSERT INTO logistics.courier_cities (courier, city, courier_city)
       VALUES ('postex', 'Rawalpindi', 'Rawalpindi Cantt')`,
    );
    expect(
      await cities.courierCityOf(
        f.a.shopId,
        { courier: 'postex', credentials: { token: 'pX7tokenLive0042abcd' } },
        'rawalpindi',
      ),
    ).toEqual({ ok: true, value: 'Rawalpindi Cantt' });
    // The shop's own, kept as given: the courier says at booking if it knows it not.
    expect(
      unwrap(await cities.set(f.a, { accountId: postex.id, city: 'Pindi', courierCity: 'RWP' })),
    ).toMatchObject({ courierCity: 'RWP', source: 'shop' });

    // A courier with no list at all.
    const plain = new Couriers([new TestCourier()]);
    const unlisted = new CourierCityService(
      f.db,
      new CourierAccountService(f.db, f.box, plain),
      plain,
    );
    expect(unwrap(await unlisted.match(f.a, accountId, 'lhr'))).toEqual({
      city: 'lhr',
      courierCity: 'Lahore',
      source: 'written',
      suggestions: [],
      listError: null,
    });
  });
});
