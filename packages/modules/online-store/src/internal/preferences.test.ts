import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { preferences } from './schema.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';

const server = testDatabaseServer();

describe.skipIf(!server)('PreferencesService', () => {
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

  it('matches the migrated table', async () => {
    await f.db.tenant(f.a.shopId, (tx) => tx.select().from(preferences).limit(1));
  });

  it("keeps a shop's WhatsApp number in E.164, recording each change", async () => {
    expect(await f.preferences.get(f.a)).toEqual({ whatsappNumber: null });
    expect(unwrap(await f.preferences.update(f.a, { whatsappNumber: '0300 1234567' }))).toEqual({
      whatsappNumber: '+923001234567',
    });
    // The same number written another way, or none given, changes nothing.
    unwrap(await f.preferences.update(f.a, { whatsappNumber: '+92 300 1234567' }));
    unwrap(await f.preferences.update(f.a, {}));
    expect(errorsOf(await f.preferences.update(f.a, { whatsappNumber: '042 3571 2345' }))).toEqual([
      [
        'whatsappNumber',
        'INVALID',
        'WhatsApp number must be a Pakistani mobile number, like 0300 1234567',
      ],
    ]);
    expect(await f.preferences.get(f.a)).toEqual({ whatsappNumber: '+923001234567' });
    // Blank takes it away.
    expect(unwrap(await f.preferences.update(f.a, { whatsappNumber: ' ' }))).toEqual({
      whatsappNumber: null,
    });
    expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      ['online_store_preferences.updated', { changed: ['whatsappNumber'] }],
      ['online_store_preferences.updated', { changed: ['whatsappNumber'] }],
    ]);
    // Each shop's are its own.
    unwrap(await f.preferences.update(f.b, { whatsappNumber: '0321 7654321' }));
    expect(await f.preferences.get(f.a)).toEqual({ whatsappNumber: null });
    const read = await f.db.tenant(f.b.shopId, (tx) => f.preferences.preferencesOf(tx, f.b.shopId));
    expect(read).toEqual({ whatsappNumber: '+923217654321' });
  });
});
