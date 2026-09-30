import 'reflect-metadata';
import { checkPassword } from '@hatti/crypto';
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

  const OPEN = {
    passwordEnabled: false,
    password: null,
    passwordVerifier: null,
    passwordMessage: '',
  };

  it("keeps a shop's WhatsApp number in E.164, recording each change", async () => {
    expect(await f.preferences.get(f.a)).toEqual({ whatsappNumber: null, ...OPEN });
    expect(unwrap(await f.preferences.update(f.a, { whatsappNumber: '0300 1234567' }))).toEqual({
      whatsappNumber: '+923001234567',
      ...OPEN,
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
    expect(await f.preferences.get(f.a)).toMatchObject({ whatsappNumber: '+923001234567' });
    // Blank takes it away.
    expect(unwrap(await f.preferences.update(f.a, { whatsappNumber: ' ' }))).toEqual({
      whatsappNumber: null,
      ...OPEN,
    });
    expect((await f.outbox()).map((event) => [event.event_type, event.payload])).toEqual([
      ['online_store_preferences.updated', { changed: ['whatsappNumber'] }],
      ['online_store_preferences.updated', { changed: ['whatsappNumber'] }],
    ]);
    // Each shop's are its own.
    unwrap(await f.preferences.update(f.b, { whatsappNumber: '0321 7654321' }));
    expect(await f.preferences.get(f.a)).toMatchObject({ whatsappNumber: null });
    const read = await f.db.tenant(f.b.shopId, (tx) => f.preferences.preferencesOf(tx, f.b.shopId));
    expect(read).toEqual({
      whatsappNumber: '+923217654321',
      passwordEnabled: false,
      passwordVerifier: null,
      passwordMessage: '',
    });
  });

  it('closes the storefront behind a password, kept sealed, with a verifier for the storefront', async () => {
    // Not without a password.
    expect(errorsOf(await f.preferences.update(f.a, { passwordEnabled: true }))).toEqual([
      ['password', 'BLANK', 'Set a password before closing the storefront behind it'],
    ]);
    const closed = unwrap(
      await f.preferences.update(f.a, {
        passwordEnabled: true,
        password: ' eid-2026 ',
        passwordMessage: 'Opening on Chand Raat.\r\nOrders on WhatsApp till then.',
      }),
    );
    expect(closed).toMatchObject({
      passwordEnabled: true,
      password: 'eid-2026',
      passwordMessage: 'Opening on Chand Raat.\nOrders on WhatsApp till then.',
    });
    expect(await checkPassword('eid-2026', closed.passwordVerifier!)).toBe(true);
    // Sealed at rest, for this shop alone.
    const { rows } = await f.admin.query<{ password_sealed: string }>(
      'SELECT password_sealed FROM online_store.preferences WHERE shop_id = $1',
      [f.a.shopId],
    );
    expect(rows[0]!.password_sealed).not.toContain('eid-2026');

    // The same password keeps its verifier, and the passes shoppers hold; a new one does not.
    const same = unwrap(await f.preferences.update(f.a, { password: 'eid-2026' }));
    expect(same.passwordVerifier).toBe(closed.passwordVerifier);
    const changed = unwrap(await f.preferences.update(f.a, { password: 'chand-raat' }));
    expect(changed.passwordVerifier).not.toBe(closed.passwordVerifier);
    // It can be changed, never taken away; opening keeps it for next time.
    for (const password of ['', 'abc', 'x'.repeat(101), 'tab\there']) {
      expect(errorsOf(await f.preferences.update(f.a, { password }))[0]?.[0], password).toBe(
        'password',
      );
    }
    expect(
      errorsOf(await f.preferences.update(f.a, { passwordMessage: 'x'.repeat(1_001) }))[0]?.[1],
    ).toBe('TOO_LONG');
    const opened = unwrap(await f.preferences.update(f.a, { passwordEnabled: false }));
    expect(opened).toMatchObject({ passwordEnabled: false, password: 'chand-raat' });
    expect((await f.outbox()).map((event) => event.payload)).toEqual([
      { changed: ['passwordEnabled', 'password', 'passwordMessage'] },
      { changed: ['password'] },
      { changed: ['passwordEnabled'] },
    ]);
    // Another shop's storefront stays open.
    expect(await f.preferences.get(f.b)).toMatchObject({ passwordEnabled: false, password: null });
  });
});
