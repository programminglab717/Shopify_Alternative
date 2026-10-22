import { describe, expect, it } from 'vitest';
import {
  allPlatformThemes,
  isPlatformTheme,
  libraryOf,
  platformTheme,
  platformThemes,
} from './index.js';

describe("Hatti's themes, a library of them, each built on another or not (OS-01, ADR-730)", () => {
  it('lists Hatti Base first, then the themes built on it, each said what it is for', async () => {
    const library = await platformThemes();
    expect(library.map((theme) => [theme.handle, theme.extends])).toEqual([
      ['hatti-base', null],
      ['lawn', 'hatti-base'],
    ]);
    for (const theme of library) {
      expect(theme.description.en.length).toBeGreaterThan(10);
      expect(theme.description.ur).toMatch(/[؀-ۿ]/);
    }
    expect(await isPlatformTheme('lawn')).toBe(true);
    expect(await isPlatformTheme('zevar')).toBe(false);
    expect(await isPlatformTheme('../hatti-base')).toBe(false);
  });

  it("lays a theme's own files over those of the theme it is built on", async () => {
    const [base, lawn] = await Promise.all([platformTheme('hatti-base'), platformTheme('lawn')]);
    // Hatti Base's sections, templates and translations, unchanged.
    expect(lawn.files['sections/main-product.liquid']).toBe(
      base.files['sections/main-product.liquid'],
    );
    expect(lawn.files['templates/product.json']).toBe(base.files['templates/product.json']);
    expect([...lawn.schemas.keys()].sort()).toEqual([...base.schemas.keys()].sort());
    expect(lawn.locales.get('ur')).toEqual(base.locales.get('ur'));
    // Its own look, settings and home page.
    expect(base.files['snippets/theme-style.liquid']).not.toContain('{% style %}');
    expect(lawn.files['snippets/theme-style.liquid']).toContain('aspect-ratio: 3 / 4');
    expect(lawn.settings).toMatchObject({ color_accent: '#9D174D', page_width: 1280 });
    expect(base.settings).toMatchObject({ color_accent: '#0F766E' });
    expect(lawn.files['templates/index.json']).not.toBe(base.files['templates/index.json']);
    expect(lawn.version).not.toBe(base.version);
    expect([...(await allPlatformThemes()).keys()]).toEqual(['hatti-base', 'lawn']);
  });

  it('refuses a library that names a theme twice, a parent listed after, or no description', () => {
    const entry = (handle: string, parent: string | null = null) => ({
      handle,
      name: handle,
      description: { en: 'For any shop', ur: 'ہر دکان کے لیے' },
      extends: parent,
    });
    expect(libraryOf([entry('hatti-base'), entry('lawn', 'hatti-base')])).toHaveLength(2);
    expect(() => libraryOf([entry('a'), entry('a')])).toThrow(/listed twice/);
    expect(() => libraryOf([entry('lawn', 'hatti-base'), entry('hatti-base')])).toThrow(
      /not listed before it/,
    );
    expect(() => libraryOf([{ ...entry('a'), description: { en: 'x' } }])).toThrow(/description/);
    expect(() => libraryOf([entry('Not A Name')])).toThrow(/no theme's name/);
    expect(() => libraryOf({})).toThrow(/not a list/);
  });
});
