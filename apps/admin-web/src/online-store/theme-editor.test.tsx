import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const EARLIER = new Date(Date.now() - 3 * 86_400_000).toISOString();
const LATER = new Date(Date.now() + 3 * 86_400_000).toISOString();
const STOREFRONT = 'https://zari.hatti.pk';
const PREVIEW = `${STOREFRONT}/?preview=v1.k1.preview-token`;

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
  file('templates/page.contact.json', {
    sections: { main: { type: 'main-product' } },
    order: ['main'],
  }),
  file('templates/page.faq.json', {
    sections: { main: { type: 'main-product' } },
    order: ['main'],
  }),
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
  // The preview's link is sealed anew each time the theme is read.
  let reads = 0;
  return fakeCore(role, (operation) => {
    switch (operation) {
      case 'ThemeEditor':
        return {
          theme: {
            id: 'thm_1',
            name: 'Hatti Base',
            role: 'MAIN',
            base: 'hatti-base',
            previewUrl: (reads += 1) === 1 ? PREVIEW : `${PREVIEW}-${reads}`,
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
          products: { nodes: [{ handle: 'eid-lawn-3pc' }] },
          pages: {
            nodes: [
              { handle: 'about', templateSuffix: null, isPublished: true, publishedAt: EARLIER },
              // Not shown yet, and hidden: no page to open.
              { handle: 'faq', templateSuffix: 'faq', isPublished: true, publishedAt: LATER },
              { handle: 'old-faq', templateSuffix: 'faq', isPublished: false, publishedAt: null },
              {
                handle: 'contact-us',
                templateSuffix: 'contact',
                isPublished: true,
                publishedAt: EARLIER,
              },
            ],
          },
          blogs: { nodes: [{ handle: 'news', templateSuffix: null }] },
          articles: {
            nodes: [
              {
                handle: 'eid-edit',
                templateSuffix: null,
                isPublished: true,
                publishedAt: EARLIER,
                blog: { handle: 'news' },
              },
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

/** A render the editor asked of the page in its preview. */
interface Render {
  id: number;
  sections: string[];
  files: Record<string, string>;
}

/** What the page in the preview says when it has loaded: its path and template. */
const ready = (path: string, template: string | null) => ({
  type: 'hatti:ready',
  page: { path, locale: 'en', template },
  sections: [],
});

/** The preview's frame: what the editor posts to the page in it, and the page's own messages. */
async function preview() {
  const element = (await screen.findByTitle('Hatti Base on your store')) as HTMLIFrameElement;
  const page = element.contentWindow!;
  const posted = vi.spyOn(page, 'postMessage');
  const messages = (): Record<string, unknown>[] =>
    posted.mock.calls.map(([message, origin]) => ({
      ...(message as Record<string, unknown>),
      origin,
    }));
  return {
    element,
    /** The page in the frame loaded. */
    loaded: () => fireEvent.load(element),
    /** A message from the page, or from another window or site. */
    tell: (data: Record<string, unknown>, from: { origin?: string; source?: unknown } = {}) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data,
            origin: from.origin ?? STOREFRONT,
            source: (from.source ?? page) as MessageEventSource,
          }),
        );
      }),
    messages,
    renders: () => messages().filter((each) => each.type === 'hatti:render') as unknown as Render[],
    selections: () =>
      messages()
        .filter((each) => each.type === 'hatti:select' || each.type === 'hatti:deselect')
        .map(({ origin: _origin, ...each }) => each),
  };
}

/** A file as a render sent it. */
const sentFile = (render: Render, filename: string) =>
  JSON.parse(render.files[filename]!) as typeof INDEX;

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
    expect(headings).toEqual(['Header', 'Home page', 'Footer', 'Theme settings', 'Preview']);

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
    expect(headings).toEqual(['Password page', 'Theme settings', 'Preview']);
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

  it('shows the page beside the editor, its changes there as they are made', async () => {
    vi.stubGlobal('fetch', core('owner').fetcher);
    renderAdmin('/shop_1/online-store/themes/thm_1');
    const frame = await preview();
    // The home page at the preview's link, in design mode once it says hello back.
    expect(frame.element.src).toBe(PREVIEW);
    frame.loaded();
    expect(frame.messages()).toContainEqual({ type: 'hatti:hello', origin: STOREFRONT });
    expect(screen.getByText('Opening the page…')).toBeTruthy();
    frame.tell(ready('/?preview=v1.k1.preview-token', 'templates/index.json'));
    expect(screen.queryByText('Opening the page…')).toBeNull();

    // A section's settings changed: rendered again with the template as the editor has it.
    fireEvent.click(screen.getByRole('button', { name: /Featured collection\s*Handmade khussas/ }));
    expect(frame.selections()).toEqual([{ type: 'hatti:select', section: 'khussa', block: null }]);
    type('Heading', 'Khussas for Eid');
    await waitFor(() => expect(frame.renders()).toHaveLength(1));
    const [first] = frame.renders();
    expect(first).toMatchObject({ id: 1, sections: ['khussa'], origin: STOREFRONT });
    expect(Object.keys(first!.files)).toEqual(['templates/index.json']);
    expect(sentFile(first!, 'templates/index.json').sections.khussa.settings.title).toBe(
      'Khussas for Eid',
    );
    expect(screen.getByText('Showing your changes…')).toBeTruthy();
    frame.tell({ type: 'hatti:rendered', id: 1, sections: ['khussa'], problems: [] });
    expect(screen.queryByText('Showing your changes…')).toBeNull();

    // Moved, or hidden: nothing to render, the page put as the template has it.
    fireEvent.click(
      screen.getByRole('button', { name: 'Move Featured collection: Khussas for Eid up' }),
    );
    await waitFor(() => expect(frame.renders()).toHaveLength(2));
    expect(frame.renders()[1]).toMatchObject({ id: 2, sections: [] });
    expect(sentFile(frame.renders()[1]!, 'templates/index.json').order).toEqual([
      'banner',
      'khussa',
      'lawn',
    ]);
    frame.tell({ type: 'hatti:rendered', id: 2, sections: [], problems: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Hide Image banner' }));
    await waitFor(() => expect(frame.renders()).toHaveLength(3));
    expect(frame.renders()[2]).toMatchObject({ sections: [] });
    frame.tell({ type: 'hatti:rendered', id: 3, sections: [], problems: [] });
    // Shown again, it is rendered for the page to take it back.
    fireEvent.click(screen.getByRole('button', { name: 'Show Image banner' }));
    await waitFor(() => expect(frame.renders()).toHaveLength(4));
    expect(frame.renders()[3]).toMatchObject({ sections: ['banner'] });
    frame.tell({ type: 'hatti:rendered', id: 4, sections: ['banner'], problems: [] });

    // Discarded: the page as saved again.
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(frame.renders()).toHaveLength(5));
    const back = frame.renders()[4]!;
    expect(back.sections).toEqual(['khussa']);
    expect(sentFile(back, 'templates/index.json')).toEqual(INDEX);
    frame.tell({ type: 'hatti:rendered', id: 5, sections: ['khussa'], problems: [] });

    // A block opened is chosen in the page; a section the merchant taps there is opened here.
    fireEvent.click(screen.getByRole('button', { name: /^Image banner/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Heading\s*Eid Lawn/ }));
    expect(frame.selections().slice(-2)).toEqual([
      { type: 'hatti:select', section: 'banner', block: null },
      { type: 'hatti:select', section: 'banner', block: 'heading' },
    ]);
    const before = frame.selections().length;
    frame.tell({ type: 'hatti:selected', section: 'header-group__announcement', block: null });
    expect((screen.getByLabelText('Text') as HTMLInputElement).value).toBe(
      'Free delivery over Rs 5,000',
    );
    // Chosen there already: not sent back.
    expect(frame.selections()).toHaveLength(before);
    fireEvent.click(screen.getByRole('button', { name: /^Announcement bar/ }));
    expect(frame.selections().at(-1)).toEqual({ type: 'hatti:deselect' });
  });

  it("opens a page of the shop's for each template, and follows the merchant in the preview", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/online-store/themes/thm_1');
    await preview();
    const src = () => (screen.getByTitle('Hatti Base on your store') as HTMLIFrameElement).src;
    const page = () => (screen.getByLabelText('Page') as HTMLSelectElement).value;

    fireEvent.change(screen.getByLabelText('Page'), { target: { value: 'product' } });
    expect(src()).toBe(`${STOREFRONT}/products/eid-lawn-3pc?preview=v1.k1.preview-token`);
    // Gone home before the product's page said it was ready: the editor follows all the same.
    let frame = await preview();
    frame.tell(ready('/', 'templates/index.json'));
    expect(page()).toBe('index');
    fireEvent.change(screen.getByLabelText('Page'), { target: { value: 'product' } });
    frame = await preview();
    frame.tell(
      ready('/products/eid-lawn-3pc?preview=v1.k1.preview-token', 'templates/product.json'),
    );
    expect(page()).toBe('product');
    // An alternate template opens a page that asks for it.
    fireEvent.change(screen.getByLabelText('Page'), { target: { value: 'page.contact' } });
    expect(src()).toBe(`${STOREFRONT}/pages/contact-us?preview=v1.k1.preview-token`);
    frame = await preview();
    frame.tell(
      ready('/pages/contact-us?preview=v1.k1.preview-token', 'templates/page.contact.json'),
    );
    expect(screen.queryByText(/No page of your store uses this template yet/)).toBeNull();
    // None shown yet asks for this one: the preview stays where it is, and says so.
    fireEvent.change(screen.getByLabelText('Page'), { target: { value: 'page.faq' } });
    expect(src()).toBe(`${STOREFRONT}/pages/contact-us?preview=v1.k1.preview-token`);
    expect(
      screen.getByText(
        'No page of your store uses this template yet, so the preview shows another page.',
      ),
    ).toBeTruthy();

    // The merchant goes to the home page in the preview: the editor shows its template.
    frame.tell(ready('/', 'templates/index.json'));
    expect(page()).toBe('index');
    expect(screen.getByRole('heading', { name: 'Home page' })).toBeTruthy();
    // Opened again where it is.
    fireEvent.click(screen.getByRole('button', { name: 'Open the page again' }));
    expect(src()).toBe(`${STOREFRONT}/?preview=v1.k1.preview-token`);

    // The theme's settings show once saved: the page opened again with them.
    frame = await preview();
    frame.tell(ready('/', 'templates/index.json'));
    fireEvent.click(screen.getByRole('button', { name: 'Colours' }));
    type('Buttons and links: colour code', '#B45309');
    expect(screen.getByText('Theme settings show in the preview once you save them.')).toBeTruthy();
    const shown = frame.element;
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved. Your store shows it in a moment.');
    expect(screen.getByTitle('Hatti Base on your store')).not.toBe(shown);
    expect(frame.renders()).toEqual([]);
    // With the link the editor opened with, though the theme read again came with another.
    expect(src()).toBe(`${STOREFRONT}/?preview=v1.k1.preview-token`);
  });

  it('says what the preview could not show, and hears only the page in it', async () => {
    vi.stubGlobal('fetch', core('owner').fetcher);
    renderAdmin('/shop_1/online-store/themes/thm_1');
    const frame = await preview();
    // Another site, or another window, is not the page in the preview.
    frame.tell(ready('/', 'templates/index.json'), { origin: 'https://evil.pk' });
    frame.tell(ready('/', 'templates/index.json'), { source: window });
    fireEvent.click(await screen.findByRole('button', { name: /^Announcement bar/ }));
    expect(frame.selections()).toEqual([]);
    frame.tell(ready('/', 'templates/index.json'));

    type('Text', 'Eid sale on now');
    await waitFor(() => expect(frame.renders()).toHaveLength(1));
    expect(frame.renders()[0]).toMatchObject({ sections: ['header-group__announcement'] });
    expect(Object.keys(frame.renders()[0]!.files)).toEqual(['sections/header-group.json']);
    frame.tell({ type: 'hatti:failed', id: 1, message: 'The preview could not render: 503' });
    expect(
      screen.getByText(
        "The preview couldn't show your latest changes (The preview could not render: 503). Open the page again to try.",
      ),
    ).toBeTruthy();

    type('Text', 'Eid sale ends Sunday');
    await waitFor(() => expect(frame.renders()).toHaveLength(2));
    frame.tell({
      type: 'hatti:rendered',
      id: 2,
      sections: ['header-group__announcement'],
      problems: ['sections/header-group.json: section "announcement" has no type "marquee"'],
    });
    expect(screen.queryByText(/couldn't show your latest changes/)).toBeNull();
    expect(screen.getByText("The preview leaves out what your store can't use yet:")).toBeTruthy();
    expect(
      screen.getByText('sections/header-group.json: section "announcement" has no type "marquee"'),
    ).toBeTruthy();
    // A section the page could not choose is no failure of the preview's.
    frame.tell({ type: 'hatti:failed', message: 'The page has no section x' });
    expect(screen.queryByText(/couldn't show your latest changes/)).toBeNull();
  });

  it('is not open to those who do not change themes', async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/online-store/themes/thm_1');
    expect(
      await screen.findByText("Only the shop's owner and managers change its themes."),
    ).toBeTruthy();
  });
});
