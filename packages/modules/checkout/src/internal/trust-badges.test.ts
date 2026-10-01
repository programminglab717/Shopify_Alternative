import 'reflect-metadata';
import { InputChecker } from '@hatti/api';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from './cart-lines.js';
import { checkoutPage } from './checkout-pages.js';
import { checkoutFixture, unwrap, type CheckoutFixture } from './test-support.js';
import { checkTrustBadges, type TrustBadgeInput } from './trust-badges.js';

const server = testDatabaseServer();

describe('checkTrustBadges', () => {
  /** The badges `inputs` give; or their errors, as [field, code, message]. */
  function badges(inputs: TrustBadgeInput[]) {
    const check = new InputChecker();
    const checked = checkTrustBadges(check, ['badges'], inputs);
    return (
      checked ?? check.errors.map((error) => [error.field.join('.'), error.code, error.message])
    );
  }

  it('takes up to four from the set, each once, days for an exchange or returns alone', () => {
    expect(
      badges([
        { kind: 'exchange', days: 7 },
        { kind: 'cash_on_delivery' },
        { kind: 'original', days: null },
      ]),
    ).toEqual([
      { kind: 'exchange', days: 7 },
      { kind: 'cash_on_delivery', days: null },
      { kind: 'original', days: null },
    ]);
    expect(badges([])).toEqual([]);
    expect(
      badges([
        { kind: 'returns' },
        { kind: 'original', days: 3 },
        { kind: 'exchange', days: 91 },
        { kind: 'returns', days: 7 },
      ]),
    ).toEqual([
      ['badges.0.days', 'BLANK', 'Say within how many days, such as 7'],
      ['badges.1.days', 'INVALID', 'Only an exchange or returns badge takes a number of days'],
      ['badges.2.days', 'INVALID', 'Days must be a whole number from 1 to 90'],
      ['badges.3.kind', 'INVALID', 'Each badge once'],
    ]);
    expect(
      badges([
        { kind: 'original' },
        { kind: 'cash_on_delivery' },
        { kind: 'open_parcel' },
        { kind: 'whatsapp' },
        { kind: 'exchange', days: 7 },
      ]),
    ).toEqual([['badges', 'TOO_MANY', 'At most 4 badges']]);
  });
});

describe.skipIf(!server)('Trust badges on the checkout', () => {
  let f: CheckoutFixture;

  beforeAll(async () => {
    f = await checkoutFixture(server!);
  });

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  const giveWhatsapp = (shopId: string) =>
    f.admin.query(
      `INSERT INTO online_store.preferences (shop_id, whatsapp) VALUES ($1, '+923001234567')`,
      [shopId],
    );

  it("keeps the shop's badges in its order, and records each change", async () => {
    expect(await f.badges.get(f.a)).toEqual([]);
    // Help on WhatsApp needs the shop's number.
    const refused = await f.badges.update(f.a, [{ kind: 'original' }, { kind: 'whatsapp' }]);
    expect(refused.ok ? [] : refused.errors).toEqual([
      {
        field: ['badges', '1', 'kind'],
        code: 'INVALID',
        message:
          "Help on WhatsApp needs the shop's WhatsApp number: set it in the online store's " +
          'preferences first',
      },
    ]);
    await giveWhatsapp(f.a.shopId);
    await f.admin.query('DELETE FROM platform.outbox_events');
    const chosen = [
      { kind: 'exchange', days: 7 },
      { kind: 'whatsapp', days: null },
      { kind: 'original', days: null },
    ] as const;
    expect(unwrap(await f.badges.update(f.a, [...chosen]))).toEqual(chosen);
    expect(await f.badges.get(f.a)).toEqual(chosen);
    // The same again changes nothing; another order, or none, does.
    unwrap(await f.badges.update(f.a, [...chosen]));
    unwrap(await f.badges.update(f.a, [chosen[2], chosen[0]]));
    unwrap(await f.badges.update(f.a, []));
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'trust_badges.updated')
        .map((event) => event.payload),
    ).toEqual([
      { badges: ['exchange', 'whatsapp', 'original'] },
      { badges: ['original', 'exchange'] },
      { badges: [] },
    ]);
    expect(await f.badges.get(f.b)).toEqual([]);
  });

  it("shows them on the checkout's page, with the shop's WhatsApp number", async () => {
    await giveWhatsapp(f.a.shopId);
    unwrap(
      await f.badges.update(f.a, [
        { kind: 'cash_on_delivery' },
        { kind: 'returns', days: 14 },
        { kind: 'whatsapp' },
      ]),
    );
    const [kurta] = await f.variantsOf(f.a, 'Kurta', { price: '2,000' });
    await f.stock(f.a, kurta!, 5);
    const action = parseAction('add', { items: [{ variantId: kurta, quantity: 1 }] });
    if ('code' in action) throw new Error('Refused');
    const added = await f.carts.act(f.a.shopId, null, action);
    if (!added.ok) throw new Error('Refused');
    const secret = (await f.checkouts.start(f.a.shopId, added.token!))!;
    const view = await f.checkouts.view(secret);
    if (view.kind !== 'open') throw new Error(`Expected an open checkout, got ${view.kind}`);
    expect(view.shop).toMatchObject({
      badges: [
        { kind: 'cash_on_delivery', days: null },
        { kind: 'returns', days: 14 },
        { kind: 'whatsapp', days: null },
      ],
      whatsapp: '+923001234567',
    });
    const page = checkoutPage(view).html;
    expect(page).toContain('<span lang="en">14-day returns</span>');
    expect(page).toContain('href="https://wa.me/923001234567"');
    // Without WhatsApp among them, the page does without the number.
    unwrap(await f.badges.update(f.a, [{ kind: 'original' }]));
    const later = await f.checkouts.view(secret);
    expect(later.kind === 'open' && later.shop.whatsapp).toBeNull();
  });
});
