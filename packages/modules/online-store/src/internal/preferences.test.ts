import 'reflect-metadata';
import { VariantService } from '@hatti/catalog/public';
import { checkPassword } from '@hatti/crypto';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shopPreferencesOf } from './preferences.service.js';
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
    robotsTxtRules: '',
    linkPage: { bio: '', links: [], productIds: [], variantIds: [] },
    seo: { title: null, description: null },
    sharingImage: null,
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
      robotsTxtRules: '',
      linkPage: { bio: '', links: [], productIds: [], variantIds: [] },
      seo: { title: null, description: null },
      sharingImage: null,
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

  it("keeps rules for the shop's robots.txt as crawlers read them, or says which lines are not", async () => {
    const kept = unwrap(
      await f.preferences.update(f.a, {
        robotsTxtRules: 'disallow: /collections/sale\n\nUser-agent: GPTBot\nDisallow: /',
      }),
    );
    expect(kept.robotsTxtRules).toBe(
      'Disallow: /collections/sale\n\nUser-agent: GPTBot\nDisallow: /',
    );
    expect(
      errorsOf(await f.preferences.update(f.a, { robotsTxtRules: 'Disallow: /cart\nNoindex: /x' })),
    ).toEqual([
      [
        'robotsTxtRules',
        'INVALID',
        "Line 2 isn't a rule crawlers read: use User-agent, Allow, Disallow, Crawl-delay or " +
          'Sitemap, then a colon and its value',
      ],
    ]);
    expect(
      errorsOf(
        await f.preferences.update(f.a, { robotsTxtRules: 'Disallow: /x\n'.repeat(201) }),
      )[0]?.[1],
    ).toBe('TOO_LONG');
    // Blank takes them away.
    expect(unwrap(await f.preferences.update(f.a, { robotsTxtRules: '' })).robotsTxtRules).toBe('');
    expect((await f.outbox()).map((event) => event.payload)).toEqual([
      { changed: ['robotsTxtRules'] },
      { changed: ['robotsTxtRules'] },
    ]);
  });

  it("keeps the shop's link page, its links checked and its products the shop's (ADR-161)", async () => {
    const lawn = unwrap(
      await f.products.create(f.a, {
        title: 'Lawn Suit',
        status: 'active',
        variants: [{ price: '4,990' }],
      }),
    );
    const shawl = unwrap(await f.products.create(f.a, { title: 'Pashmina Shawl' }));
    const theirs = unwrap(await f.products.create(f.b, { title: 'Their Khussa' }));
    const kept = unwrap(
      await f.preferences.update(f.a, {
        linkPage: {
          bio: '  Lawn and shawls.\r\nCash on delivery.  ',
          links: [
            { title: ' Eid Edit ', url: ' /collections/eid-edit ' },
            { title: 'Instagram', url: 'https://www.instagram.com/zari.pk' },
          ],
          // Once each, in their order.
          productIds: [shawl.id, lawn.id, shawl.id],
        },
      }),
    );
    expect(kept.linkPage).toEqual({
      bio: 'Lawn and shawls.\nCash on delivery.',
      links: [
        { title: 'Eid Edit', url: '/collections/eid-edit' },
        { title: 'Instagram', url: 'https://www.instagram.com/zari.pk' },
      ],
      productIds: [shawl.id, lawn.id],
      variantIds: [null, null],
    });
    // A part given replaces what it had; those not given stay as they are.
    expect(unwrap(await f.preferences.update(f.a, { linkPage: { bio: '' } })).linkPage).toEqual({
      ...kept.linkPage,
      bio: '',
    });

    const sentence =
      'Link must be a path on the store, like /collections/sale, or an https:// address';
    expect(
      errorsOf(
        await f.preferences.update(f.a, {
          linkPage: {
            bio: 'x'.repeat(301),
            links: [
              { title: '', url: '/pages/about-us' },
              { title: 'Old site', url: 'http://zari.pk' },
              { title: 'Script', url: 'javascript:alert(1)' },
              { title: 'Elsewhere', url: '//elsewhere.example' },
              { title: 'Spaced', url: '/collections/eid edit' },
            ],
          },
        }),
      ),
    ).toEqual([
      ['linkPage.bio', 'TOO_LONG', 'Bio is too long (maximum is 300 characters)'],
      ['linkPage.links.0.title', 'BLANK', "Title can't be blank"],
      ['linkPage.links.1.url', 'INVALID', sentence],
      ['linkPage.links.2.url', 'INVALID', sentence],
      ['linkPage.links.3.url', 'INVALID', sentence],
      ['linkPage.links.4.url', 'INVALID', sentence],
    ]);
    const many = Array.from({ length: 11 }, (_, index) => ({ title: `${index}`, url: '/' }));
    expect(errorsOf(await f.preferences.update(f.a, { linkPage: { links: many } }))).toEqual([
      ['linkPage.links', 'TOO_LONG', 'A link page takes 10 links at most'],
    ]);
    // Another shop's products, and those there are not, are not its to show.
    expect(
      errorsOf(
        await f.preferences.update(f.a, {
          linkPage: { productIds: [lawn.id, theirs.id, '00000000-0000-4000-8000-000000000000'] },
        }),
      ),
    ).toEqual([
      ['linkPage.productIds.1', 'NOT_FOUND', 'Product not found'],
      ['linkPage.productIds.2', 'NOT_FOUND', 'Product not found'],
    ]);

    // A product deleted since is left out, and goes with the next change.
    unwrap(await f.products.delete(f.a, shawl.id));
    expect((await f.preferences.get(f.a)).linkPage.productIds).toEqual([lawn.id]);
    const after = unwrap(await f.preferences.update(f.a, { whatsappNumber: '0300 1234567' }));
    expect(after.linkPage.productIds).toEqual([lawn.id]);
    const read = await f.db.tenant(f.a.shopId, (tx) => f.preferences.preferencesOf(tx, f.a.shopId));
    expect(read.linkPage.productIds).toEqual([lawn.id]);
    const updates = (await f.outbox()).filter(
      (event) => event.event_type === 'online_store_preferences.updated',
    );
    expect(updates.map((event) => event.payload)).toEqual([
      { changed: ['linkPage'] },
      { changed: ['linkPage'] },
      { changed: ['whatsappNumber'] },
    ]);
    // Another shop's is its own.
    expect((await f.preferences.get(f.b)).linkPage).toEqual(OPEN.linkPage);
  });

  it("keeps a variant chosen of each of the link page's products, the product's own (ADR-206)", async () => {
    const suit = unwrap(
      await f.products.create(f.a, {
        title: 'Lawn Suit',
        status: 'active',
        options: [{ name: 'Size', values: ['M', 'L', 'XL'] }],
        variants: [
          { optionValues: ['M'], price: '4,990' },
          { optionValues: ['L'], price: '5,190' },
          { optionValues: ['XL'], price: '5,390' },
        ],
      }),
    );
    const [m, l] = suit.variants.map((variant) => variant.id) as [string, string, string];
    const shawl = unwrap(
      await f.products.create(f.a, { title: 'Pashmina Shawl', variants: [{ price: '12,500' }] }),
    );
    const kept = unwrap(
      await f.preferences.update(f.a, {
        linkPage: {
          // A product twice with two of its variants; the same one twice, once.
          products: [
            { productId: suit.id, variantId: m },
            { productId: suit.id, variantId: l },
            { productId: shawl.id },
            { productId: suit.id, variantId: m },
          ],
        },
      }),
    );
    expect(kept.linkPage).toMatchObject({
      productIds: [suit.id, suit.id, shawl.id],
      variantIds: [m, l, null],
    });
    expect((await f.preferences.get(f.a)).linkPage.variantIds).toEqual([m, l, null]);

    // The product's own variants alone, products the shop's, and one way of giving them.
    expect(
      errorsOf(
        await f.preferences.update(f.a, {
          linkPage: {
            products: [
              { productId: shawl.id, variantId: m },
              { productId: '00000000-0000-4000-8000-000000000000', variantId: m },
            ],
          },
        }),
      ),
    ).toEqual([
      ['linkPage.products.0.variantId', 'NOT_FOUND', 'Variant not found on this product'],
      ['linkPage.products.1.productId', 'NOT_FOUND', 'Product not found'],
    ]);
    expect(
      errorsOf(
        await f.preferences.update(f.a, {
          linkPage: { productIds: [shawl.id], products: [{ productId: shawl.id }] },
        }),
      ),
    ).toEqual([['linkPage.products', 'INVALID', 'Give products or productIds, not both']]);

    // A variant deleted since is no longer chosen: the product stays in its place, once.
    unwrap(await new VariantService(f.db).bulkDelete(f.a, suit.id, [m]));
    expect((await f.preferences.get(f.a)).linkPage).toMatchObject({
      productIds: [suit.id, suit.id, shawl.id],
      variantIds: [null, l, null],
    });
    unwrap(
      await f.preferences.update(f.a, {
        linkPage: { products: [{ productId: suit.id, variantId: l }, { productId: suit.id }] },
      }),
    );
    unwrap(await new VariantService(f.db).bulkDelete(f.a, suit.id, [l]));
    expect((await f.preferences.get(f.a)).linkPage).toMatchObject({
      productIds: [suit.id],
      variantIds: [null],
    });
    // Products given by their IDs alone have none chosen.
    const plain = unwrap(await f.preferences.update(f.a, { linkPage: { productIds: [shawl.id] } }));
    expect(plain.linkPage).toMatchObject({ productIds: [shawl.id], variantIds: [null] });
  });

  it("keeps its home page's title and description for search engines, and its sharing image (ADR-243)", async () => {
    const file = async (shopId: string, contentType: string) => {
      const id = newId();
      await f.admin.query(
        `INSERT INTO files.files (shop_id, id, key, filename, content_type, size, status)
         VALUES ($1, $2, $3, 'file', $4, 64, 'ready')`,
        [shopId, id, `shops/${shopId}/files/${id}/file`, contentType],
      );
      return id;
    };
    const photo = await file(f.a.shopId, 'image/png');
    const kept = unwrap(
      await f.preferences.update(f.a, {
        seo: {
          title: '  Zari Fashions |  Lawn in Lahore ',
          description: 'Lawn,\n bridal and khussas, delivered across Pakistan.',
        },
        sharingImage: { fileId: photo, altText: ' Three lawn suits ' },
      }),
    );
    expect(kept).toMatchObject({
      seo: {
        title: 'Zari Fashions | Lawn in Lahore',
        description: 'Lawn, bridal and khussas, delivered across Pakistan.',
      },
      sharingImage: { fileId: photo, altText: 'Three lawn suits' },
    });
    // Left out, each stays as it is; a blank description is cleared, its title kept.
    unwrap(await f.preferences.update(f.a, { whatsappNumber: '0300 1234567' }));
    expect(unwrap(await f.preferences.update(f.a, { seo: { description: ' ' } }))).toMatchObject({
      seo: { title: 'Zari Fashions | Lawn in Lahore', description: null },
      sharingImage: { fileId: photo },
    });

    // Not an image of the shop's that a page can show: another shop's, a PDF, nothing at all.
    const theirs = await file(f.b.shopId, 'image/png');
    const pdf = await file(f.a.shopId, 'application/pdf');
    for (const fileId of [theirs, pdf, 'nonsense']) {
      expect(errorsOf(await f.preferences.update(f.a, { sharingImage: { fileId } }))).toEqual([
        [
          'sharingImage.fileId',
          'NOT_FOUND',
          "No such image among the shop's files: a JPEG, PNG, WebP or GIF uploaded",
        ],
      ]);
    }
    expect(
      errorsOf(
        await f.preferences.update(f.a, {
          seo: { title: 't'.repeat(256) },
          sharingImage: { fileId: photo, altText: 'a'.repeat(513) },
        }),
      ),
    ).toEqual([
      ['seo.title', 'TOO_LONG', 'SEO title is too long (maximum is 255 characters)'],
      ['sharingImage.altText', 'TOO_LONG', 'Alt text is too long (maximum is 512 characters)'],
    ]);

    // As read models are given them; null takes both away.
    expect(await f.db.tenant(f.a.shopId, (tx) => shopPreferencesOf(tx, f.a.shopId))).toMatchObject({
      seo: { title: 'Zari Fashions | Lawn in Lahore', description: null },
      sharingImage: { fileId: photo, altText: 'Three lawn suits' },
    });
    expect(
      unwrap(await f.preferences.update(f.a, { seo: null, sharingImage: null })),
    ).toMatchObject({ seo: { title: null, description: null }, sharingImage: null });
    expect(
      (await f.outbox())
        .filter((event) => event.event_type === 'online_store_preferences.updated')
        .map((event) => event.payload),
    ).toEqual([
      { changed: ['seo', 'sharingImage'] },
      { changed: ['whatsappNumber'] },
      { changed: ['seo'] },
      { changed: ['seo', 'sharingImage'] },
    ]);
    // Another shop's are its own.
    expect(await f.preferences.get(f.b)).toMatchObject({
      seo: { title: null, description: null },
      sharingImage: null,
    });
  });
});
