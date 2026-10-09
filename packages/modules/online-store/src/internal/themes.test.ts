import 'reflect-metadata';
import { StorefrontSite } from '@hatti/api';
import { SecretBox } from '@hatti/crypto';
import { testDatabaseServer } from '@hatti/db/testing';
import { newId } from '@hatti/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { themeFiles, themes } from './schema.js';
import { THEME_LIMITS } from './theme-files.js';
import { ThemePreviewService } from './theme-preview.js';
import { shopAccentOf } from './theme.service.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';

const server = testDatabaseServer();

/** A home page with a featured collection, as a shop would save it. */
const INDEX = JSON.stringify({
  sections: {
    featured: {
      type: 'featured-collection',
      settings: { title: 'Eid edit', collection: 'eid-edit', products_to_show: 4 },
    },
    banner: {
      type: 'image-banner',
      blocks: { heading: { type: 'heading', settings: { heading: 'Hatti Demo Bazaar' } } },
      block_order: ['heading'],
    },
  },
  order: ['banner', 'featured'],
});

const SETTINGS = JSON.stringify({ current: { color_accent: '#B45309' } });

describe.skipIf(!server)('ThemeService', () => {
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

  const events = async () =>
    (await f.outbox()).map((event) => [event.event_type, event.payload] as const);

  it('matches the migrated tables', async () => {
    // Drizzle names every column, so a mismatch with the SQL migrations fails here.
    await f.db.tenant(f.a.shopId, async (tx) => {
      for (const table of [themes, themeFiles]) await tx.select().from(table).limit(1);
    });
  });

  it('makes the main theme on first use, once, on the platform theme', async () => {
    const [first, second, third] = await Promise.all([
      f.themes.main(f.a),
      f.themes.main(f.a),
      f.themes.main(f.a),
    ]);
    expect(first).toMatchObject({
      name: 'Hatti Base',
      base: 'hatti-base',
      role: 'main',
      version: 1,
    });
    expect(new Set([first.id, second.id, third.id]).size).toBe(1);
    expect(await events()).toEqual([['theme.created', { name: 'Hatti Base', base: 'hatti-base' }]]);
    expect(await f.themes.files(f.a, first.id)).toEqual([]);
    // Read models see no theme until the shop has touched its themes.
    expect(await f.db.tenant(f.b.shopId, (tx) => f.themes.mainOf(tx, f.b.shopId))).toBeNull();
  });

  it("saves a shop's files, all or none, raising the theme's version each time", async () => {
    const main = await f.themes.main(f.a);
    await f.admin.query('DELETE FROM platform.outbox_events');
    const saved = unwrap(
      await f.themes.upsertFiles(f.a, main.id, [
        { filename: 'templates/index.json', body: INDEX },
        { filename: 'config/settings_data.json', body: SETTINGS },
      ]),
    );
    expect(saved.theme).toMatchObject({ id: main.id, version: 2 });
    expect(saved.files.map((file) => file.filename)).toEqual([
      'config/settings_data.json',
      'templates/index.json',
    ]);
    const changed = JSON.stringify({ current: { color_accent: '#0F766E' } });
    unwrap(
      await f.themes.upsertFiles(f.a, main.id, [
        { filename: 'config/settings_data.json', body: changed },
      ]),
    );
    expect(await events()).toEqual([
      [
        'theme.updated',
        {
          changed: ['config/settings_data.json', 'templates/index.json'],
          role: 'main',
          version: 2,
        },
      ],
      ['theme.updated', { changed: ['config/settings_data.json'], role: 'main', version: 3 }],
    ]);
    const files = await f.themes.files(f.a, main.id, ['config/settings_data.json', 'missing']);
    expect(files.map((file) => file.body)).toEqual([changed]);

    // A batch with one bad file saves nothing.
    expect(
      errorsOf(
        await f.themes.upsertFiles(f.a, main.id, [
          { filename: 'templates/product.json', body: INDEX },
          { filename: 'templates/collection.json', body: '{' },
        ]),
      ).map(([field, code]) => [field, code]),
    ).toEqual([['files.1.body', 'INVALID']]);
    expect((await f.themes.get(f.a, main.id))?.version).toBe(3);
    expect((await f.themes.files(f.a, main.id)).map((file) => file.filename)).toEqual([
      'config/settings_data.json',
      'templates/index.json',
    ]);
  });

  it('keeps only JSON the storefront can read, and says what is wrong', async () => {
    const main = await f.themes.main(f.a);
    const refused = async (filename: string, body: string) => {
      const [error] = errorsOf(await f.themes.upsertFiles(f.a, main.id, [{ filename, body }]));
      return error;
    };
    for (const filename of [
      'layout/theme.liquid',
      'sections/header.liquid',
      'assets/base.css',
      'locales/ur.json',
      'templates/../index.json',
      'templates/Index.json',
    ]) {
      expect(await refused(filename, INDEX), filename).toEqual([
        'files.0.filename',
        'INVALID',
        expect.stringContaining("isn't a file a theme can keep"),
      ]);
    }
    const sections = (value: unknown) => JSON.stringify({ sections: value, order: ['a'] });
    const cases: [string, string, string][] = [
      ['templates/index.json', '{', "isn't JSON"],
      ['templates/index.json', '[]', 'must be a JSON object'],
      ['templates/index.json', '{"sections":{}}', 'needs "sections" and "order"'],
      [
        'templates/index.json',
        JSON.stringify({ sections: {}, order: ['a'] }),
        '"order" names "a", which is not in "sections"',
      ],
      [
        'sections/header-group.json',
        JSON.stringify({ sections: { a: { type: 'header' } }, order: ['a', 'a'] }),
        '"order" must list section IDs once each',
      ],
      ['templates/index.json', sections({ a: {} }), 'section "a" needs a "type"'],
      [
        'templates/index.json',
        JSON.stringify({ sections: { 'a"><b': { type: 'banner' } }, order: ['a"><b'] }),
        'section ID "a"><b" may have only letters, digits, "_" and "-"',
      ],
      [
        'templates/index.json',
        sections({ a: { type: 'banner', blocks: { 'h b': { type: 'heading' } } } }),
        'section "a" block ID "h b" may have only letters, digits, "_" and "-"',
      ],
      ['templates/index.json', sections({ a: { type: '../x' } }), 'section "a" needs a "type"'],
      [
        'templates/index.json',
        sections({ a: { type: 'banner', blocks: [] } }),
        'section "a" "blocks" must be an object',
      ],
      [
        'templates/index.json',
        sections({ a: { type: 'banner', blocks: { h: {} } } }),
        'section "a" block "h" needs a "type"',
      ],
      [
        'templates/index.json',
        sections({ a: { type: 'banner', blocks: { h: { type: 'heading' } }, block_order: ['x'] } }),
        'section "a" "block_order" must list its block IDs',
      ],
      [
        'templates/index.json',
        JSON.stringify({ sections: { a: { type: 'banner' } }, order: ['a'], layout: '../x' }),
        '"layout" must name a layout, or be false',
      ],
      [
        'templates/index.json',
        JSON.stringify({
          sections: Object.fromEntries(
            Array.from({ length: 26 }, (_, i) => [`s${i}`, { type: 'banner' }]),
          ),
          order: Array.from({ length: 26 }, (_, i) => `s${i}`),
        }),
        'has more than 25 sections',
      ],
      [
        'config/settings_data.json',
        JSON.stringify({ current: 'Eid', presets: {} }),
        '"current" names the preset "Eid", which "presets" does not have',
      ],
      ['config/settings_data.json', JSON.stringify({ current: 3 }), '"current" must be an object'],
      [
        'templates/index.json',
        JSON.stringify({ sections: {}, order: [], note: 'x'.repeat(THEME_LIMITS.fileBytes) }),
        'larger than 256 KB',
      ],
    ];
    for (const [filename, body, message] of cases) {
      expect(await refused(filename, body), message).toEqual([
        'files.0.body',
        expect.any(String),
        expect.stringContaining(message),
      ]);
    }
    // A template may name an alternate for some products, and turn its layout off.
    unwrap(
      await f.themes.upsertFiles(f.a, main.id, [
        {
          filename: 'templates/product.unstitched.json',
          body: JSON.stringify({ sections: {}, order: [], layout: false }),
        },
      ]),
    );
    expect(
      errorsOf(
        await f.themes.upsertFiles(f.a, main.id, [
          { filename: 'templates/index.json', body: INDEX },
          { filename: 'templates/index.json', body: INDEX },
        ]),
      ).map(([field, code]) => [field, code]),
    ).toEqual([['files.1.filename', 'INVALID']]);
    expect(errorsOf(await f.themes.upsertFiles(f.a, main.id, []))[0]?.slice(0, 2)).toEqual([
      'files',
      'BLANK',
    ]);
  });

  it('checks files against the platform theme, as the storefront would read them', async () => {
    const main = await f.themes.main(f.a);
    const refused = await f.themes.upsertFiles(f.a, main.id, [
      {
        filename: 'templates/index.json',
        body: JSON.stringify({ sections: { x: { type: 'reviews' } }, order: ['x'] }),
      },
      {
        filename: 'config/settings_data.json',
        body: JSON.stringify({ current: { color_accent: 'red', page_width: 99_999 } }),
      },
    ]);
    expect(errorsOf(refused)).toEqual([
      [
        'files.0.body',
        'INVALID',
        'templates/index.json: section "x" is a "reviews", which the theme does not have',
      ],
      [
        'files.1.body',
        'INVALID',
        `config/settings_data.json: the theme's "color_accent" must be a colour, such as #0F766E`,
      ],
      [
        'files.1.body',
        'INVALID',
        `config/settings_data.json: the theme's "page_width" must be a number from 1000 to 1600`,
      ],
    ]);
    // None of them is saved.
    expect(await f.themes.files(f.a, main.id)).toEqual([]);
  });

  it("deletes a shop's files, so the platform theme's show again", async () => {
    const main = await f.themes.main(f.a);
    unwrap(
      await f.themes.upsertFiles(f.a, main.id, [
        { filename: 'templates/index.json', body: INDEX },
        { filename: 'config/settings_data.json', body: SETTINGS },
      ]),
    );
    await f.admin.query('DELETE FROM platform.outbox_events');
    const deleted = unwrap(
      await f.themes.deleteFiles(f.a, main.id, ['templates/index.json', 'templates/missing.json']),
    );
    expect(deleted).toMatchObject({ theme: { version: 3 }, deleted: ['templates/index.json'] });
    // Deleting what is not there changes nothing.
    const none = unwrap(await f.themes.deleteFiles(f.a, main.id, ['templates/index.json']));
    expect(none).toMatchObject({ theme: { version: 3 }, deleted: [] });
    expect(await events()).toEqual([
      ['theme.updated', { changed: ['templates/index.json'], role: 'main', version: 3 }],
    ]);
  });

  it("gives the editor the platform theme's schemas, and the theme's files as the storefront reads them", async () => {
    const main = await f.themes.main(f.a);
    const editor = () => f.themes.editor(f.a, main.id, 'hatti-base', 'ur');
    const fileOf = async (filename: string) =>
      (await editor()).files.find((file) => file.filename === filename);

    const fresh = await editor();
    expect(fresh.files.map((file) => file.filename)).toEqual(
      expect.arrayContaining([
        'config/settings_data.json',
        'sections/footer-group.json',
        'sections/header-group.json',
        'templates/index.json',
        'templates/product.json',
      ]),
    );
    expect(fresh.files.every((file) => !file.own && file.problems.length === 0)).toBe(true);
    expect(fresh.files.map((file) => file.filename)).not.toContain('config/settings_schema.json');
    expect(JSON.parse((await fileOf('templates/index.json'))!.body)).toMatchObject({
      order: expect.arrayContaining(['banner']),
    });
    // Its words in the language asked for.
    expect(fresh.sections.find((each) => each.type === 'image-banner')?.schema.name).toBe(
      'تصویری بینر',
    );
    expect(fresh.settingsSchema).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'رنگ' })]),
    );

    // The shop's own over the platform theme's, an alternate template of its own among them.
    const unstitched = JSON.stringify({
      sections: { main: { type: 'main-product' } },
      order: ['main'],
    });
    unwrap(
      await f.themes.upsertFiles(f.a, main.id, [
        { filename: 'templates/index.json', body: INDEX },
        { filename: 'templates/product.unstitched.json', body: unstitched },
      ]),
    );
    expect(await fileOf('templates/index.json')).toEqual({
      filename: 'templates/index.json',
      body: INDEX,
      own: true,
      problems: [],
    });
    expect(await fileOf('templates/product.unstitched.json')).toMatchObject({ own: true });

    // One saved before the platform theme changed is said to be left out, and why.
    await f.admin.query(
      `UPDATE online_store.theme_files SET body = $1 WHERE theme_id = $2 AND filename = $3`,
      [
        JSON.stringify({ sections: { x: { type: 'reviews' } }, order: ['x'] }),
        main.id,
        'templates/index.json',
      ],
    );
    expect((await fileOf('templates/index.json'))?.problems).toEqual([
      'section "x" is a "reviews", which the theme does not have',
    ]);
  });

  it('prepares a copy, publishes it in place of the main theme, and deletes the one before', async () => {
    const main = await f.themes.main(f.a);
    unwrap(
      await f.themes.upsertFiles(f.a, main.id, [{ filename: 'templates/index.json', body: INDEX }]),
    );
    const eid = unwrap(await f.themes.create(f.a, { name: '  Eid look ', copyFrom: main.id }));
    expect(eid).toMatchObject({ name: 'Eid look', role: 'unpublished', version: 1 });
    expect((await f.themes.files(f.a, eid.id)).map((file) => file.body)).toEqual([INDEX]);
    expect((await f.themes.list(f.a, { first: 10 })).items.map((theme) => theme.id)).toEqual([
      main.id,
      eid.id,
    ]);
    await f.admin.query('DELETE FROM platform.outbox_events');

    const published = unwrap(await f.themes.publish(f.a, eid.id));
    expect(published).toMatchObject({ id: eid.id, role: 'main', version: 2 });
    expect((await f.themes.get(f.a, main.id))?.role).toBe('unpublished');
    expect(await events()).toEqual([['theme.published', { previousId: main.id, version: 2 }]]);
    expect(
      (await f.themes.list(f.a, { first: 10, roles: ['unpublished'] })).items.map((t) => t.id),
    ).toEqual([main.id]);

    expect(errorsOf(await f.themes.delete(f.a, eid.id))[0]?.slice(0, 2)).toEqual(['id', 'INVALID']);
    expect(unwrap(await f.themes.delete(f.a, main.id))).toEqual({ id: main.id });
    expect(await f.themes.get(f.a, main.id)).toBeNull();
    const { rows } = await f.admin.query('SELECT count(*)::int AS n FROM online_store.theme_files');
    expect(rows[0].n).toBe(1);

    expect(
      errorsOf(await f.themes.create(f.a, { name: 'Copy', copyFrom: newId() }))[0]?.slice(0, 2),
    ).toEqual(['copyFrom', 'NOT_FOUND']);
    for (let n = 1; n < THEME_LIMITS.themes; n++) {
      unwrap(await f.themes.create(f.a, { name: `Draft ${n}` }));
    }
    expect(errorsOf(await f.themes.create(f.a, { name: 'One too many' }))[0]?.[1]).toBe('TOO_MANY');
  });

  it('gives read models the main theme with its files', async () => {
    const main = await f.themes.main(f.a);
    unwrap(
      await f.themes.upsertFiles(f.a, main.id, [{ filename: 'templates/index.json', body: INDEX }]),
    );
    const found = await f.db.tenant(f.a.shopId, (tx) => f.themes.mainOf(tx, f.a.shopId));
    expect(found?.theme).toMatchObject({ id: main.id, version: 2 });
    expect(found?.files.map((file) => file.filename)).toEqual(['templates/index.json']);
  });

  it("gives the shop's accent colour from its main theme, as set or by a preset", async () => {
    const accentOf = (shopId: string) => f.db.tenant(shopId, (tx) => shopAccentOf(tx, shopId));
    // Left to the platform's until the theme sets it.
    expect(await accentOf(f.a.shopId)).toBeNull();
    const main = await f.themes.main(f.a);
    const settings = (body: unknown) =>
      f.themes.upsertFiles(f.a, main.id, [
        { filename: 'config/settings_data.json', body: JSON.stringify(body) },
      ]);
    unwrap(await settings({ current: { color_accent: '#B45309' } }));
    expect(await accentOf(f.a.shopId)).toBe('#B45309');
    unwrap(await settings({ current: 'Eid', presets: { Eid: { color_accent: '#7C3AED' } } }));
    expect(await accentOf(f.a.shopId)).toBe('#7C3AED');
    // A colour the page cannot judge, given in rgb() or with transparency, leaves it.
    unwrap(await settings({ current: { color_accent: 'rgb(180, 83, 9)' } }));
    expect(await accentOf(f.a.shopId)).toBeNull();
    // Only the published theme's, and only the shop's own.
    unwrap(await settings({ current: { color_accent: '#B45309' } }));
    const draft = unwrap(await f.themes.create(f.a, { name: 'Draft' }));
    unwrap(
      await f.themes.upsertFiles(f.a, draft.id, [
        { filename: 'config/settings_data.json', body: SETTINGS.replace('B45309', '15803D') },
      ]),
    );
    expect(await accentOf(f.a.shopId)).toBe('#B45309');
    expect(await accentOf(f.b.shopId)).toBeNull();
  });

  it('links to a theme on the storefront, published or not, for its shop and 14 days', async () => {
    const k1 = { id: 'k1', key: Buffer.alloc(32, 7) };
    const site = new StorefrontSite('https://hatti.pk');
    const previews = new ThemePreviewService(f.db, f.themes, new SecretBox([k1]), site);
    const eid = unwrap(await f.themes.create(f.a, { name: 'Eid look' }));
    unwrap(
      await f.themes.upsertFiles(f.a, eid.id, [{ filename: 'templates/index.json', body: INDEX }]),
    );
    const now = new Date('2026-10-01T09:00:00Z');
    const { url, expiresAt } = await previews.link(f.a, eid.id, now);
    expect(expiresAt).toEqual(new Date('2026-10-15T09:00:00Z'));
    const { rows } = await f.admin.query('SELECT handle FROM control.shops WHERE id = $1', [
      f.a.shopId,
    ]);
    const link = new URL(url);
    expect([link.origin, link.pathname]).toEqual([`https://${rows[0].handle}.hatti.pk`, '/']);
    const token = link.searchParams.get('preview')!;

    const opened = await previews.open(f.a.shopId, token, now);
    expect(opened).toMatchObject({
      theme: { id: eid.id, name: 'Eid look', role: 'unpublished', version: eid.version + 1 },
      expiresAt,
    });
    expect(opened?.files.map((file) => file.filename)).toEqual(['templates/index.json']);
    // As saved when asked for: a change shows at once.
    unwrap(
      await f.themes.upsertFiles(f.a, eid.id, [
        { filename: 'config/settings_data.json', body: SETTINGS },
      ]),
    );
    expect((await previews.open(f.a.shopId, token, now))?.files).toHaveLength(2);

    // Not for another shop's storefront, nor once the link ends; nothing that is not ours.
    expect(await previews.open(f.b.shopId, token, now)).toBeNull();
    expect(await previews.open(f.a.shopId, token, expiresAt)).toBeNull();
    // A letter changed within the sealed claims: not the last, whose low bits may be padding.
    const at = token.lastIndexOf('.') + 1;
    const altered = `${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}`;
    expect(await previews.open(f.a.shopId, altered, now)).toBeNull();
    expect(await previews.open(f.a.shopId, 'v1.k1.nonsense.nonsense', now)).toBeNull();
    // The keys rotated: links sealed before still open.
    const k2 = { id: 'k2', key: Buffer.alloc(32, 8) };
    const rotated = new ThemePreviewService(f.db, f.themes, new SecretBox([k2, k1]), site);
    expect(await rotated.open(f.a.shopId, token, now)).not.toBeNull();
    // The theme deleted: its links show nothing.
    unwrap(await f.themes.delete(f.a, eid.id));
    expect(await previews.open(f.a.shopId, token, now)).toBeNull();
  });

  it("keeps each shop's themes to itself", async () => {
    const main = await f.themes.main(f.a);
    expect(await f.themes.get(f.b, main.id)).toBeNull();
    expect(await f.themes.files(f.b, main.id)).toEqual([]);
    const bad = [
      await f.themes.upsertFiles(f.b, main.id, [{ filename: 'templates/index.json', body: INDEX }]),
      await f.themes.deleteFiles(f.b, main.id, ['templates/index.json']),
      await f.themes.publish(f.b, main.id),
      await f.themes.delete(f.b, main.id),
      await f.themes.create(f.b, { name: 'Stolen', copyFrom: main.id }),
    ];
    for (const result of bad) expect(errorsOf(result)[0]?.[1]).toBe('NOT_FOUND');
    const own = (await f.themes.list(f.b, { first: 10 })).items;
    expect(own.map((theme) => theme.id)).not.toContain(main.id);
  });
});
