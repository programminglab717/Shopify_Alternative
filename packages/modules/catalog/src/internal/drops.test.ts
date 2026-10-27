import 'reflect-metadata';
import { PlanAllowance, type PlanFeature } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DropEvents, DropService, dropFactsIn, dropStatus, type DropInput } from './drops.js';
import { catalogFixture, errorsOf, unwrap, type CatalogFixture } from './test-support.js';

const server = testDatabaseServer();

/** A plan without drops. */
class Growth extends PlanAllowance {
  limitOf = async () => null;
  limitIn = async () => null;
  excludes = async (_shopId: string, feature: PlanFeature) =>
    feature === 'drops' ? 'Growth' : null;
}

const NOW = new Date('2026-10-27T12:00:00Z');
/** Midnight on 1 November in Karachi. */
const MIDNIGHT = new Date('2026-10-31T19:00:00Z');
const DAY = 86_400_000;

describe.skipIf(!server)('Drops (INV-09, ADR-820)', () => {
  let f: CatalogFixture;
  let drops: DropService;

  const product = async (title: string, status: 'active' | 'draft' = 'active') =>
    unwrap(await f.products.create(f.a, { title, status })).id;
  const publishAtOf = async (id: string) =>
    (
      await f.admin.query<{ publish_at: Date | null }>(
        'SELECT publish_at FROM catalog.products WHERE id = $1',
        [id],
      )
    ).rows[0]!.publish_at;
  const input = (productIds: string[], extra: Partial<DropInput> = {}): DropInput => ({
    name: 'Eid lawn',
    startsAt: MIDNIGHT,
    endsAt: new Date(MIDNIGHT.getTime() + DAY),
    productIds,
    perCustomer: 2,
    ...extra,
  });

  beforeAll(async () => {
    f = await catalogFixture(server!);
    drops = new DropService(f.db);
  }, 120_000);
  afterAll(() => f?.close());
  beforeEach(() => f.reset());

  it('schedules a drop, its drafts going on sale at its start, and says when it is live', async () => {
    const draft = await product('Lawn 3-piece, maroon', 'draft');
    const active = await product('Lawn 3-piece, teal');
    const drop = unwrap(await drops.set(f.a, null, input([draft, active, draft]), NOW));
    expect(drop).toMatchObject({
      name: 'Eid lawn',
      startsAt: MIDNIGHT,
      perCustomer: 2,
      admitPerMinute: null,
      products: [
        { id: draft, title: 'Lawn 3-piece, maroon', status: 'draft' },
        { id: active, title: 'Lawn 3-piece, teal', status: 'active' },
      ],
    });
    // The draft goes on sale at the drop's start; the active product needs none.
    expect(await publishAtOf(draft)).toEqual(MIDNIGHT);
    expect(await publishAtOf(active)).toBeNull();
    const [event] = (await f.outbox()).filter((each) => each.event_type === DropEvents.Updated);
    expect(event!.payload).toEqual({ productIds: [draft, active] });

    expect(dropStatus(drop, NOW)).toBe('scheduled');
    expect(dropStatus(drop, MIDNIGHT)).toBe('live');
    expect(dropStatus(drop, new Date(MIDNIGHT.getTime() + DAY))).toBe('ended');
    const kurta = await product('Kurta');
    const facts = await f.db.tenant(f.a.shopId, (tx) =>
      dropFactsIn(tx, f.a.shopId, [active, kurta], NOW),
    );
    expect([...facts]).toEqual([
      [
        active,
        {
          dropId: drop.id,
          name: 'Eid lawn',
          startsAt: MIDNIGHT,
          endsAt: drop.endsAt,
          perCustomer: 2,
        },
      ],
    ]);
    // Over, it is no product's drop.
    expect(
      (await f.db.tenant(f.a.shopId, (tx) => dropFactsIn(tx, f.a.shopId, [active], drop.endsAt)))
        .size,
    ).toBe(0);
    expect((await drops.list(f.a)).map((each) => each.id)).toEqual([drop.id]);
    expect(await drops.get(f.b, drop.id)).toBeNull();
  });

  it('moves its drafts with its start, and lets them go when it no longer has them or is deleted', async () => {
    const maroon = await product('Lawn, maroon', 'draft');
    const teal = await product('Lawn, teal', 'draft');
    const drop = unwrap(await drops.set(f.a, null, input([maroon, teal]), NOW));
    const later = new Date(MIDNIGHT.getTime() + 3_600_000);
    unwrap(
      await drops.set(
        f.a,
        drop.id,
        input([maroon], { startsAt: later, endsAt: new Date(later.getTime() + DAY) }),
        NOW,
      ),
    );
    expect(await publishAtOf(maroon)).toEqual(later);
    expect(await publishAtOf(teal)).toBeNull();
    // Still to start, it starts a minute ahead at least.
    expect(
      errorsOf(await drops.set(f.a, drop.id, input([maroon], { startsAt: NOW }), NOW)),
    ).toEqual([['input.startsAt', 'INVALID']]);
    expect(await drops.delete(f.a, drop.id)).toBe(true);
    expect(await publishAtOf(maroon)).toBeNull();
    expect(await drops.delete(f.a, drop.id)).toBe(false);
  });

  it('refuses a bad drop: its name, times, limits and products, and a product in another', async () => {
    const lawn = await product('Lawn');
    const card = await product('Gift card');
    await f.admin.query('UPDATE catalog.products SET gift_card = true WHERE id = $1', [card]);
    expect(
      errorsOf(
        await drops.set(
          f.a,
          null,
          input([], {
            name: ' ',
            endsAt: new Date(MIDNIGHT.getTime() + 8 * DAY),
            perCustomer: 0,
            admitPerMinute: 5,
          }),
          NOW,
        ),
      ),
    ).toEqual([
      ['input.name', 'INVALID'],
      ['input.endsAt', 'INVALID'],
      ['input.productIds', 'BLANK'],
      ['input.perCustomer', 'INVALID'],
      ['input.admitPerMinute', 'INVALID'],
    ]);
    expect(
      errorsOf(await drops.set(f.a, null, input([lawn], { startsAt: NOW, endsAt: MIDNIGHT }), NOW)),
    ).toEqual([['input.startsAt', 'INVALID']]);
    unwrap(await drops.set(f.a, null, input([lawn]), NOW));
    const other = await f.products.create(f.b, { title: 'Theirs', status: 'active' });
    expect(
      errorsOf(await drops.set(f.a, null, input([lawn, card, unwrap(other).id]), NOW)),
    ).toEqual([
      ['input.productIds.0', 'TAKEN'],
      ['input.productIds.1', 'INVALID'],
      ['input.productIds.2', 'NOT_FOUND'],
    ]);
    // Not on a plan without drops.
    expect(
      errorsOf(await new DropService(f.db, new Growth()).set(f.a, null, input([lawn]), NOW)),
    ).toEqual([['input', 'PROHIBITED']]);
  });

  it('keeps the start of a drop that has started, and changes none that has ended', async () => {
    const lawn = await product('Lawn');
    const drop = unwrap(await drops.set(f.a, null, input([lawn]), NOW));
    const during = new Date(MIDNIGHT.getTime() + 3_600_000);
    expect(
      errorsOf(await drops.set(f.a, drop.id, input([lawn], { startsAt: during }), during)),
    ).toEqual([['input.startsAt', 'INVALID']]);
    // Its limit may change while it is live.
    expect(
      unwrap(await drops.set(f.a, drop.id, input([lawn], { perCustomer: 1 }), during)).perCustomer,
    ).toBe(1);
    expect(
      errorsOf(
        await drops.set(f.a, drop.id, input([lawn]), new Date(MIDNIGHT.getTime() + 2 * DAY)),
      ),
    ).toEqual([['id', 'INVALID']]);
    // Over, its product may be in another.
    const next = new Date(MIDNIGHT.getTime() + 3 * DAY);
    unwrap(
      await drops.set(
        f.a,
        null,
        input([lawn], { startsAt: next, endsAt: new Date(next.getTime() + DAY) }),
        new Date(MIDNIGHT.getTime() + 2 * DAY),
      ),
    );
  });
});
