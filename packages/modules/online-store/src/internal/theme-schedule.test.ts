import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';

const server = testDatabaseServer();
const HOUR = 3_600_000;

describe.skipIf(!server)('A theme published at a time set ahead (OS-03, ADR-695)', () => {
  let f: OnlineStoreFixture;

  beforeAll(async () => {
    f = await onlineStoreFixture(server!);
  });
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    await f.reset();
  });

  /** Brings a theme's time to now, as if the hours had passed. */
  const due = (themeId: string, ago = 0) =>
    f.admin.query(
      `UPDATE online_store.themes SET publish_at = now() - make_interval(secs => $2) WHERE id = $1`,
      [themeId, ago],
    );

  it('publishes an unpublished theme once its time comes, by the sweep', async () => {
    const main = await f.themes.main(f.a);
    const eid = unwrap(await f.themes.create(f.a, { name: 'Eid look' }));
    const at = new Date(Date.now() + 5 * HOUR);
    const set = unwrap(await f.themes.schedulePublish(f.a, eid.id, at));
    expect(set.publishAt?.toISOString()).toBe(at.toISOString());
    expect((await f.themes.get(f.a, eid.id))?.publishAt?.toISOString()).toBe(at.toISOString());
    // Not before its time.
    expect(await f.themes.shopsWithThemesDue()).toEqual([]);
    expect(await f.themes.publishDue(f.a.shopId)).toBe(0);

    await due(eid.id);
    expect(await f.themes.shopsWithThemesDue()).toEqual([f.a.shopId]);
    await f.admin.query('DELETE FROM platform.outbox_events');
    expect(await f.themes.publishDue(f.a.shopId)).toBe(1);
    expect(await f.themes.get(f.a, eid.id)).toMatchObject({ role: 'main', publishAt: null });
    expect((await f.themes.get(f.a, main.id))?.role).toBe('unpublished');
    const events = (await f.outbox()).map((event) => [event.event_type, event.payload]);
    expect(events).toEqual([
      ['theme.published', { previousId: main.id, version: expect.any(Number) }],
    ]);
    // Once.
    expect(await f.themes.publishDue(f.a.shopId)).toBe(0);
    expect(await f.themes.shopsWithThemesDue()).toEqual([]);
  });

  it('publishes the later of two due, calls off what publishing now or null calls off', async () => {
    const main = await f.themes.main(f.a);
    const lawn = unwrap(await f.themes.create(f.a, { name: 'Lawn launch' }));
    const eid = unwrap(await f.themes.create(f.a, { name: 'Eid look' }));
    const soon = new Date(Date.now() + HOUR);
    unwrap(await f.themes.schedulePublish(f.a, lawn.id, soon));
    unwrap(await f.themes.schedulePublish(f.a, eid.id, soon));
    await due(lawn.id, 120);
    await due(eid.id, 60);
    expect(await f.themes.publishDue(f.a.shopId)).toBe(1);
    expect((await f.themes.get(f.a, eid.id))?.role).toBe('main');
    expect(await f.themes.get(f.a, lawn.id)).toMatchObject({
      role: 'unpublished',
      publishAt: null,
    });

    // Published by hand before its time, its time is called off; so is one set to null.
    unwrap(await f.themes.schedulePublish(f.a, main.id, soon));
    unwrap(await f.themes.publish(f.a, main.id));
    expect((await f.themes.get(f.a, main.id))?.publishAt).toBeNull();
    unwrap(await f.themes.schedulePublish(f.a, lawn.id, soon));
    unwrap(await f.themes.schedulePublish(f.a, lawn.id, null));
    expect((await f.themes.get(f.a, lawn.id))?.publishAt).toBeNull();
  });

  it("refuses a time too near or too far, the main theme, or another shop's theme", async () => {
    const main = await f.themes.main(f.a);
    const eid = unwrap(await f.themes.create(f.a, { name: 'Eid look' }));
    const now = new Date();
    expect(
      errorsOf(await f.themes.schedulePublish(f.a, eid.id, new Date(now.getTime() + 10_000))),
    ).toEqual([['publishAt', 'INVALID', 'A theme is published a minute ahead at least']]);
    expect(
      errorsOf(
        await f.themes.schedulePublish(f.a, eid.id, new Date(now.getTime() + 400 * 24 * HOUR)),
      ),
    ).toEqual([['publishAt', 'INVALID', 'A theme is published a year ahead at most']]);
    const later = new Date(now.getTime() + HOUR);
    expect(errorsOf(await f.themes.schedulePublish(f.a, main.id, later))).toEqual([
      ['id', 'INVALID', 'The storefront shows this theme already'],
    ]);
    expect(errorsOf(await f.themes.schedulePublish(f.b, eid.id, later))).toEqual([
      ['id', 'NOT_FOUND', 'Theme not found'],
    ]);
  });
});
