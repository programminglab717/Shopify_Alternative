import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const EARLIER = new Date(Date.now() - 3 * 86_400_000).toISOString();

const SETTINGS_SCHEMA = [
  { name: 'theme_info', theme_name: 'Hatti Base' },
  {
    name: 'Colours',
    settings: [
      { type: 'color', id: 'color_accent', label: 'Buttons and links', default: '#0F766E' },
    ],
  },
  {
    name: 'Orders',
    settings: [
      {
        type: 'select',
        id: 'cart_type',
        label: 'When a product is added to the cart',
        options: [
          { value: 'drawer', label: 'Show the cart in a drawer' },
          { value: 'page', label: 'Go to the cart page' },
        ],
        default: 'drawer',
      },
      { type: 'checkbox', id: 'whatsapp_orders', label: 'Order on WhatsApp', default: true },
    ],
  },
];

const SECTIONS: Record<string, object> = {
  'announcement-bar': {
    name: 'Announcement bar',
    settings: [{ type: 'text', id: 'text', label: 'Text', default: 'Cash on delivery' }],
  },
  header: {
    name: 'Header',
    settings: [{ type: 'link_list', id: 'menu', label: 'Menu', default: 'main-menu' }],
  },
  footer: {
    name: 'Footer',
    settings: [{ type: 'link_list', id: 'menu', label: 'Menu', default: 'footer' }],
  },
  'image-banner': {
    name: 'Image banner',
    settings: [{ type: 'image_picker', id: 'image', label: 'Image' }],
    blocks: [
      {
        type: 'heading',
        name: 'Heading',
        limit: 1,
        settings: [{ type: 'text', id: 'heading', label: 'Heading', default: 'Welcome' }],
      },
      {
        type: 'text',
        name: 'Text',
        limit: 1,
        settings: [{ type: 'textarea', id: 'text', label: 'Text' }],
      },
      {
        type: 'button',
        name: 'Button',
        limit: 2,
        settings: [
          { type: 'text', id: 'label', label: 'Label', default: 'Shop now' },
          { type: 'url', id: 'link', label: 'Link', default: '/collections/all' },
        ],
      },
    ],
  },
  'featured-collection': {
    name: 'Featured collection',
    settings: [
      { type: 'text', id: 'title', label: 'Heading' },
      { type: 'collection', id: 'collection', label: 'Collection' },
      {
        type: 'range',
        id: 'products_to_show',
        label: 'Products to show',
        min: 2,
        max: 12,
        step: 1,
        default: 8,
      },
    ],
  },
  'main-product': {
    name: 'Product',
    blocks: [{ type: 'title', name: 'Title', limit: 1 }],
  },
};

const INDEX = {
  sections: {
    banner: {
      type: 'image-banner',
      settings: { image: { src: '/images/eid.jpg', width: 1500, height: 900, alt: 'Eid' } },
      blocks: {
        heading: { type: 'heading', settings: { heading: "Eid Lawn '26" } },
        text: { type: 'text', settings: { text: 'Unstitched suits' } },
        button: { type: 'button', settings: { label: 'Shop the collection' } },
      },
      block_order: ['heading', 'text', 'button'],
    },
    lawn: {
      type: 'featured-collection',
      settings: { title: 'New Eid lawn', collection: 'eid-lawn', products_to_show: 8 },
    },
    khussa: {
      type: 'featured-collection',
      settings: { title: 'Handmade khussas', collection: 'khussa', products_to_show: 4 },
    },
  },
  order: ['banner', 'lawn', 'khussa'],
};

const file = (filename: string, json: unknown, own = false) => ({
  filename,
  body: JSON.stringify(json),
  own,
  problems: [],
});

const FILES = [
  file('config/settings_data.json', { current: { color_accent: '#0F766E' } }),
  file('sections/footer-group.json', {
    type: 'footer',
    name: 'Footer group',
    sections: { footer: { type: 'footer', settings: { menu: 'footer' } } },
    order: ['footer'],
  }),
  file('sections/header-group.json', {
    type: 'header',
    name: 'Header group',
    sections: {
      announcement: { type: 'announcement-bar', settings: { text: 'Free delivery over Rs 5,000' } },
      header: { type: 'header', settings: { menu: 'main-menu' } },
    },
    order: ['announcement', 'header'],
  }),
  file('templates/index.json', INDEX, true),
  file('templates/password.json', {
    layout: 'password',
    sections: { main: { type: 'main-product' } },
    order: ['main'],
  }),
  file('templates/product.json', {
    sections: { main: { type: 'main-product' } },
    order: ['main'],
  }),
];

/** A fake core with one theme to edit; its first save refused when `refuseOnce`. */
function core(role: StaffRole, { refuseOnce = false } = {}) {
  let refusals = refuseOnce ? 1 : 0;
  return fakeCore(role, (operation) => {
    switch (operation) {
      case 'ThemeEditor':
        return {
          theme: {
            id: 'thm_1',
            name: 'Hatti Base',
            role: 'MAIN',
            base: 'hatti-base',
            previewUrl: 'https://zari.hatti.pk/?preview_theme_id=thm_1',
            createdAt: EARLIER,
            updatedAt: EARLIER,
            version: 4,
            editor: {
              settingsSchema: JSON.stringify(SETTINGS_SCHEMA),
              sections: Object.entries(SECTIONS).map(([type, schema]) => ({
                type,
                name: (schema as { name: string }).name,
                schema: JSON.stringify(schema),
              })),
              files: FILES,
            },
          },
        };
      case 'ThemeChoices':
        return {
          menus: {
            nodes: [
              { handle: 'main-menu', title: 'Main menu' },
              { handle: 'footer', title: 'Footer menu' },
            ],
          },
          collections: {
            nodes: [
              { handle: 'eid-lawn', title: 'Eid lawn' },
              { handle: 'khussa', title: 'Khussas' },
              { handle: 'mens-kurta', title: "Men's kurtas" },
            ],
          },
        };
      case 'ThemeFilesUpsert':
        if (refusals > 0) {
          refusals -= 1;
          return {
            themeFilesUpsert: {
              theme: null,
              userErrors: [
                {
                  field: ['files', '0', 'body'],
                  code: 'INVALID',
                  message: 'templates/index.json: section "banner" takes at most 2 "button" blocks',
                },
              ],
            },
          };
        }
        return { themeFilesUpsert: { theme: { id: 'thm_1', version: 5 }, userErrors: [] } };
      case 'ThemeFilesDelete':
        return {
          themeFilesDelete: { deletedThemeFiles: ['templates/index.json'], userErrors: [] },
        };
      case 'Themes':
        return {
          themes: {
            nodes: [
              {
                id: 'thm_1',
                name: 'Hatti Base',
                role: 'MAIN',
                base: 'hatti-base',
                previewUrl: 'https://zari.hatti.pk/?preview_theme_id=thm_1',
                createdAt: EARLIER,
                updatedAt: EARLIER,
              },
            ],
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

/** The files a save sent, each body read. */
const savedFiles = (fake: ReturnType<typeof core>) =>
  (sentOf(fake, 'ThemeFilesUpsert').at(-1)!.files as { filename: string; body: string }[]).map(
    (each) => ({ filename: each.filename, json: JSON.parse(each.body) as Record<string, unknown> }),
  );

const cardOf = (title: string) =>
  screen.getByRole('heading', { name: title }).closest<HTMLElement>('section, div.flex')!;

describe("A theme's editor", () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("changes the home page's sections and saves them at once", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/themes/thm_1');

    expect(await screen.findByRole('heading', { name: /Customise Hatti Base/ })).toBeTruthy();
    expect((screen.getByLabelText('Page') as HTMLSelectElement).value).toBe('index');
    // The page from its header to its footer.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((each) => each.textContent);
    expect(headings).toEqual(['Header', 'Home page', 'Footer', 'Theme settings']);

    fireEvent.click(screen.getByRole('button', { name: /Featured collection\s*Handmade khussas/ }));
    type('Heading', 'Khussas for Eid');
    fireEvent.change(screen.getByLabelText('Collection'), { target: { value: 'mens-kurta' } });
    fireEvent.change(screen.getByLabelText(/Products to show/), { target: { value: '6' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Move Featured collection: Khussas for Eid up' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hide Image banner' }));
    expect(screen.getByText('You have changes not saved yet.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. Your store shows it in a moment.')).toBeTruthy();
    expect(screen.queryByText('You have changes not saved yet.')).toBeNull();
    const [index] = savedFiles(fake);
    expect(index!.filename).toBe('templates/index.json');
    expect(index!.json).toMatchObject({
      order: ['banner', 'khussa', 'lawn'],
      sections: {
        banner: { disabled: true },
        khussa: {
          settings: { title: 'Khussas for Eid', collection: 'mens-kurta', products_to_show: 6 },
        },
      },
    });
    expect(sentOf(fake, 'ThemeFilesUpsert')[0]!.themeId).toBe('thm_1');
  });

  it("changes blocks and the theme's settings, says why a save was refused, and starts a part again", async () => {
    const fake = core('manager', { refuseOnce: true });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/themes/thm_1');

    fireEvent.click(await screen.findByRole('button', { name: /^Image banner/ }));
    // Its picture as it is, with a word on changing it.
    expect(
      screen.getByText('Pictures can be changed here soon. Until then this one stays.'),
    ).toBeTruthy();
    expect(document.querySelector('img[src$="eid.jpg"]')?.getAttribute('src')).toBe(
      'https://zari.hatti.pk/images/eid.jpg',
    );
    fireEvent.click(screen.getByRole('button', { name: /^Text\s*Unstitched suits/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Text: Unstitched suits' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a Button block to Image banner' }));
    // Two buttons are as many as the banner takes.
    expect(screen.queryByRole('button', { name: 'Add a Button block to Image banner' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Heading\s*Eid Lawn/ }));
    type('Heading', 'Eid sale');

    fireEvent.click(screen.getByRole('button', { name: 'Colours' }));
    type('Buttons and links: colour code', '#B45309');
    fireEvent.click(screen.getByRole('button', { name: 'Orders' }));
    fireEvent.click(screen.getByLabelText('Order on WhatsApp'));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        'templates/index.json: section "banner" takes at most 2 "button" blocks',
      ),
    ).toBeTruthy();
    // Nothing is lost: saved again, as it was.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved. Your store shows it in a moment.');
    const files = savedFiles(fake);
    expect(files.map((each) => each.filename).sort()).toEqual([
      'config/settings_data.json',
      'templates/index.json',
    ]);
    const settings = files.find((each) => each.filename === 'config/settings_data.json')!.json;
    expect(settings).toEqual({ current: { color_accent: '#B45309', whatsapp_orders: false } });
    const banner = (
      files.find((each) => each.filename === 'templates/index.json')!.json as typeof INDEX
    ).sections.banner;
    expect(banner.block_order).toHaveLength(3);
    expect(banner.block_order).not.toContain('text');
    expect(banner.blocks.heading.settings.heading).toBe('Eid sale');
    const added = banner.block_order[2]!;
    expect(added).toMatch(/^button_[a-z0-9]+$/);
    expect(banner.blocks[added as 'button']).toEqual({ type: 'button', settings: {} });

    // The home page is the shop's own: started again from the theme's.
    fireEvent.click(within(cardOf('Home page')).getByRole('button', { name: 'Start again' }));
    const ask = screen
      .getByText(/^Start Home page again as the theme came\?/)
      .closest('[role="status"]')!;
    fireEvent.click(within(ask as HTMLElement).getByRole('button', { name: 'Start again' }));
    await waitFor(() =>
      expect(sentOf(fake, 'ThemeFilesDelete')).toEqual([
        { themeId: 'thm_1', files: ['templates/index.json'] },
      ]),
    );
  });

  it("keeps a page's own section, and shows a page without the groups its layout lacks", async () => {
    vi.stubGlobal('fetch', core('owner').fetcher);
    renderAdmin('/shop_1/online-store/themes/thm_1');

    fireEvent.change(await screen.findByLabelText('Page'), { target: { value: 'product' } });
    expect(screen.getByRole('heading', { name: 'Products' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Hide Product/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove Product/ })).toBeNull();
    // The theme's own page: nothing of the shop's to start again.
    expect(within(cardOf('Products')).queryByRole('button', { name: 'Start again' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Page'), { target: { value: 'password' } });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((each) => each.textContent);
    expect(headings).toEqual(['Password page', 'Theme settings']);
  });

  it('discards changes, and is linked from the themes tab', async () => {
    vi.stubGlobal('fetch', core('owner').fetcher);
    renderAdmin('/shop_1/online-store?tab=themes');

    fireEvent.click(await screen.findByRole('link', { name: 'Customise Hatti Base' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Announcement bar/ }));
    type('Text', 'Eid sale on now');
    expect(screen.getByText('You have changes not saved yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByText('You have changes not saved yet.')).toBeNull();
    expect((screen.getByLabelText('Text') as HTMLInputElement).value).toBe(
      'Free delivery over Rs 5,000',
    );
  });

  it('is not open to those who do not change themes', async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/online-store/themes/thm_1');
    expect(
      await screen.findByText("Only the shop's owner and managers change its themes."),
    ).toBeTruthy();
  });
});
