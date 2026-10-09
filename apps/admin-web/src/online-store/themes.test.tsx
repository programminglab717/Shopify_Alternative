import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
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
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Themes':
        return { themes: { nodes: themes } };
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

  it('is not there for a marketer', async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/online-store');
    await screen.findByRole('heading', { name: 'Online store' });
    expect(screen.queryByRole('tab', { name: 'Themes' })).toBeNull();
  });
});
