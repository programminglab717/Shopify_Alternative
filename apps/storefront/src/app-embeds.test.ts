import { fileURLToPath } from 'node:url';
import { MemoryStore } from '@hatti/storefront-data';
import { loadTheme, readThemeDir, type Theme } from '@hatti/themes';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleStore } from './fixtures.js';
import { PageRenderer, appEmbedTags, type PageRequest } from './render.js';

const THEME_DIR = fileURLToPath(new URL('../../../themes/hatti-base', import.meta.url));

describe("The shop's apps' scripts on its pages (DEV-06, ADR-852)", () => {
  let theme: Theme;
  beforeAll(async () => {
    theme = loadTheme(await readThemeDir(THEME_DIR));
  });

  const render = async (
    request: PageRequest,
    appEmbeds?: { src: string; app: string; handle: string }[],
  ) => {
    const sample = sampleStore();
    const store = new MemoryStore({ ...sample, shop: { ...sample.shop, appEmbeds } });
    const renderer = new PageRenderer(theme, { limits: { timeMs: 10_000 } });
    return (await renderer.render(request, store.fresh(0))).html;
  };
  const head = (html: string) => html.slice(0, html.indexOf('</head>'));
  const EMBED = {
    src: 'https://sizes.example.pk/w.js?v=2&x=1',
    app: 'Size finder',
    handle: 'size-finder',
  };

  it("loads each one turned on, async, on shoppers' pages and previews alike", async () => {
    const tag =
      '<script src="https://sizes.example.pk/w.js?v=2&amp;x=1" async data-hatti-app="size-finder"></script>';
    const page = await render({ path: '/' }, [EMBED]);
    expect(head(page)).toContain(tag);
    expect(head(await render({ path: '/', preview: { name: 'Winter' } }, [EMBED]))).toContain(tag);
    expect(await render({ path: '/' })).not.toContain('data-hatti-app');
  });

  it('loads https scripts alone, their addresses escaped', () => {
    expect(
      appEmbedTags({
        ...sampleStore().shop,
        appEmbeds: [{ ...EMBED, src: 'javascript:alert(1)' }],
      }),
    ).toBe('');
    expect(
      appEmbedTags({
        ...sampleStore().shop,
        appEmbeds: [{ ...EMBED, src: 'https://x.example.pk/"><script>alert(1)</script>' }],
      }),
    ).not.toContain('"><script>');
  });
});
