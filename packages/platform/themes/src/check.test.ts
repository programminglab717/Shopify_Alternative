import { beforeAll, describe, expect, it } from 'vitest';
import { checkShopFile, platformTheme, settingValue, videoUrlOf, type Theme } from './index.js';

describe('Theme Check', () => {
  let base: Theme;
  const check = (filename: string, json: unknown) =>
    checkShopFile(base, filename, JSON.stringify(json));

  beforeAll(async () => {
    base = await platformTheme('hatti-base');
  });

  it("passes Hatti Base's own files, which a shop's copy of them keeps to", () => {
    const own = Object.keys(base.files).filter(
      (file) =>
        /^(templates|sections|config)\/.*\.json$/.test(file) &&
        file !== 'config/settings_schema.json',
    );
    expect(own.length).toBeGreaterThan(5);
    // A customer's templates are under customers/, as Shopify's (ADR-571).
    expect(own).toContain('templates/customers/login.json');
    for (const file of own) {
      expect(checkShopFile(base, file, base.files[file]!), file).toEqual([]);
    }
  });

  it('says which sections, blocks and settings Hatti Base does not have', () => {
    expect(
      check('templates/index.json', { sections: { x: { type: 'reviews' } }, order: ['x'] }),
    ).toEqual(['section "x" is a "reviews", which the theme does not have']);
    expect(
      check('templates/index.json', {
        sections: {
          Banner: {
            type: 'image-banner',
            settings: { colour: 'red' },
            blocks: { a: { type: 'carousel' }, b: { type: 'heading', settings: { size: 3 } } },
          },
        },
        order: ['Banner'],
      }),
    ).toEqual([
      'section "Banner" has no setting "colour"',
      'section "Banner" takes no "carousel" blocks',
      'block "b" of section "Banner" has no setting "size"',
    ]);
  });

  it("says when a setting's value is not of its type, or blocks go over their limit", () => {
    expect(
      check('templates/index.json', {
        sections: {
          lawn: {
            type: 'featured-collection',
            // An empty value is one left unset.
            settings: { products_to_show: 40, collection: 7, title: '' },
          },
          banner: {
            type: 'image-banner',
            settings: { image: 'javascript:alert(1)' },
            blocks: {
              h1: { type: 'heading' },
              h2: { type: 'heading' },
              go: { type: 'button', settings: { link: '//evil.example' } },
            },
          },
        },
        order: ['lawn', 'banner'],
      }),
    ).toEqual([
      `section "lawn"'s "products_to_show" must be a number from 2 to 12`,
      `section "lawn"'s "collection" must be a collection's handle`,
      `section "banner"'s "image" must be an image at a path on the storefront or an https address`,
      `block "go" of section "banner"'s "link" must be a path on the storefront, such as ` +
        '/collections/eid, or a web, mail or phone address',
      'section "banner" takes at most 1 "heading" block',
    ]);
    expect(
      check('config/settings_data.json', {
        current: {
          color_accent: 'red; } body {',
          page_width: 1200,
          whatsapp_orders: 'yes',
          font: 'Jameel Noori',
          sections: { header: { settings: { menu: 'main-menu' } }, gone: {} },
        },
      }),
    ).toEqual([
      `the theme's "color_accent" must be a colour, such as #0F766E`,
      `the theme's "whatsapp_orders" must be true or false`,
      'the theme has no setting "font"',
      'the theme has no section "gone" to set',
    ]);
  });

  it("takes a video section's YouTube or Vimeo address as people copy it, and nothing else (ADR-705)", () => {
    for (const [url, video] of [
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', { type: 'youtube', id: 'dQw4w9WgXcQ' }],
      [
        'https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
        { type: 'youtube', id: 'dQw4w9WgXcQ' },
      ],
      ['https://youtu.be/dQw4w9WgXcQ?si=abc', { type: 'youtube', id: 'dQw4w9WgXcQ' }],
      ['https://youtube.com/shorts/dQw4w9WgXcQ', { type: 'youtube', id: 'dQw4w9WgXcQ' }],
      ['https://vimeo.com/76979871', { type: 'vimeo', id: '76979871' }],
      ['https://player.vimeo.com/video/76979871', { type: 'vimeo', id: '76979871' }],
      ['https://evil.example/watch?v=dQw4w9WgXcQ', null],
      ['https://youtu.be/dQw4w9WgXcQ"onload="x', null],
      ['javascript:alert(1)', null],
    ] as const) {
      expect(videoUrlOf(url), url).toEqual(video);
    }
    expect(
      check('templates/index.json', {
        sections: {
          film: { type: 'video', settings: { video: 'https://vimeo.com/76979871' } },
          clip: { type: 'video', settings: { video: 'https://example.com/clip.mp4' } },
        },
        order: ['film', 'clip'],
      }),
    ).toEqual([`section "clip"'s "video" must be the address of a YouTube or Vimeo video`]);
    // A setting taking one host alone refuses the other's.
    const youtube = { type: 'video_url', id: 'v', accept: ['youtube'] };
    expect(settingValue(youtube, 'https://vimeo.com/76979871')).toBeNull();
    expect(settingValue(youtube, ' https://youtu.be/dQw4w9WgXcQ ')).toBe(
      'https://youtu.be/dQw4w9WgXcQ',
    );
  });
});
