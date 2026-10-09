import { describe, expect, it } from 'vitest';
import {
  blockTypesLeft,
  currentSettings,
  templatesOf,
  toggled,
  withThemeSetting,
  type EditorFile,
} from './theme-files';

const file = (filename: string): EditorFile => ({ filename, body: '{}', own: false, problems: [] });

describe("A theme's files as the editor changes them", () => {
  it('lists templates in the order merchants look for them, alternates after their own', () => {
    expect(
      templatesOf(
        [
          'templates/404.json',
          'templates/product.unstitched.json',
          'templates/lookbook.json',
          'templates/index.json',
          'templates/product.json',
          'sections/header-group.json',
          'config/settings_data.json',
        ].map(file),
      ),
    ).toEqual(['index', 'product', 'product.unstitched', '404', 'lookbook']);
  });

  it("offers blocks within each kind's limit and the section's own", () => {
    const schema = {
      max_blocks: 3,
      blocks: [{ type: 'heading', limit: 1 }, { type: 'button' }],
    };
    const placement = (types: string[]) => ({
      type: 'image-banner',
      blocks: Object.fromEntries(types.map((type, index) => [`b${index}`, { type }])),
    });
    expect(blockTypesLeft(schema, placement([]))).toEqual(['heading', 'button']);
    expect(blockTypesLeft(schema, placement(['heading']))).toEqual(['button']);
    expect(blockTypesLeft(schema, placement(['heading', 'button', 'button']))).toEqual([]);
    expect(blockTypesLeft(undefined, placement([]))).toEqual([]);
  });

  it("takes a preset's settings as the theme's own once one is changed", () => {
    const data = {
      current: 'Eid',
      presets: { Eid: { color_accent: '#B45309', page_width: 1400 } },
    };
    expect(currentSettings(data)).toEqual({ color_accent: '#B45309', page_width: 1400 });
    expect(withThemeSetting(data, 'page_width', 1200)).toEqual({
      ...data,
      current: { color_accent: '#B45309', page_width: 1200 },
    });
    expect(withThemeSetting(null, 'cart_type', 'page')).toEqual({ current: { cart_type: 'page' } });
  });

  it('hides a section as Shopify does, and shows it again as it was', () => {
    const list = { sections: { a: { type: 'newsletter' } }, order: ['a'] };
    const hidden = toggled(list, 'a');
    expect(hidden.sections.a).toEqual({ type: 'newsletter', disabled: true });
    expect(toggled(hidden, 'a')).toEqual(list);
  });
});
