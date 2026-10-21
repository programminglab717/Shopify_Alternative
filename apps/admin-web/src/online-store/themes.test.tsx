import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { formatDateTime, localInput } from '../i18n/format';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const EARLIER = new Date(Date.now() - 3 * 86_400_000).toISOString();
const LATER = new Date(Date.now() - 3_600_000).toISOString();

function theme(id: string, name: string, role: 'MAIN' | 'UNPUBLISHED', updatedAt = EARLIER) {
  return {
    id,
    name,
    role,
    base: 'hatti-base',
    previewUrl: `https://zari.hatti.pk/?preview_theme_id=${id}`,
    publishAt: null as string | null,
    createdAt: EARLIER,
    updatedAt,
  };
}

/** A fake core with the shop's themes, which change as the page asks. */
function core(role: StaffRole) {
  let themes = [
    theme('th_2', 'Eid sale', 'UNPUBLISHED', LATER),
    theme('th_1', 'Hatti Base', 'MAIN'),
  ];
  let versions = [
    { version: 3, cause: 'SAVED', changedFiles: ['templates/index.json'], createdAt: LATER },
    {
      version: 2,
      cause: 'DELETED',
      changedFiles: ['sections/header.json', 'config/settings_data.json'],
      createdAt: EARLIER,
    },
    { version: 1, cause: 'SAVED', changedFiles: ['templates/index.json'], createdAt: EARLIER },
  ];
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Themes':
        return { themes: { nodes: themes } };
      case 'ThemeVersions':
        return {
          theme: {
            id: variables.id,
            version: versions[0]?.version ?? 0,
            versions: variables.id === 'th_2' ? versions : [],
          },
        };
      case 'ThemeRollback': {
        const to = versions.find((each) => each.version === variables.version)!;
        const undone = versions.filter((each) => each.version > to.version);
        versions = [
          {
            version: versions[0]!.version + 1,
            cause: 'ROLLED_BACK',
            changedFiles: [...new Set(undone.flatMap((each) => each.changedFiles))].sort(),
            createdAt: new Date().toISOString(),
          },
          ...versions,
        ];
        return { themeRollback: { theme: { id: variables.id, version: 4 }, userErrors: [] } };
      }
      case 'ThemeSchedulePublish': {
        const wanted = variables.publishAt as string | null;
        if (wanted && new Date(wanted).getTime() < Date.now() + 60_000) {
          return {
            themeSchedulePublish: {
              theme: null,
              userErrors: [
                {
                  field: ['publishAt'],
                  code: 'INVALID',
                  message: 'A theme is published a minute ahead at least',
                },
              ],
            },
          };
        }
        themes = themes.map((each) =>
          each.id === variables.id ? { ...each, publishAt: wanted } : each,
        );
        return {
          themeSchedulePublish: {
            theme: themes.find((each) => each.id === variables.id),
            userErrors: [],
          },
        };
      }
      case 'ThemeCreate': {
        if (variables.name === 'Eid sale') {
          return {
            themeCreate: {
              theme: null,
              userErrors: [
                { field: ['name'], code: 'TAKEN', message: 'is the name of another theme' },
              ],
            },
          };
        }
        const made = theme(
          'th_3',
          variables.name as string,
          'UNPUBLISHED',
          new Date().toISOString(),
        );
        themes = [...themes, made];
        return { themeCreate: { theme: made, userErrors: [] } };
      }
      case 'ThemePublish':
        themes = themes.map((each) => ({
          ...each,
          role: each.id === variables.id ? 'MAIN' : 'UNPUBLISHED',
        }));
        return {
          themePublish: { theme: themes.find((each) => each.id === variables.id), userErrors: [] },
        };
      case 'ThemePreviewLinksRevoke':
        themes = themes.map((each) =>
          each.id === variables.id
            ? { ...each, previewUrl: `https://zari.hatti.pk/?preview_theme_id=${each.id}&gen=2` }
            : each,
        );
        return {
          themePreviewLinksRevoke: {
            theme: themes.find((each) => each.id === variables.id),
            userErrors: [],
          },
        };
      case 'ThemeDelete':
        themes = themes.filter((each) => each.id !== variables.id);
        return { themeDelete: { deletedThemeId: variables.id, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

const rowOf = (name: string) =>
  within(screen.getByRole('list', { name: 'Themes' }))
    .getByText(name)
    .closest('li')!;

describe("The online store's themes", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the live theme first, each with its preview, and adds a copy after a refusal', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store');

    fireEvent.click(await screen.findByRole('tab', { name: 'Themes' }));
    const list = await screen.findByRole('list', { name: 'Themes' });
    const rows = within(list).getAllByRole('listitem');
    expect(within(rows[0]!).getByText('Hatti Base')).toBeTruthy();
    expect(within(rows[0]!).getByText('Live')).toBeTruthy();
    // The live theme is neither published again nor deleted.
    expect(within(rows[0]!).queryByRole('button', { name: 'Delete Hatti Base' })).toBeNull();
    expect(
      within(rows[1]!).getByRole('link', { name: 'Preview Eid sale' }).getAttribute('href'),
    ).toBe('https://zari.hatti.pk/?preview_theme_id=th_2');

    expect((screen.getByLabelText('Start from') as HTMLSelectElement).value).toBe('th_1');
    type('Name', 'Eid sale');
    fireEvent.click(screen.getByRole('button', { name: 'Add theme' }));
    expect(await screen.findByText('Name: is the name of another theme')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Start from'), { target: { value: '' } });
    type('Name', 'Winter');
    fireEvent.click(screen.getByRole('button', { name: 'Add theme' }));
    expect(await within(list).findByText('Winter')).toBeTruthy();
    expect(sentOf(fake, 'ThemeCreate')).toEqual([
      { name: 'Eid sale', copyFrom: 'th_1' },
      { name: 'Winter', copyFrom: null },
    ]);
  });

  it('publishes one once asked, and deletes another', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=themes');

    fireEvent.click(await screen.findByRole('button', { name: 'Publish Eid sale' }));
    expect(screen.getByText(/^Publish Eid sale\? Your store shows it in a moment/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Publish it' }));
    await waitFor(() => expect(within(rowOf('Eid sale')).getByText('Live')).toBeTruthy());
    expect(sentOf(fake, 'ThemePublish')).toEqual([{ id: 'th_2' }]);

    fireEvent.click(within(rowOf('Hatti Base')).getByRole('button', { name: 'Delete Hatti Base' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(screen.queryByText('Hatti Base')).toBeNull());
    expect(sentOf(fake, 'ThemeDelete')).toEqual([{ id: 'th_1' }]);
  });

  it('publishes a theme by itself at a time set ahead, after a refusal, or calls it off', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=themes');

    // The live theme has nothing to schedule.
    await screen.findByRole('list', { name: 'Themes' });
    expect(screen.queryByRole('button', { name: 'Schedule Hatti Base' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule Eid sale' }));
    const past = localInput(new Date(Date.now() - 3_600_000).toISOString());
    fireEvent.change(screen.getByLabelText('Publish at'), { target: { value: past } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule it' }));
    expect(await screen.findByText('A theme is published a minute ahead at least')).toBeTruthy();

    // Eid's midnight, typed in the phone's time.
    const midnight = new Date(Date.now() + 2 * 86_400_000);
    midnight.setHours(0, 0, 0, 0);
    fireEvent.change(screen.getByLabelText('Publish at'), {
      target: { value: localInput(midnight.toISOString()) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule it' }));
    const said = `Publishes by itself ${formatDateTime(midnight.toISOString(), 'Asia/Karachi', 'en')}`;
    expect(await within(rowOf('Eid sale')).findByText(said)).toBeTruthy();
    expect(screen.queryByLabelText('Publish at')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Call off publishing Eid sale' }));
    await waitFor(() => expect(screen.queryByText(said)).toBeNull());
    expect(sentOf(fake, 'ThemeSchedulePublish').slice(1)).toEqual([
      { id: 'th_2', publishAt: midnight.toISOString() },
      { id: 'th_2', publishAt: null },
    ]);
  });

  it("shows a theme's versions, the newest first, and takes it back to one once asked", async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=themes');

    fireEvent.click(await screen.findByRole('button', { name: 'Versions of Hatti Base' }));
    expect(await screen.findByText(/^No changes kept yet/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Versions of Eid sale' }));
    const list = await screen.findByRole('list', { name: 'Versions of Eid sale' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('.font-medium')?.textContent)).toEqual([
      'Version 3',
      'Version 2',
      'Version 1',
    ]);
    // The newest is the theme as it is: nothing to go back to.
    expect(within(rows[0]!).getByText('Now')).toBeTruthy();
    expect(within(rows[0]!).queryByRole('button')).toBeNull();
    expect(
      within(rows[1]!).getByText('sections/header.json, config/settings_data.json'),
    ).toBeTruthy();
    expect(within(rows[1]!).getByText(/^Files removed · /)).toBeTruthy();

    fireEvent.click(within(rows[2]!).getByRole('button', { name: 'Go back to version 1' }));
    expect(
      within(list).getByText(/^Take Eid sale back to version 1\? The changes since are undone/),
    ).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Go back' }));
    expect(await screen.findByText('Taken back to version 1.')).toBeTruthy();
    // The taking back is a version of its own, to undo in turn.
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(4));
    const newest = within(list).getAllByRole('listitem')[0]!;
    expect(within(newest).getByText('Version 4')).toBeTruthy();
    expect(within(newest).getByText(/^Taken back · /)).toBeTruthy();
    expect(sentOf(fake, 'ThemeRollback')).toEqual([{ id: 'th_2', version: 1 }]);
  });

  it("ends a theme's preview links sent so far once asked, a new one in their place (ADR-699)", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store?tab=themes');

    fireEvent.click(
      await screen.findByRole('button', { name: 'End the preview links of Hatti Base' }),
    );
    expect(screen.getByText(/^End every preview link of Hatti Base sent so far\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(fake.sent.some((each) => each.operation === 'ThemePreviewLinksRevoke')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'End the preview links of Eid sale' }));
    fireEvent.click(screen.getByRole('button', { name: 'End them' }));
    expect(
      await within(rowOf('Eid sale')).findByText(
        'Links sent before no longer open. The Preview button gives a new one.',
      ),
    ).toBeTruthy();
    expect(sentOf(fake, 'ThemePreviewLinksRevoke')).toEqual([{ id: 'th_2' }]);
    await waitFor(() =>
      expect(
        within(rowOf('Eid sale'))
          .getByRole('link', { name: 'Preview Eid sale' })
          .getAttribute('href'),
      ).toBe('https://zari.hatti.pk/?preview_theme_id=th_2&gen=2'),
    );
  });

  it('is not there for a marketer', async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/online-store');
    await screen.findByRole('heading', { name: 'Online store' });
    expect(screen.queryByRole('tab', { name: 'Themes' })).toBeNull();
  });
});
