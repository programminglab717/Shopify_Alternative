import 'reflect-metadata';
import { testDatabaseServer } from '@hatti/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { THEME_LIMITS } from './theme-files.js';
import { errorsOf, onlineStoreFixture, unwrap, type OnlineStoreFixture } from './test-support.js';

const server = testDatabaseServer();

const settings = (accent: string) => JSON.stringify({ current: { color_accent: accent } });
const INDEX = JSON.stringify({
  sections: { banner: { type: 'image-banner' } },
  order: ['banner'],
});

describe.skipIf(!server)("A theme's versions (OS-03, ADR-694)", () => {
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

  const bodies = async (themeId: string) =>
    Object.fromEntries(
      (await f.themes.files(f.a, themeId)).map((file) => [file.filename, file.body]),
    );

  it('keeps each change and takes the theme back to a version, which can be undone too', async () => {
    const main = await f.themes.main(f.a);
    const save = async (files: { filename: string; body: string }[]) =>
      unwrap(await f.themes.upsertFiles(f.a, main.id, files)).theme.version;
    const eid = await save([{ filename: 'config/settings_data.json', body: settings('#B45309') }]);
    const withHome = await save([{ filename: 'templates/index.json', body: INDEX }]);
    await save([{ filename: 'config/settings_data.json', body: settings('#0F766E') }]);
    unwrap(await f.themes.deleteFiles(f.a, main.id, ['templates/index.json']));
    expect(
      (await f.themes.versions(f.a, main.id)).map((each) => [
        each.version,
        each.changed,
        each.cause,
      ]),
    ).toEqual([
      [5, ['templates/index.json'], 'deleted'],
      [4, ['config/settings_data.json'], 'saved'],
      [3, ['templates/index.json'], 'saved'],
      [2, ['config/settings_data.json'], 'saved'],
    ]);

    // Back to the version with the home page and the first accent: the changes since undone.
    await f.admin.query('DELETE FROM platform.outbox_events');
    const back = unwrap(await f.themes.rollback(f.a, main.id, withHome));
    expect(back.version).toBe(6);
    expect(await bodies(main.id)).toEqual({
      'config/settings_data.json': settings('#B45309'),
      'templates/index.json': INDEX,
    });
    const events = (await f.outbox()).map((event) => [event.event_type, event.payload]);
    expect(events).toEqual([
      [
        'theme.updated',
        {
          changed: ['config/settings_data.json', 'templates/index.json'],
          role: 'main',
          version: 6,
        },
      ],
    ]);
    // Back to the first: the home page is the platform theme's again.
    unwrap(await f.themes.rollback(f.a, main.id, eid));
    expect(await bodies(main.id)).toEqual({ 'config/settings_data.json': settings('#B45309') });
    // And the taking back undone.
    unwrap(await f.themes.rollback(f.a, main.id, 6));
    expect(await bodies(main.id)).toEqual({
      'config/settings_data.json': settings('#B45309'),
      'templates/index.json': INDEX,
    });
    expect((await f.themes.versions(f.a, main.id)).slice(0, 2).map((each) => each.cause)).toEqual([
      'rolled_back',
      'rolled_back',
    ]);

    // Not a version it keeps, the version it is at, or another shop's theme.
    expect(errorsOf(await f.themes.rollback(f.a, main.id, 1))).toEqual([
      ['version', 'NOT_FOUND', 'The theme keeps no such version'],
    ]);
    expect(errorsOf(await f.themes.rollback(f.a, main.id, 8))).toEqual([
      ['version', 'INVALID', 'The theme is at this version already'],
    ]);
    expect(errorsOf(await f.themes.rollback(f.b, main.id, eid))).toEqual([
      ['id', 'NOT_FOUND', 'Theme not found'],
    ]);
  });

  it('keeps the last 30 changes of a theme, and its own', async () => {
    const main = await f.themes.main(f.a);
    for (let at = 0; at < THEME_LIMITS.versions + 2; at += 1) {
      const accent = `#${String(at).padStart(6, '0')}`;
      unwrap(
        await f.themes.upsertFiles(f.a, main.id, [
          { filename: 'config/settings_data.json', body: settings(accent) },
        ]),
      );
    }
    const kept = await f.themes.versions(f.a, main.id);
    expect(kept).toHaveLength(THEME_LIMITS.versions);
    expect([kept[0]!.version, kept.at(-1)!.version]).toEqual([33, 4]);
    // The oldest kept is the furthest back it goes.
    unwrap(await f.themes.rollback(f.a, main.id, 4));
    expect(await bodies(main.id)).toEqual({ 'config/settings_data.json': settings('#000002') });
    expect(await f.themes.versions(f.b, main.id)).toEqual([]);
  });
});
